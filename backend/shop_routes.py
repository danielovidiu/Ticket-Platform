"""
Webshop: catalogue, cart, checkout, orders, fulfilment.

Deliberately built on the machinery the ticketing side already has rather than beside it:

  * Stripe Checkout Sessions, the signed webhook, and `payment_transactions` are shared —
    a session carries `kind: "shop_order"` in its metadata and server.py routes on that.
  * Invoices go into the same `invoices` collection and draw from the same sequential
    number source. Romanian invoicing wants one unbroken series per issuer, so tickets and
    merchandise must not each keep their own counter.
  * Stock is held at checkout and released if payment never lands, which is exactly what
    ticket waves do. "Decrement on payment" alone lets two people buy the last item.

Money is stored gross (VAT-inclusive), as retail prices are quoted in Romania, and the net
and VAT components are derived at invoice time.
"""
from datetime import datetime, timezone, timedelta
from typing import List, Optional
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

# Stock is held while the buyer is on Stripe's page and released if they never pay. Long
# enough to type card details, short enough that an abandoned cart doesn't sit on the last
# item in a size all afternoon.
HOLD_MINUTES = 20

# Two zones, as configured. Anything outside this list and Romania can't be checked out —
# better an honest refusal than a shipping price nobody costed.
EU_COUNTRIES = {
    "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
    "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "SK", "SI", "ES", "SE",
}

# `vat_rate` is deliberately absent: it is a sitewide figure that tickets use too, so it
# lives in one place (server.get_vat_rate) and is merged in by settings() below. Keeping a
# second copy here is how a shop ends up invoicing at a rate the box office abandoned.
SHOP_SETTINGS_DEFAULT = {
    "shipping_ro_ron": 20.0,
    "shipping_eu_ron": 60.0,
    "free_over_ron": 0.0,      # 0 disables the threshold
    "shop_enabled": True,
}

SIZES = ["XS", "S", "M", "L", "XL", "XXL", "ONE SIZE"]
GENDERS = ["unisex", "men", "women"]
ORDER_STATUSES = ["pending", "paid", "shipped", "delivered", "cancelled", "refunded", "expired"]
# What an admin may set by hand. `paid` is not here: only a confirmed payment moves an
# order into it, and never a click in the dashboard.
ADMIN_SETTABLE_STATUSES = ["shipped", "delivered", "cancelled"]


