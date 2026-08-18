"""
Webshop: catalogue, cart, stock holds, checkout, fulfilment, VAT and invoicing.

The parts worth guarding are the ones where money and stock meet:

  * a hold is taken when the Stripe session is created, not when payment lands, so two
    buyers cannot both get the last item;
  * an abandoned checkout gives the stock back;
  * paying converts the hold rather than decrementing a second time;
  * totals, VAT and shipping are recomputed server-side from the catalogue, so a client
    that lies about prices changes nothing;
  * fulfilment only moves forward, and only from a paid order.
"""
import uuid

import pytest
import requests

from support import API, db, mint_user, patient, TIMEOUT

# Runs on one worker, in order: the module's own xdist group. This is what
# `--dist loadgroup` needs in order to behave like the `loadscope` it replaced —
# see pytest.ini.
pytestmark = pytest.mark.xdist_group("test_shop")

RO_ADDRESS = {"full_name": "Ana Popescu", "phone": "+40721234567", "line1": "Str. Lipscani 12",
              "city": "Bucuresti", "county": "Bucuresti", "postal_code": "030033", "country": "RO"}


def _cleanup(product_ids=(), user_ids=()):
    if product_ids:
        db.products.delete_many({"product_id": {"$in": list(product_ids)}})
    if user_ids:
        db.shop_orders.delete_many({"user_id": {"$in": list(user_ids)}})
        db.carts.delete_many({"user_id": {"$in": list(user_ids)}})


@pytest.fixture()
def product():
    """A published product with a known stock level, removed afterwards."""
    pid, vid = f"prd_test_{uuid.uuid4().hex[:10]}", f"var_test_{uuid.uuid4().hex[:10]}"
    doc = {
        "product_id": pid, "slug": f"test-item-{uuid.uuid4().hex[:8]}", "name": "TEST_Item",
        "description": "fixture", "images": [], "price_ron": 100.0, "category": "apparel",
        "gender": "unisex", "is_published": True, "sort_order": 1,
        "variants": [{"variant_id": vid, "size": "M", "sku": f"TST-{uuid.uuid4().hex[:6].upper()}", "stock": 3}],
        "created_at": "2026-01-01T00:00:00+00:00",
    }
    db.products.insert_one(dict(doc))
    yield doc
    _cleanup(product_ids=[pid])


@pytest.fixture()
def buyer():
    headers, user_id, email = mint_user("user")
    yield headers, user_id, email
    _cleanup(user_ids=[user_id])


def stock_of(product_id, variant_id):
    p = db.products.find_one({"product_id": product_id}, {"_id": 0, "variants": 1})
    return next(v["stock"] for v in p["variants"] if v["variant_id"] == variant_id)


def add_to_cart(headers, product, qty=1):
    return requests.post(f"{API}/shop/cart/items", headers=headers, timeout=TIMEOUT, json={
        "product_id": product["product_id"],
        "variant_id": product["variants"][0]["variant_id"],
        "quantity": qty,
    })


def checkout(headers, **address):
    # `patient` waits out a 429: this module makes far more checkout calls in a minute
    # than any real shopper would, and the per-account limit is deliberately tight.
    return patient.post(f"{API}/shop/checkout", headers=headers, json={**RO_ADDRESS, **address})


def pay(session_id):
    """Drive the same webhook Stripe would, through the dev shim."""
    return requests.post(f"{API}/webhook/stripe", timeout=TIMEOUT,
                         json={"session_id": session_id, "payment_status": "paid"})


class TestCatalogue:
    def test_public_listing_hides_stock_counts(self, product):
        r = requests.get(f"{API}/shop/products/{product['slug']}", timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        v = r.json()["variants"][0]
        # Availability yes, quantities no — stock levels are commercially sensitive.
        assert v["in_stock"] is True
        assert "stock" not in v

    def test_unpublished_products_are_not_served(self, product):
        db.products.update_one({"product_id": product["product_id"]}, {"$set": {"is_published": False}})
        assert requests.get(f"{API}/shop/products/{product['slug']}", timeout=TIMEOUT).status_code == 404

    def test_settings_expose_what_checkout_needs(self):
        r = requests.get(f"{API}/shop/settings", timeout=TIMEOUT)
        assert r.status_code == 200
        for key in ("vat_rate", "shipping_ro_ron", "shipping_eu_ron", "shop_enabled"):
            assert key in r.json()


class TestCart:
    def test_cart_requires_an_account(self):
        assert requests.get(f"{API}/shop/cart", timeout=TIMEOUT).status_code == 401

    def test_cart_is_repriced_from_the_catalogue(self, product, buyer):
        headers, _uid, _email = buyer
        add_to_cart(headers, product, 2)
        # A price change has to reach an already-filled cart, not be honoured at the
        # price captured when the item went in.
        db.products.update_one({"product_id": product["product_id"]}, {"$set": {"price_ron": 250.0}})
        r = requests.get(f"{API}/shop/cart", headers=headers, timeout=TIMEOUT)
        assert r.json()["subtotal_ron"] == 500.0

    def test_a_sold_out_line_blocks_checkout(self, product, buyer):
        headers, _uid, _email = buyer
        add_to_cart(headers, product, 1)
        db.products.update_one(
            {"product_id": product["product_id"], "variants.variant_id": product["variants"][0]["variant_id"]},
            {"$set": {"variants.$.stock": 0}})
        cart = requests.get(f"{API}/shop/cart", headers=headers, timeout=TIMEOUT).json()
        assert cart["has_problems"] is True
        assert cart["items"][0]["purchasable"] is False
        assert checkout(headers).status_code == 409


class TestStockHolds:
    def test_checkout_holds_stock_before_payment(self, product, buyer):
        headers, _uid, _email = buyer
        pid, vid = product["product_id"], product["variants"][0]["variant_id"]
        add_to_cart(headers, product, 2)
        assert stock_of(pid, vid) == 3

        r = checkout(headers)
        assert r.status_code == 200, r.text
        # Held now, while the buyer is still on Stripe's page.
        assert stock_of(pid, vid) == 1

    def test_paying_does_not_decrement_a_second_time(self, product, buyer):
        headers, _uid, _email = buyer
        pid, vid = product["product_id"], product["variants"][0]["variant_id"]
        add_to_cart(headers, product, 2)
        session = checkout(headers).json()["session_id"]
        assert stock_of(pid, vid) == 1

        pay(session)
        assert stock_of(pid, vid) == 1, "payment decremented stock that was already held"

    def test_the_last_item_cannot_be_sold_twice(self, product, buyer):
        """The whole reason holds exist."""
        pid, vid = product["product_id"], product["variants"][0]["variant_id"]
        db.products.update_one({"product_id": pid, "variants.variant_id": vid},
                               {"$set": {"variants.$.stock": 1}})
        first, _u1, _e1 = buyer
        second, uid2, _e2 = mint_user("user")
        try:
            add_to_cart(first, product, 1)
            add_to_cart(second, product, 1)
            assert checkout(first).status_code == 200
            r = checkout(second)
            assert r.status_code == 409, r.text
            # Two refusals guard this, and which one fires depends on timing. Normally
            # the cart re-read already sees the stock gone ("cart_changed"), which is the
            # more useful message. "out_of_stock" is the narrower race where the item
            # disappears between that read and the hold itself. Either is correct; what
            # matters is that the second buyer is refused and the stock isn't oversold.
            assert r.json()["detail"]["reason"] in ("cart_changed", "out_of_stock")
            assert stock_of(pid, vid) == 0
        finally:
            _cleanup(user_ids=[uid2])

    def test_an_abandoned_checkout_returns_the_stock(self, product, buyer):
        headers, _uid, _email = buyer
        pid, vid = product["product_id"], product["variants"][0]["variant_id"]
        add_to_cart(headers, product, 2)
        order_id = checkout(headers).json()["order_id"]
        assert stock_of(pid, vid) == 1

        # Age the hold past its expiry; the sweep runs on the next read that cares.
        db.shop_orders.update_one({"order_id": order_id},
                                  {"$set": {"hold_expires_at": "2020-01-01T00:00:00+00:00"}})
        requests.get(f"{API}/shop/products", timeout=TIMEOUT)

        assert stock_of(pid, vid) == 3, "expired hold did not release its stock"
        assert db.shop_orders.find_one({"order_id": order_id})["status"] == "expired"


def live_vat_rate():
    """Read the configured rate rather than hardcoding one — it is an editable setting,
    and a test that pins it would fail the day the law changes rather than the day the
    code breaks."""
    return requests.get(f"{API}/shop/settings", timeout=TIMEOUT).json()["vat_rate"]


class TestPricingAndVat:
    def test_totals_are_computed_server_side(self, product, buyer):
        headers, _uid, _email = buyer
        add_to_cart(headers, product, 2)
        order_id = checkout(headers).json()["order_id"]
        o = db.shop_orders.find_one({"order_id": order_id}, {"_id": 0})
        # Check the split against the rate stored ON THE ORDER, not the live setting:
        # the rate is editable global state and another test may change it in between.
        rate = o["vat_rate"]

        assert o["subtotal_ron"] == 200.0
        assert o["shipping_ron"] == 20.0        # Romania
        assert o["total_ron"] == 220.0
        # Prices are gross: VAT is carved out of the total, never added on top.
        assert o["net_ron"] == pytest.approx(220.0 / (1 + rate), abs=0.01)
        assert o["vat_amount_ron"] == pytest.approx(220.0 - 220.0 / (1 + rate), abs=0.01)
        assert o["net_ron"] + o["vat_amount_ron"] == pytest.approx(o["total_ron"], abs=0.02)

    def test_a_fresh_install_bills_at_the_romanian_standard(self):
        """21% since August 2025. Asserted against the code default rather than the live
        setting — the live one is meant to be edited, so pinning it would be testing the
        database's current state instead of the shipped behaviour."""
        import server
        assert server.VAT_RATE_DEFAULT == pytest.approx(0.21)


class TestVatIsOneEditableSetting:
    """A statutory rate change should be one edit, applying everywhere, without touching
    invoices that were already raised."""

    @pytest.fixture()
    def restore_rate(self, admin_headers):
        before = live_vat_rate()
        yield
        requests.patch(f"{API}/admin/shop/settings", headers=admin_headers,
                       json={"vat_rate": before}, timeout=TIMEOUT)

    def test_changing_it_affects_new_orders_only(self, product, buyer, admin_headers, restore_rate):
        headers, _uid, _email = buyer

        add_to_cart(headers, product, 1)
        first = checkout(headers).json()
        pay(first["session_id"])
        old_invoice = db.invoices.find_one({"order_id": first["order_id"]}, {"_id": 0})
        old_rate = old_invoice["vat_rate"]

        r = requests.patch(f"{API}/admin/shop/settings", headers=admin_headers,
                           json={"vat_rate": 0.05}, timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        assert r.json()["vat_rate"] == pytest.approx(0.05)

        add_to_cart(headers, product, 1)
        second = checkout(headers).json()
        assert db.shop_orders.find_one({"order_id": second["order_id"]})["vat_rate"] == pytest.approx(0.05)

        # The invoice raised before the change is untouched — history is not rewritten.
        assert db.invoices.find_one({"invoice_id": old_invoice["invoice_id"]})["vat_rate"] == old_rate

    def test_the_same_rate_reaches_ticket_invoices(self, admin_headers, restore_rate):
        """One field, not one per product line: the box office must not keep invoicing at
        a rate the shop has moved off."""
        requests.patch(f"{API}/admin/shop/settings", headers=admin_headers,
                       json={"vat_rate": 0.07}, timeout=TIMEOUT)
        import server
        import asyncio
        assert asyncio.run(server.get_vat_rate()) == pytest.approx(0.07)

    def test_an_absurd_rate_is_refused(self, admin_headers, restore_rate):
        for bad in (1.5, -0.1):
            r = requests.patch(f"{API}/admin/shop/settings", headers=admin_headers,
                               json={"vat_rate": bad}, timeout=TIMEOUT)
            assert r.status_code == 400, f"{bad} was accepted"

    def test_eu_orders_pay_the_eu_rate(self, product, buyer):
        headers, _uid, _email = buyer
        add_to_cart(headers, product, 1)
        order_id = checkout(headers, country="DE", postal_code="10115", city="Berlin").json()["order_id"]
        o = db.shop_orders.find_one({"order_id": order_id}, {"_id": 0})
        assert o["shipping_zone"] == "EU"
        assert o["shipping_ron"] == 60.0

    def test_outside_the_eu_is_refused(self, product, buyer):
        headers, _uid, _email = buyer
        add_to_cart(headers, product, 1)
        r = checkout(headers, country="US", postal_code="10001", city="New York")
        assert r.status_code == 400, r.text


class TestPaymentAndInvoice:
    def test_paying_produces_an_order_an_invoice_and_an_empty_cart(self, product, buyer):
        headers, uid, _email = buyer
        add_to_cart(headers, product, 1)
        res = checkout(headers).json()
        pay(res["session_id"])

        o = db.shop_orders.find_one({"order_id": res["order_id"]}, {"_id": 0})
        assert o["status"] == "paid"
        assert o["paid_at"]
        assert o["invoice_id"], "no invoice was issued"

        inv = db.invoices.find_one({"invoice_id": o["invoice_id"]}, {"_id": 0})
        assert inv["total"] == o["total_ron"]
        # Line-item invoice: one row per product plus the shipping line.
        assert len(inv["lines"]) == len(o["items"]) + 1

        assert requests.get(f"{API}/shop/cart", headers=headers, timeout=TIMEOUT).json()["count"] == 0

    def test_the_webhook_is_idempotent(self, product, buyer):
        """Stripe retries. A replay must not issue a second invoice."""
        headers, _uid, _email = buyer
        add_to_cart(headers, product, 1)
        res = checkout(headers).json()
        pay(res["session_id"])
        pay(res["session_id"])
        assert db.invoices.count_documents({"order_id": res["order_id"]}) == 1

    def test_invoice_numbers_are_unique_across_tickets_and_shop(self):
        """Fiscal numbering is one unbroken series per issuer, so both flows draw from
        the same counter and no number may repeat."""
        numbers = [i["number"] for i in db.invoices.find({}, {"_id": 0, "number": 1})]
        assert len(numbers) == len(set(numbers)), "duplicate invoice numbers issued"

    def test_the_invoice_pdf_renders(self, product, buyer):
        headers, _uid, _email = buyer
        add_to_cart(headers, product, 1)
        res = checkout(headers).json()
        pay(res["session_id"])
        inv_id = db.shop_orders.find_one({"order_id": res["order_id"]})["invoice_id"]
        r = requests.get(f"{API}/invoices/{inv_id}/pdf", headers=headers, timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        assert r.content[:5] == b"%PDF-"


class TestCheckoutGates:
    def test_an_account_is_required(self, product):
        r = requests.post(f"{API}/shop/checkout", json=RO_ADDRESS, timeout=TIMEOUT)
        assert r.status_code == 401

    def test_an_unverified_account_cannot_check_out(self, product, buyer):
        headers, uid, _email = buyer
        add_to_cart(headers, product, 1)
        db.users.update_one({"user_id": uid}, {"$set": {"email_verified_at": None}})
        r = checkout(headers)
        assert r.status_code == 403
        assert r.json()["detail"]["reason"] == "email_not_verified"

    def test_an_empty_cart_cannot_check_out(self, buyer):
        headers, _uid, _email = buyer
        assert checkout(headers).status_code == 400


class TestFulfilment:
    @pytest.fixture()
    def paid_order(self, product, buyer):
        headers, _uid, _email = buyer
        add_to_cart(headers, product, 1)
        res = checkout(headers).json()
        pay(res["session_id"])
        return res["order_id"], headers

    def test_paid_to_shipped_to_delivered(self, paid_order, admin_headers):
        order_id, _h = paid_order
        r = requests.patch(f"{API}/admin/shop/orders/{order_id}", headers=admin_headers, timeout=TIMEOUT,
                           json={"status": "shipped", "carrier": "Sameday", "tracking_number": "RO999"})
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "shipped"
        assert r.json()["tracking_number"] == "RO999"

        r2 = requests.patch(f"{API}/admin/shop/orders/{order_id}", headers=admin_headers,
                            json={"status": "delivered"}, timeout=TIMEOUT)
        assert r2.json()["status"] == "delivered"

    def test_fulfilment_cannot_run_backwards(self, paid_order, admin_headers):
        order_id, _h = paid_order
        requests.patch(f"{API}/admin/shop/orders/{order_id}", headers=admin_headers,
                       json={"status": "shipped"}, timeout=TIMEOUT)
        r = requests.patch(f"{API}/admin/shop/orders/{order_id}", headers=admin_headers,
                           json={"status": "cancelled"}, timeout=TIMEOUT)
        assert r.status_code == 400, "a shipped order was allowed to be cancelled"

    def test_paid_is_not_an_admin_settable_status(self, paid_order, admin_headers):
        """Only a confirmed payment marks an order paid — never a click."""
        order_id, _h = paid_order
        r = requests.patch(f"{API}/admin/shop/orders/{order_id}", headers=admin_headers,
                           json={"status": "paid"}, timeout=TIMEOUT)
        assert r.status_code == 400

    def test_cancelling_returns_the_stock(self, product, buyer, admin_headers):
        headers, _uid, _email = buyer
        pid, vid = product["product_id"], product["variants"][0]["variant_id"]
        add_to_cart(headers, product, 2)
        res = checkout(headers).json()
        pay(res["session_id"])
        assert stock_of(pid, vid) == 1

        requests.patch(f"{API}/admin/shop/orders/{res['order_id']}", headers=admin_headers,
                       json={"status": "cancelled"}, timeout=TIMEOUT)
        assert stock_of(pid, vid) == 3

    def test_customers_cannot_see_each_others_orders(self, paid_order):
        order_id, _h = paid_order
        other, uid2, _e = mint_user("user")
        try:
            r = requests.get(f"{API}/shop/orders/{order_id}", headers=other, timeout=TIMEOUT)
            assert r.status_code == 404
        finally:
            _cleanup(user_ids=[uid2])


class TestAdminCatalogue:
    def test_products_are_admin_only(self, user_headers):
        assert requests.get(f"{API}/admin/shop/products", headers=user_headers, timeout=TIMEOUT).status_code == 403

    def test_a_variant_needs_a_sku(self, admin_headers):
        r = requests.post(f"{API}/admin/shop/products", headers=admin_headers, timeout=TIMEOUT, json={
            "name": "TEST_NoSku", "price_ron": 10, "variants": [{"size": "M", "sku": "", "stock": 1}]})
        assert r.status_code == 400, r.text

    def test_duplicate_skus_within_a_product_are_refused(self, admin_headers):
        r = requests.post(f"{API}/admin/shop/products", headers=admin_headers, timeout=TIMEOUT, json={
            "name": "TEST_DupeSku", "price_ron": 10,
            "variants": [{"size": "M", "sku": "DUPE-1", "stock": 1},
                         {"size": "L", "sku": "DUPE-1", "stock": 1}]})
        assert r.status_code == 400, r.text

    def test_a_product_with_orders_is_hidden_rather_than_deleted(self, product, buyer, admin_headers):
        """An order line has to keep resolving for invoices and returns."""
        headers, _uid, _email = buyer
        add_to_cart(headers, product, 1)
        pay(checkout(headers).json()["session_id"])

        r = requests.delete(f"{API}/admin/shop/products/{product['product_id']}",
                            headers=admin_headers, timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        assert r.json().get("unpublished") is True
        assert db.products.find_one({"product_id": product["product_id"]}) is not None