def register_shop_routes(api: APIRouter, ctx):
    """Attach the webshop to the API router.

    `ctx` carries the shared pieces of server.py (db handle, auth dependencies, id/time
    helpers, Stripe mode, mailer) rather than this module importing server and creating a
    cycle.
    """
    db = ctx.db
    now_utc = ctx.now_utc
    new_id = ctx.new_id
    parse_dt = ctx.parse_dt
    get_current_user = ctx.get_current_user
    require_admin = ctx.require_admin
    rate_limit = ctx.rate_limit
    logger = ctx.logger

    # ---------- helpers ----------

    def now_iso():
        return now_utc().isoformat()

    def slugify(value: str) -> str:
        import re
        s = re.sub(r"[^a-z0-9]+", "-", (value or "").strip().lower())
        return s.strip("-")

    def money(x) -> float:
        """Two decimals, always. Prices are gross RON."""
        return round(float(x or 0), 2)

    async def settings() -> dict:
        doc = await db.shop_settings.find_one({"_id": "shop"}, {"_id": 0}) or {}
        merged = dict(SHOP_SETTINGS_DEFAULT)
        merged.update({k: v for k, v in doc.items() if v is not None and k in SHOP_SETTINGS_DEFAULT})
        # Pulled from the sitewide billing setting, not stored here.
        merged["vat_rate"] = await ctx.get_vat_rate()
        return merged

    def zone_for(country: str) -> Optional[str]:
        c = (country or "").strip().upper()
        if c == "RO":
            return "RO"
        if c in EU_COUNTRIES:
            return "EU"
        return None

    async def shipping_for(zone: str, subtotal: float) -> float:
        s = await settings()
        if s["free_over_ron"] and subtotal >= s["free_over_ron"]:
            return 0.0
        return money(s["shipping_ro_ron"] if zone == "RO" else s["shipping_eu_ron"])

    def public_product(p: dict) -> dict:
        """Catalogue shape. Exposes whether a size is buyable, never the raw count —
        stock levels are commercially sensitive and invite scraping."""
        variants = [
            {"variant_id": v["variant_id"], "size": v.get("size", ""), "sku": v.get("sku", ""),
             "in_stock": int(v.get("stock", 0)) > 0}
            for v in p.get("variants", [])
        ]
        return {
            "product_id": p["product_id"], "slug": p["slug"], "name": p["name"],
            "description": p.get("description", ""), "images": p.get("images", []),
            "price_ron": money(p.get("price_ron")), "category": p.get("category", ""),
            "gender": p.get("gender", "unisex"), "variants": variants,
            "in_stock": any(v["in_stock"] for v in variants),
        }

    def find_variant(product: dict, variant_id: str) -> Optional[dict]:
        return next((v for v in product.get("variants", []) if v["variant_id"] == variant_id), None)

    async def hold_stock(product_id: str, variant_id: str, qty: int) -> bool:
        """Atomically move `qty` out of sellable stock.

        The filter and the decrement are one operation, so two shoppers racing for the last
        item can't both win — the loser's update simply matches nothing.
        """
        res = await db.products.update_one(
            {"product_id": product_id,
             "variants": {"$elemMatch": {"variant_id": variant_id, "stock": {"$gte": qty}}}},
            {"$inc": {"variants.$.stock": -qty}},
        )
        return res.matched_count == 1

    async def release_stock(product_id: str, variant_id: str, qty: int):
        await db.products.update_one(
            {"product_id": product_id, "variants.variant_id": variant_id},
            {"$inc": {"variants.$.stock": qty}},
        )

    async def release_order_stock(order: dict):
        for line in order.get("items", []):
            await release_stock(line["product_id"], line["variant_id"], line["quantity"])

    async def expire_stale_orders():
        """Return stock from checkouts that were never paid.

        Runs opportunistically before reads that care about availability, the same way the
        ticket side sweeps reservations — there is no scheduler on a serverless host.
        """
        cutoff = now_iso()
        stale = await db.shop_orders.find(
            {"status": "pending", "hold_expires_at": {"$lt": cutoff}}, {"_id": 0}
        ).to_list(200)
        for o in stale:
            # Flip first: if releasing throws halfway, a second pass must not double-credit.
            res = await db.shop_orders.update_one(
                {"order_id": o["order_id"], "status": "pending"},
                {"$set": {"status": "expired", "expired_at": cutoff}},
            )
            if res.modified_count:
                await release_order_stock(o)

    # ---------- public catalogue ----------

    @api.get("/shop/settings")
    async def shop_settings_public():
        s = await settings()
        return {"vat_rate": s["vat_rate"], "shipping_ro_ron": s["shipping_ro_ron"],
                "shipping_eu_ron": s["shipping_eu_ron"], "free_over_ron": s["free_over_ron"],
                "shop_enabled": s["shop_enabled"], "eu_countries": sorted(EU_COUNTRIES)}

    @api.get("/shop/products")
    async def list_products(category: Optional[str] = None, gender: Optional[str] = None,
                            size: Optional[str] = None, in_stock: bool = False):
        await expire_stale_orders()
        q = {"is_published": True}
        if category:
            q["category"] = category
        if gender:
            q["gender"] = gender
        if size:
            q["variants.size"] = size
        if in_stock:
            q["variants"] = {"$elemMatch": {"stock": {"$gt": 0}}}
        items = await db.products.find(q, {"_id": 0}).sort([("sort_order", 1), ("created_at", -1)]).to_list(500)
        return [public_product(p) for p in items]

    @api.get("/shop/categories")
    async def list_categories():
        cats = await db.products.distinct("category", {"is_published": True})
        return sorted([c for c in cats if c])

    @api.get("/shop/products/{slug}")
    async def get_product(slug: str):
        await expire_stale_orders()
        p = await db.products.find_one({"slug": slug, "is_published": True}, {"_id": 0})
        if not p:
            raise HTTPException(404, "Not found")
        return public_product(p)

    # ---------- cart ----------

    class CartItemIn(BaseModel):
        product_id: str
        variant_id: str
        quantity: int = 1

    class CartQtyIn(BaseModel):
        quantity: int

    async def get_cart_doc(user_id: str) -> dict:
        cart = await db.carts.find_one({"user_id": user_id}, {"_id": 0})
        if not cart:
            cart = {"cart_id": new_id("cart"), "user_id": user_id, "items": [],
                    "created_at": now_iso(), "updated_at": now_iso()}
            await db.carts.insert_one(dict(cart))
        return cart

    async def cart_view(user_id: str) -> dict:
        """Cart joined against the live catalogue.

        Prices and availability are re-read every time rather than trusted from whatever
        was stored when the item went in — a price change or a sell-out between adding and
        checking out has to be visible, not silently honoured.
        """
        cart = await get_cart_doc(user_id)
        ids = list({i["product_id"] for i in cart["items"]})
        products = {p["product_id"]: p for p in
                    await db.products.find({"product_id": {"$in": ids}}, {"_id": 0}).to_list(200)}

        lines, subtotal = [], 0.0
        for item in cart["items"]:
            p = products.get(item["product_id"])
            v = find_variant(p, item["variant_id"]) if p else None
            if not p or not v:
                continue  # product or size withdrawn since it was added
            available = int(v.get("stock", 0))
            qty = int(item["quantity"])
            line_total = money(p["price_ron"] * qty)
            subtotal += line_total
            lines.append({
                "product_id": p["product_id"], "variant_id": v["variant_id"],
                "slug": p["slug"], "name": p["name"], "size": v.get("size", ""),
                "sku": v.get("sku", ""), "image": (p.get("images") or [None])[0],
                "unit_price_ron": money(p["price_ron"]), "quantity": qty,
                "line_total_ron": line_total,
                "available": available,
                "published": bool(p.get("is_published")),
                # Anything false here blocks checkout and is called out in the UI.
                "purchasable": bool(p.get("is_published")) and available >= qty,
            })
        return {"items": lines, "subtotal_ron": money(subtotal),
                "count": sum(l["quantity"] for l in lines),
                "has_problems": any(not l["purchasable"] for l in lines)}

    @api.get("/shop/cart")
    async def read_cart(user=Depends(get_current_user)):
        await expire_stale_orders()
        return await cart_view(user["user_id"])

    @api.post("/shop/cart/items", dependencies=[Depends(rate_limit("shop_cart", 60, 60))])
    async def add_to_cart(body: CartItemIn, user=Depends(get_current_user)):
        if body.quantity < 1 or body.quantity > 20:
            raise HTTPException(400, "Choose between 1 and 20")
        p = await db.products.find_one({"product_id": body.product_id, "is_published": True}, {"_id": 0})
        if not p or not find_variant(p, body.variant_id):
            raise HTTPException(404, "That item is no longer available")

        cart = await get_cart_doc(user["user_id"])
        items = cart["items"]
        existing = next((i for i in items if i["variant_id"] == body.variant_id), None)
        if existing:
            existing["quantity"] = min(20, existing["quantity"] + body.quantity)
        else:
            items.append({"product_id": body.product_id, "variant_id": body.variant_id,
                          "quantity": body.quantity, "added_at": now_iso()})
        await db.carts.update_one({"user_id": user["user_id"]},
                                  {"$set": {"items": items, "updated_at": now_iso()}})
        return await cart_view(user["user_id"])

    @api.patch("/shop/cart/items/{variant_id}")
    async def set_cart_qty(variant_id: str, body: CartQtyIn, user=Depends(get_current_user)):
        if body.quantity < 0 or body.quantity > 20:
            raise HTTPException(400, "Choose between 0 and 20")
        cart = await get_cart_doc(user["user_id"])
        items = [i for i in cart["items"] if i["variant_id"] != variant_id]
        if body.quantity > 0:
            kept = next((i for i in cart["items"] if i["variant_id"] == variant_id), None)
            if not kept:
                raise HTTPException(404, "Not in your cart")
            kept["quantity"] = body.quantity
            items.append(kept)
        await db.carts.update_one({"user_id": user["user_id"]},
                                  {"$set": {"items": items, "updated_at": now_iso()}})
        return await cart_view(user["user_id"])

    @api.delete("/shop/cart/items/{variant_id}")
    async def remove_cart_item(variant_id: str, user=Depends(get_current_user)):
        cart = await get_cart_doc(user["user_id"])
        items = [i for i in cart["items"] if i["variant_id"] != variant_id]
        await db.carts.update_one({"user_id": user["user_id"]},
                                  {"$set": {"items": items, "updated_at": now_iso()}})
        return await cart_view(user["user_id"])

    @api.delete("/shop/cart")
    async def clear_cart(user=Depends(get_current_user)):
        await db.carts.update_one({"user_id": user["user_id"]},
                                  {"$set": {"items": [], "updated_at": now_iso()}})
        return await cart_view(user["user_id"])

    # ---------- checkout ----------

    class AddressIn(BaseModel):
        full_name: str
        phone: str = ""
        line1: str
        line2: str = ""
        city: str
        county: str = ""
        postal_code: str
        country: str  # ISO-3166 alpha-2

    # Two limits, because one IP is not one shopper: mobile carriers put thousands of
    # customers behind a single CGNAT address, and an office shares one too. The IP
    # ceiling is loose enough not to punish them and only exists to stop flooding; the
    # meaningful limit is per account, which is what a runaway client actually is.
    @api.post("/shop/checkout", dependencies=[Depends(rate_limit("shop_checkout_ip", 60, 60))])
    async def shop_checkout(body: AddressIn, user=Depends(get_current_user)):
        """Turn the cart into a held, unpaid order plus a Stripe session.

        Everything that decides the price is recomputed here from the database. Nothing
        about the amount comes from the client — it sends an address, and that is all.
        """
        ctx.rate_check_key("shop_checkout_user", user["user_id"], 10, 60)
        s = await settings()
        if not s["shop_enabled"]:
            raise HTTPException(503, "The shop is currently closed")

        # Same gates as ticket checkout: a real, verified, identifiable buyer.
        if not user.get("email_verified_at"):
            raise HTTPException(403, {"reason": "email_not_verified", "email": user.get("email", "")})
        if not ctx.profile_complete(user):
            raise HTTPException(403, {"reason": "profile_incomplete"})

        zone = zone_for(body.country)
        if not zone:
            raise HTTPException(400, "We currently ship to Romania and the EU only")

        await expire_stale_orders()
        view = await cart_view(user["user_id"])
        if not view["items"]:
            raise HTTPException(400, "Your cart is empty")
        if view["has_problems"]:
            raise HTTPException(409, {"reason": "cart_changed",
                                      "detail": "Some items sold out or changed — review your cart"})

        # Hold every line before creating the order. A partial hold is worse than none, so
        # anything already taken goes back if a later line can't be satisfied.
        held = []
        for line in view["items"]:
            if await hold_stock(line["product_id"], line["variant_id"], line["quantity"]):
                held.append(line)
                continue
            for h in held:
                await release_stock(h["product_id"], h["variant_id"], h["quantity"])
            raise HTTPException(409, {"reason": "out_of_stock",
                                      "detail": f"{line['name']} ({line['size']}) just sold out"})

        subtotal = money(view["subtotal_ron"])
        shipping = await shipping_for(zone, subtotal)
        total = money(subtotal + shipping)
        vat_rate = float(s["vat_rate"])
        net = money(total / (1 + vat_rate))
        vat_amount = money(total - net)

        order = {
            "order_id": new_id("ord"),
            "user_id": user["user_id"],
            "email": user.get("email", ""),
            "status": "pending",
            "items": [{k: line[k] for k in
                       ("product_id", "variant_id", "slug", "name", "size", "sku",
                        "unit_price_ron", "quantity", "line_total_ron")} for line in view["items"]],
            "subtotal_ron": subtotal,
            "shipping_ron": shipping,
            "total_ron": total,
            "vat_rate": vat_rate,
            "net_ron": net,
            "vat_amount_ron": vat_amount,
            "shipping_zone": zone,
            "shipping_address": body.model_dump(),
            "hold_expires_at": (now_utc() + timedelta(minutes=HOLD_MINUTES)).isoformat(),
            "created_at": now_iso(),
            "paid_at": None, "shipped_at": None, "delivered_at": None,
            "tracking_number": "", "carrier": "", "invoice_id": None,
        }
        await db.shop_orders.insert_one(dict(order))

        try:
            session_id, url = await ctx.create_stripe_session(
                user=user,
                total_ron=total,
                metadata={"kind": "shop_order", "order_id": order["order_id"], "user_id": user["user_id"]},
                # One line per product plus shipping, so the Stripe receipt and the
                # invoice show the buyer the same breakdown.
                line_items=[
                    {"name": f"{l['name']} · {l['size']}" if l["size"] else l["name"],
                     "amount_ron": l["unit_price_ron"], "quantity": l["quantity"]}
                    for l in view["items"]
                ] + ([{"name": f"Shipping ({zone})", "amount_ron": shipping, "quantity": 1}]
                     if shipping > 0 else []),
                success_path=f"/shop/success?session_id={{CHECKOUT_SESSION_ID}}",
                cancel_path=f"/cart?cancelled={order['order_id']}",
            )
        except Exception:
            # No session means no way to pay; don't sit on the stock.
            logger.exception("shop: creating the Stripe session failed for %s", order["order_id"])
            await db.shop_orders.update_one({"order_id": order["order_id"]},
                                            {"$set": {"status": "cancelled"}})
            await release_order_stock(order)
            raise HTTPException(502, "Could not start the payment. Nothing has been charged.")

        await db.shop_orders.update_one({"order_id": order["order_id"]},
                                        {"$set": {"stripe_session_id": session_id}})
        await db.payment_transactions.insert_one({
            "session_id": session_id, "order_id": order["order_id"], "kind": "shop_order",
            "user_id": user["user_id"], "amount": total, "currency": "ron",
            "payment_status": "initiated", "created_at": now_iso(),
        })
        return {"url": url, "session_id": session_id, "order_id": order["order_id"]}

    async def finalize_paid_order(order_id: str):
        """Idempotent: called from the webhook and, in fake-payment mode, the status poll.

        Stock was already taken at checkout, so this does not decrement again — paying
        converts a hold into a sale. Re-running only ever finds the order already paid.
        """
        o = await db.shop_orders.find_one({"order_id": order_id}, {"_id": 0})
        if not o or o["status"] != "pending":
            return
        res = await db.shop_orders.update_one(
            {"order_id": order_id, "status": "pending"},
            {"$set": {"status": "paid", "paid_at": now_iso()}},
        )
        if not res.modified_count:
            return  # another worker got there first

        invoice = await ctx.issue_invoice(
            user_id=o["user_id"],
            total=o["total_ron"], net=o["net_ron"], vat_amount=o["vat_amount_ron"],
            vat_rate=o["vat_rate"],
            lines=[{"description": f"{l['name']}{(' · ' + l['size']) if l['size'] else ''}",
                    "quantity": l["quantity"], "total": l["line_total_ron"]}
                   for l in o["items"]]
                  + ([{"description": f"Shipping ({o['shipping_zone']})", "quantity": 1,
                       "total": o["shipping_ron"]}] if o["shipping_ron"] else []),
            meta={"order_id": order_id, "kind": "shop_order"},
        )
        await db.shop_orders.update_one({"order_id": order_id},
                                        {"$set": {"invoice_id": invoice["invoice_id"]}})
        # The cart has served its purpose; leaving it full invites a duplicate order.
        await db.carts.update_one({"user_id": o["user_id"]},
                                  {"$set": {"items": [], "updated_at": now_iso()}})
        await ctx.send_mail("shop_order_paid", o["email"], {
            "order": {**o, "invoice_no": invoice["number"]},
            "orders_url": f"{ctx.public_app_url}/my-orders",
        })
        logger.info("shop: order %s paid, invoice %s", order_id, invoice["number"])

    # ---------- customer orders ----------

    @api.get("/shop/orders")
    async def my_orders(user=Depends(get_current_user)):
        await expire_stale_orders()
        return await db.shop_orders.find(
            {"user_id": user["user_id"], "status": {"$ne": "expired"}}, {"_id": 0}
        ).sort("created_at", -1).to_list(200)

    @api.get("/shop/orders/{order_id}")
    async def my_order(order_id: str, user=Depends(get_current_user)):
        o = await db.shop_orders.find_one({"order_id": order_id}, {"_id": 0})
        if not o or (o["user_id"] != user["user_id"] and user.get("role") != "admin"):
            raise HTTPException(404, "Not found")
        return o

    # ---------- admin: catalogue ----------

    class VariantIn(BaseModel):
        variant_id: Optional[str] = None
        size: str
        sku: str
        stock: int = 0

    class ProductIn(BaseModel):
        name: str
        slug: str = ""
        description: str = ""
        images: List[str] = []
        price_ron: float
        category: str = ""
        gender: str = "unisex"
        is_published: bool = False
        sort_order: int = 100
        variants: List[VariantIn] = []

    def clean_variants(rows: List[VariantIn], existing: Optional[dict] = None) -> List[dict]:
        """Keep variant_ids stable across edits — carts and unpaid orders point at them."""
        out, seen_sku = [], set()
        for v in rows:
            sku = (v.sku or "").strip().upper()
            if not sku:
                raise HTTPException(400, f"Every size needs a SKU (missing on '{v.size}')")
            if sku in seen_sku:
                raise HTTPException(400, f"Duplicate SKU in this product: {sku}")
            seen_sku.add(sku)
            if v.stock < 0:
                raise HTTPException(400, "Stock cannot be negative")
            out.append({"variant_id": v.variant_id or new_id("var"),
                        "size": (v.size or "").strip().upper(), "sku": sku, "stock": int(v.stock)})
        if not out:
            raise HTTPException(400, "Add at least one size")
        return out

    @api.get("/admin/shop/products")
    async def admin_list_products(user=Depends(require_admin)):
        return await db.products.find({}, {"_id": 0}).sort([("sort_order", 1), ("created_at", -1)]).to_list(500)

    @api.post("/admin/shop/products")
    async def admin_create_product(body: ProductIn, user=Depends(require_admin)):
        slug = slugify(body.slug or body.name)
        if not slug:
            raise HTTPException(400, "The product needs a name")
        if await db.products.find_one({"slug": slug}, {"_id": 1}):
            raise HTTPException(400, f"A product already uses the slug '{slug}'")
        if body.price_ron <= 0:
            raise HTTPException(400, "Price must be above zero")
        doc = body.model_dump()
        doc.update({
            "product_id": new_id("prd"), "slug": slug, "price_ron": money(body.price_ron),
            "variants": clean_variants(body.variants), "created_at": now_iso(),
        })
        await db.products.insert_one(dict(doc))
        await ctx.audit(user["user_id"], "product_created", "product", doc["product_id"], {"slug": slug})
        return {k: v for k, v in doc.items() if k != "_id"}

    @api.patch("/admin/shop/products/{product_id}")
    async def admin_update_product(product_id: str, body: dict, user=Depends(require_admin)):
        p = await db.products.find_one({"product_id": product_id}, {"_id": 0})
        if not p:
            raise HTTPException(404, "Not found")
        allowed = {"name", "description", "images", "price_ron", "category", "gender",
                   "is_published", "sort_order", "slug", "variants"}
        upd = {k: v for k, v in body.items() if k in allowed}
        if "slug" in upd:
            upd["slug"] = slugify(upd["slug"])
            clash = await db.products.find_one({"slug": upd["slug"], "product_id": {"$ne": product_id}}, {"_id": 1})
            if clash:
                raise HTTPException(400, f"A product already uses the slug '{upd['slug']}'")
        if "price_ron" in upd:
            if float(upd["price_ron"]) <= 0:
                raise HTTPException(400, "Price must be above zero")
            upd["price_ron"] = money(upd["price_ron"])
        if "variants" in upd:
            upd["variants"] = clean_variants([VariantIn(**v) for v in upd["variants"]], p)
        if upd:
            await db.products.update_one({"product_id": product_id}, {"$set": upd})
            await ctx.audit(user["user_id"], "product_updated", "product", product_id, {"fields": list(upd)})
        return await db.products.find_one({"product_id": product_id}, {"_id": 0})

    @api.delete("/admin/shop/products/{product_id}")
    async def admin_delete_product(product_id: str, user=Depends(require_admin)):
        """Unpublish rather than delete when the product has history — an order line has
        to keep resolving for invoices and returns."""
        sold = await db.shop_orders.count_documents({"items.product_id": product_id})
        if sold:
            await db.products.update_one({"product_id": product_id}, {"$set": {"is_published": False}})
            return {"ok": True, "unpublished": True,
                    "reason": f"{sold} order(s) reference this product, so it was hidden instead of deleted"}
        await db.products.delete_one({"product_id": product_id})
        await ctx.audit(user["user_id"], "product_deleted", "product", product_id, None)
        return {"ok": True, "deleted": True}

    # ---------- admin: orders + fulfilment ----------

    @api.get("/admin/shop/orders")
    async def admin_orders(status: Optional[str] = None, user=Depends(require_admin)):
        await expire_stale_orders()
        q = {} if not status else {"status": status}
        return await db.shop_orders.find(q, {"_id": 0}).sort("created_at", -1).to_list(500)

    class OrderStatusIn(BaseModel):
        status: str
        tracking_number: Optional[str] = None
        carrier: Optional[str] = None

    @api.patch("/admin/shop/orders/{order_id}")
    async def admin_update_order(order_id: str, body: OrderStatusIn, user=Depends(require_admin)):
        o = await db.shop_orders.find_one({"order_id": order_id}, {"_id": 0})
        if not o:
            raise HTTPException(404, "Not found")
        if body.status not in ADMIN_SETTABLE_STATUSES:
            raise HTTPException(400, f"Status must be one of {', '.join(ADMIN_SETTABLE_STATUSES)}")
        # Fulfilment only moves forward, and only from a paid order — marking an unpaid
        # order shipped would send goods against a payment that never arrived.
        flow = {"paid": {"shipped", "cancelled"}, "shipped": {"delivered"}, "delivered": set()}
        if body.status not in flow.get(o["status"], set()):
            raise HTTPException(400, f"An order that is {o['status']} cannot become {body.status}")

        upd = {"status": body.status}
        if body.tracking_number is not None:
            upd["tracking_number"] = body.tracking_number.strip()
        if body.carrier is not None:
            upd["carrier"] = body.carrier.strip()
        upd[f"{body.status}_at"] = now_iso()

        # Conditional on the status this request *read*, so two requests racing the same
        # transition cannot both win. It used to be an unconditional `$set` after a
        # separate read, which made every side effect below repeatable: six concurrent
        # cancels each returned 200 and each credited the stock, taking a variant from 5
        # to 17 where 7 was right, and two concurrent "shipped" would have mailed the
        # buyer twice. `expire_stale_orders` above already flips before releasing for
        # exactly this reason; this path had been missed.
        res = await db.shop_orders.update_one(
            {"order_id": order_id, "status": o["status"]}, {"$set": upd})
        if not res.modified_count:
            raise HTTPException(409, "The order changed while this request was in flight")

        # After the flip, never before: a release that lands and then fails to record
        # itself is stock credited against an order still marked paid.
        if body.status == "cancelled":
            await release_order_stock(o)  # goods never left; put them back on sale

        await ctx.audit(user["user_id"], f"order_{body.status}", "shop_order", order_id, upd)

        if body.status == "shipped":
            await ctx.send_mail("shop_order_shipped", o["email"], {
                "order": {**o, **upd}, "orders_url": f"{ctx.public_app_url}/my-orders",
            })
        return await db.shop_orders.find_one({"order_id": order_id}, {"_id": 0})

    # ---------- admin: settings ----------

    class ShopSettingsIn(BaseModel):
        shipping_ro_ron: Optional[float] = None
        shipping_eu_ron: Optional[float] = None
        free_over_ron: Optional[float] = None
        vat_rate: Optional[float] = None
        shop_enabled: Optional[bool] = None

    @api.get("/admin/shop/settings")
    async def admin_get_settings(user=Depends(require_admin)):
        return await settings()

    @api.patch("/admin/shop/settings")
    async def admin_set_settings(body: ShopSettingsIn, user=Depends(require_admin)):
        upd = {k: v for k, v in body.model_dump().items() if v is not None}

        # VAT is sitewide, so it is written through to the billing setting the ticket
        # invoices read rather than into the shop's own document.
        vat = upd.pop("vat_rate", None)
        if vat is not None:
            await ctx.set_vat_rate(float(vat))
            await ctx.audit(user["user_id"], "vat_rate_updated", "billing", "settings", {"vat_rate": vat})

        for key in ("shipping_ro_ron", "shipping_eu_ron", "free_over_ron"):
            if key in upd:
                if upd[key] < 0:
                    raise HTTPException(400, "Shipping cannot be negative")
                upd[key] = money(upd[key])
        if upd:
            await db.shop_settings.update_one({"_id": "shop"}, {"$set": upd}, upsert=True)
            await ctx.audit(user["user_id"], "shop_settings_updated", "shop", "settings", upd)
        return await settings()

    # ---------- seed ----------

    @api.post("/admin/shop/seed")
    async def seed_shop(user=Depends(require_admin)):
        """Fill an empty catalogue with a realistic ~50-product range.

        Admin-only and a no-op once anything exists, matching /api/seed. Apparel gets real
        size runs so the variant model is exercised; print and music are one-size.
        """
        if await db.products.count_documents({}) > 0:
            return {"seeded": False, "reason": "the catalogue already has products"}

        apparel_sizes = ["S", "M", "L", "XL"]
        img = ("https://images.unsplash.com/photo-{}?crop=entropy&cs=srgb&fm=jpg&q=85&w=1200")
        photos = ["1521572163474-6864f9cf17ab", "1503341504253-dff4815485f1",
                  "1620799140408-edc6dcb6d633", "1523381210434-271e8be1f52b",
                  "1556821840-3a63f95609a7", "1618354691373-d851c5c3a990"]

        lines = [
            ("TEE", "Heavyweight cotton tee, screen printed in Bucharest.", "apparel", 149.0, apparel_sizes),
            ("HOODIE", "Heavy fleece hoodie, embroidered mark.", "apparel", 349.0, apparel_sizes),
            ("LONGSLEEVE", "Long-sleeve jersey with sleeve print.", "apparel", 199.0, apparel_sizes),
            ("CAP", "Six-panel cap, adjustable strap.", "accessories", 129.0, ["ONE SIZE"]),
            ("TOTE", "Heavy canvas tote, screen printed.", "accessories", 89.0, ["ONE SIZE"]),
            ("POSTER", "A2 riso print, numbered edition.", "print", 79.0, ["ONE SIZE"]),
            ("VINYL", "12-inch, 180g, gatefold sleeve.", "music", 179.0, ["ONE SIZE"]),
        ]
        drops = ["OBSIDIAN", "CORPUS", "MIDNIGHT", "VOID", "LUMEN", "NOKTURN", "ARCHIVE", "RESIDENCY"]

        docs, n = [], 0
        for drop_i, drop in enumerate(drops):
            for line_i, (line, desc, category, price, sizes) in enumerate(lines):
                if n >= 50:
                    break
                name = f"{drop} {line}"
                gender = GENDERS[(drop_i + line_i) % len(GENDERS)] if category == "apparel" else "unisex"
                docs.append({
                    "product_id": new_id("prd"),
                    "slug": slugify(name),
                    "name": name,
                    "description": f"{desc} Part of the {drop.title()} drop.",
                    "images": [img.format(photos[(drop_i + line_i) % len(photos)])],
                    "price_ron": money(price + (drop_i * 10)),
                    "category": category,
                    "gender": gender,
                    "is_published": True,
                    "sort_order": n,
                    "variants": [
                        {"variant_id": new_id("var"), "size": s,
                         "sku": f"{line[:3]}-{drop[:3]}-{s}".upper(),
                         # A couple of deliberate zeroes so the sold-out path is visible
                         # in a fresh install without having to sell anything first.
                         "stock": 0 if (n + i) % 17 == 0 else 12 + ((n + i) % 9)}
                        for i, s in enumerate(sizes)
                    ],
                    "created_at": now_iso(),
                })
                n += 1

        await db.products.insert_many(docs)
        await ctx.audit(user["user_id"], "shop_seeded", "shop", "catalogue", {"products": len(docs)})
        return {"seeded": True, "products": len(docs),
                "variants": sum(len(d["variants"]) for d in docs)}

    # server.py needs these two to route the shared webhook and the startup sweep.
    return {"finalize_paid_order": finalize_paid_order, "expire_stale_orders": expire_stale_orders}
