"""
Umbra Collective - Ticketing platform backend
FastAPI + MongoDB + Emergent Auth + Stripe Checkout
"""
import io
import os
import uuid
import base64
import logging
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import List, Optional

import httpx
import qrcode
from dotenv import load_dotenv
from fastapi import FastAPI, APIRouter, Depends, HTTPException, Request, Response, Cookie, Header
from fastapi.responses import StreamingResponse
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.pdfgen import canvas
from starlette.middleware.cors import CORSMiddleware

from emergentintegrations.payments.stripe.checkout import (
    StripeCheckout,
    CheckoutSessionRequest,
)

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]
STRIPE_API_KEY = os.environ.get("STRIPE_API_KEY", "sk_test_emergent")

client = AsyncIOMotorClient(MONGO_URL)
db = client[DB_NAME]

app = FastAPI(title="Umbra Collective API")
api = APIRouter(prefix="/api")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("umbra")

# ---------- Utility ----------

def now_utc():
    return datetime.now(timezone.utc)


def new_id(prefix: str = "id"):
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def parse_dt(v):
    if v is None:
        return None
    if isinstance(v, datetime):
        return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
    return datetime.fromisoformat(v.replace("Z", "+00:00"))


# ---------- Auth ----------

EMERGENT_SESSION_URL = "https://demobackend.emergentagent.com/auth/v1/env/oauth/session-data"


async def get_current_user(
    request: Request,
    session_token: Optional[str] = Cookie(default=None),
    authorization: Optional[str] = Header(default=None),
):
    token = session_token
    if not token and authorization and authorization.startswith("Bearer "):
        token = authorization.split(" ", 1)[1]
    if not token:
        raise HTTPException(401, "Not authenticated")

    session = await db.user_sessions.find_one({"session_token": token}, {"_id": 0})
    if not session:
        raise HTTPException(401, "Invalid session")

    expires_at = parse_dt(session.get("expires_at"))
    if expires_at and expires_at < now_utc():
        raise HTTPException(401, "Session expired")

    user = await db.users.find_one({"user_id": session["user_id"]}, {"_id": 0})
    if not user:
        raise HTTPException(401, "User not found")
    return user


async def require_admin(user=Depends(get_current_user)):
    if user.get("role") not in ("admin", "door"):
        raise HTTPException(403, "Admin access required")
    if user.get("role") == "door":
        raise HTTPException(403, "Admin access required")
    return user


async def require_admin_or_door(user=Depends(get_current_user)):
    if user.get("role") not in ("admin", "door"):
        raise HTTPException(403, "Access denied")
    return user


# ---------- Models (light-touch, we use dicts for storage) ----------

class SessionBody(BaseModel):
    session_id: str


class ProfileUpdate(BaseModel):
    name: Optional[str] = None
    phone: Optional[str] = None


class ArtistIn(BaseModel):
    name: str
    slug: str
    bio: str = ""
    image_url: str = ""
    links: dict = {}


class ProjectIn(BaseModel):
    title: str
    slug: str
    description: str = ""
    year: Optional[int] = None
    image_url: str = ""
    artist_ids: List[str] = []
    is_past: bool = False


class WaveIn(BaseModel):
    name: str
    price_ron: float
    capacity: int
    starts_at: str
    ends_at: str
    tier: str = "general"  # early_bird, general, vip


class EventIn(BaseModel):
    title: str
    slug: str
    description: str = ""
    venue: str = ""
    starts_at: str
    ends_at: Optional[str] = None
    doors_open_at: Optional[str] = None
    image_url: str = ""
    artist_ids: List[str] = []
    max_tickets_per_user: int = 4
    is_published: bool = False
    waves: List[WaveIn] = []


class DiscountIn(BaseModel):
    code: str
    percent_off: int
    expires_at: Optional[str] = None
    max_uses: int = 0  # 0 = unlimited
    event_id: Optional[str] = None


class SpecialLinkIn(BaseModel):
    event_id: str
    label: str
    price_ron: float
    capacity: int


class ReserveIn(BaseModel):
    event_id: str
    wave_id: str
    quantity: int
    discount_code: Optional[str] = None
    special_link_token: Optional[str] = None


class CheckoutIn(BaseModel):
    reservation_id: str
    origin_url: str


# ---------- Auth Endpoints ----------

@api.post("/auth/session")
async def create_session(body: SessionBody, response: Response):
    """Exchange session_id from Emergent Auth for a session_token."""
    async with httpx.AsyncClient(timeout=15.0) as hc:
        r = await hc.get(EMERGENT_SESSION_URL, headers={"X-Session-ID": body.session_id})
    if r.status_code != 200:
        raise HTTPException(401, "Invalid session_id")
    data = r.json()

    email = data["email"]
    existing = await db.users.find_one({"email": email}, {"_id": 0})
    if existing:
        user_id = existing["user_id"]
        await db.users.update_one(
            {"user_id": user_id},
            {"$set": {"name": data.get("name"), "picture": data.get("picture")}},
        )
    else:
        user_id = f"user_{uuid.uuid4().hex[:12]}"
        # First user becomes admin
        is_first = (await db.users.count_documents({})) == 0
        await db.users.insert_one({
            "user_id": user_id,
            "email": email,
            "name": data.get("name"),
            "picture": data.get("picture"),
            "phone": "",
            "role": "admin" if is_first else "user",
            "created_at": now_utc().isoformat(),
        })

    session_token = data["session_token"]
    expires_at = now_utc() + timedelta(days=7)
    await db.user_sessions.insert_one({
        "user_id": user_id,
        "session_token": session_token,
        "expires_at": expires_at.isoformat(),
        "created_at": now_utc().isoformat(),
    })

    response.set_cookie(
        key="session_token",
        value=session_token,
        max_age=7 * 24 * 3600,
        httponly=True,
        secure=True,
        samesite="none",
        path="/",
    )
    user = await db.users.find_one({"user_id": user_id}, {"_id": 0})
    return {"user": user}


@api.get("/auth/me")
async def auth_me(user=Depends(get_current_user)):
    return user


@api.post("/auth/logout")
async def logout(response: Response, session_token: Optional[str] = Cookie(default=None)):
    if session_token:
        await db.user_sessions.delete_one({"session_token": session_token})
    response.delete_cookie("session_token", path="/")
    return {"ok": True}


@api.patch("/auth/profile")
async def update_profile(body: ProfileUpdate, user=Depends(get_current_user)):
    upd = {k: v for k, v in body.model_dump().items() if v is not None}
    if upd:
        await db.users.update_one({"user_id": user["user_id"]}, {"$set": upd})
    return await db.users.find_one({"user_id": user["user_id"]}, {"_id": 0})


# ---------- Public content ----------

@api.get("/artists")
async def list_artists():
    items = await db.artists.find({}, {"_id": 0}).to_list(200)
    return items


@api.get("/artists/{slug}")
async def get_artist(slug: str):
    a = await db.artists.find_one({"slug": slug}, {"_id": 0})
    if not a:
        raise HTTPException(404, "Not found")
    return a


@api.get("/projects")
async def list_projects():
    items = await db.projects.find({}, {"_id": 0}).sort("year", -1).to_list(200)
    return items


@api.get("/events")
async def list_events(upcoming: bool = True):
    now_iso = now_utc().isoformat()
    query = {"is_published": True}
    if upcoming:
        query["starts_at"] = {"$gte": now_iso}
    else:
        query["starts_at"] = {"$lt": now_iso}
    items = await db.events.find(query, {"_id": 0}).sort("starts_at", 1 if upcoming else -1).to_list(200)
    # Compute availability per event
    for e in items:
        e["total_available"] = sum(max(0, w.get("available", w.get("capacity", 0))) for w in e.get("waves", []))
    return items


@api.get("/events/{slug}")
async def get_event(slug: str):
    e = await db.events.find_one({"slug": slug, "is_published": True}, {"_id": 0})
    if not e:
        raise HTTPException(404, "Not found")
    now_iso = now_utc().isoformat()
    active_waves = []
    for w in e.get("waves", []):
        w["is_active"] = w["starts_at"] <= now_iso <= w["ends_at"]
        w["available"] = max(0, w.get("available", w.get("capacity", 0)))
        active_waves.append(w)
    e["waves"] = active_waves
    return e


@api.get("/gallery")
async def gallery():
    return await db.gallery.find({}, {"_id": 0}).to_list(200)


class ContactMsg(BaseModel):
    name: str
    email: str
    message: str


@api.post("/contact")
async def contact(msg: ContactMsg):
    await db.contact_messages.insert_one({
        "id": new_id("msg"),
        "name": msg.name,
        "email": msg.email,
        "message": msg.message,
        "created_at": now_utc().isoformat(),
    })
    return {"ok": True}


# ---------- Ticketing (Reserve → Checkout → Confirm) ----------

HOLD_MINUTES = 10


async def _cleanup_expired_reservations(event_id: str):
    """Return held stock from expired unpaid reservations to their waves."""
    now_iso = now_utc().isoformat()
    expired = await db.reservations.find({
        "event_id": event_id,
        "status": "pending",
        "expires_at": {"$lt": now_iso},
    }).to_list(500)
    for r in expired:
        await db.events.update_one(
            {"event_id": event_id, "waves.wave_id": r["wave_id"]},
            {"$inc": {"waves.$.available": r["quantity"]}},
        )
        await db.reservations.update_one({"reservation_id": r["reservation_id"]}, {"$set": {"status": "expired"}})


@api.post("/reservations")
async def create_reservation(body: ReserveIn, user=Depends(get_current_user)):
    if body.quantity < 1:
        raise HTTPException(400, "Invalid quantity")

    event = await db.events.find_one({"event_id": body.event_id}, {"_id": 0})
    if not event or not event.get("is_published"):
        raise HTTPException(404, "Event not found")

    await _cleanup_expired_reservations(body.event_id)
    event = await db.events.find_one({"event_id": body.event_id}, {"_id": 0})

    # Enforce max tickets per user for this event
    max_per_user = event.get("max_tickets_per_user", 4)
    existing = await db.tickets.count_documents({"event_id": body.event_id, "user_id": user["user_id"]})
    pending = await db.reservations.find(
        {"event_id": body.event_id, "user_id": user["user_id"], "status": "pending"}, {"_id": 0}
    ).to_list(50)
    pending_qty = sum(r["quantity"] for r in pending)
    if existing + pending_qty + body.quantity > max_per_user:
        raise HTTPException(400, f"Ticket limit reached ({max_per_user} per user)")

    # Find wave
    wave = None
    for w in event.get("waves", []):
        if w["wave_id"] == body.wave_id:
            wave = w
            break
    if not wave:
        raise HTTPException(404, "Wave not found")

    now_iso = now_utc().isoformat()
    unit_price = float(wave["price_ron"])
    # Special link overrides price and uses its own capacity
    special = None
    if body.special_link_token:
        special = await db.special_links.find_one({"token": body.special_link_token, "event_id": body.event_id}, {"_id": 0})
        if not special:
            raise HTTPException(400, "Invalid special link")
        used = special.get("used", 0)
        if used + body.quantity > special["capacity"]:
            raise HTTPException(400, "Special link capacity exceeded")
        unit_price = float(special["price_ron"])
    else:
        if not (wave["starts_at"] <= now_iso <= wave["ends_at"]):
            raise HTTPException(400, "Wave not active")
        if wave.get("available", wave["capacity"]) < body.quantity:
            raise HTTPException(400, "Not enough tickets available")

    # Apply discount code
    discount_percent = 0
    discount_code_used = None
    if body.discount_code and not special:
        code = await db.discounts.find_one({"code": body.discount_code.upper()}, {"_id": 0})
        if not code:
            raise HTTPException(400, "Invalid discount code")
        if code.get("event_id") and code["event_id"] != body.event_id:
            raise HTTPException(400, "Discount not valid for this event")
        if code.get("expires_at") and code["expires_at"] < now_iso:
            raise HTTPException(400, "Discount code expired")
        if code.get("max_uses", 0) > 0 and code.get("uses", 0) >= code["max_uses"]:
            raise HTTPException(400, "Discount code exhausted")
        discount_percent = int(code["percent_off"])
        discount_code_used = code["code"]

    subtotal = unit_price * body.quantity
    discount_amount = subtotal * (discount_percent / 100.0)
    total = round(subtotal - discount_amount, 2)

    # Deduct from wave availability (only if not a special link)
    if not special:
        upd = await db.events.update_one(
            {
                "event_id": body.event_id,
                "waves": {"$elemMatch": {"wave_id": body.wave_id, "available": {"$gte": body.quantity}}},
            },
            {"$inc": {"waves.$.available": -body.quantity}},
        )
        if upd.modified_count != 1:
            raise HTTPException(400, "Failed to hold tickets (sold out)")

    reservation_id = new_id("res")
    expires_at = now_utc() + timedelta(minutes=HOLD_MINUTES)
    doc = {
        "reservation_id": reservation_id,
        "user_id": user["user_id"],
        "event_id": body.event_id,
        "wave_id": body.wave_id,
        "quantity": body.quantity,
        "unit_price_ron": unit_price,
        "subtotal_ron": subtotal,
        "discount_percent": discount_percent,
        "discount_code": discount_code_used,
        "discount_amount_ron": round(discount_amount, 2),
        "total_ron": total,
        "special_link_token": body.special_link_token,
        "status": "pending",
        "expires_at": expires_at.isoformat(),
        "created_at": now_utc().isoformat(),
    }
    await db.reservations.insert_one(doc)
    return {**{k: v for k, v in doc.items() if k != "_id"}, "hold_minutes": HOLD_MINUTES}


@api.get("/reservations/{reservation_id}")
async def get_reservation(reservation_id: str, user=Depends(get_current_user)):
    r = await db.reservations.find_one({"reservation_id": reservation_id, "user_id": user["user_id"]}, {"_id": 0})
    if not r:
        raise HTTPException(404, "Not found")
    return r


@api.post("/checkout")
async def create_checkout(body: CheckoutIn, request: Request, user=Depends(get_current_user)):
    r = await db.reservations.find_one({"reservation_id": body.reservation_id, "user_id": user["user_id"]}, {"_id": 0})
    if not r:
        raise HTTPException(404, "Reservation not found")
    if r["status"] != "pending":
        raise HTTPException(400, f"Reservation is {r['status']}")
    if parse_dt(r["expires_at"]) < now_utc():
        raise HTTPException(400, "Reservation expired")

    host_url = str(request.base_url)
    webhook_url = f"{host_url}api/webhook/stripe"
    stripe = StripeCheckout(api_key=STRIPE_API_KEY, webhook_url=webhook_url)

    origin = body.origin_url.rstrip("/")
    success_url = f"{origin}/checkout/success?session_id={{CHECKOUT_SESSION_ID}}"
    cancel_url = f"{origin}/checkout/cancel?reservation_id={r['reservation_id']}"

    req = CheckoutSessionRequest(
        amount=float(r["total_ron"]),
        currency="ron",
        success_url=success_url,
        cancel_url=cancel_url,
        metadata={
            "reservation_id": r["reservation_id"],
            "user_id": user["user_id"],
            "event_id": r["event_id"],
        },
    )
    session = await stripe.create_checkout_session(req)

    await db.payment_transactions.insert_one({
        "session_id": session.session_id,
        "reservation_id": r["reservation_id"],
        "user_id": user["user_id"],
        "amount": float(r["total_ron"]),
        "currency": "ron",
        "payment_status": "initiated",
        "created_at": now_utc().isoformat(),
    })

    await db.reservations.update_one(
        {"reservation_id": r["reservation_id"]},
        {"$set": {"stripe_session_id": session.session_id}},
    )
    return {"url": session.url, "session_id": session.session_id}


async def _finalize_paid_reservation(reservation_id: str):
    """Idempotently create tickets and invoice when payment is confirmed."""
    r = await db.reservations.find_one({"reservation_id": reservation_id}, {"_id": 0})
    if not r:
        return
    if r["status"] == "paid":
        return

    # Update reservation
    await db.reservations.update_one(
        {"reservation_id": reservation_id, "status": "pending"},
        {"$set": {"status": "paid", "paid_at": now_utc().isoformat()}},
    )
    # Only proceed if we transitioned
    updated = await db.reservations.find_one({"reservation_id": reservation_id}, {"_id": 0})
    if updated["status"] != "paid":
        return

    # Create tickets
    tickets = []
    for i in range(r["quantity"]):
        qr = f"UMB-{uuid.uuid4().hex[:20].upper()}"
        t = {
            "ticket_id": new_id("tkt"),
            "qr_code": qr,
            "reservation_id": reservation_id,
            "user_id": r["user_id"],
            "event_id": r["event_id"],
            "wave_id": r["wave_id"],
            "price_ron": r["unit_price_ron"],
            "status": "issued",
            "scanned_at": None,
            "scanned_by": None,
            "created_at": now_utc().isoformat(),
        }
        tickets.append(t)
    if tickets:
        await db.tickets.insert_many(tickets)

    # Increment discount uses
    if r.get("discount_code"):
        await db.discounts.update_one({"code": r["discount_code"]}, {"$inc": {"uses": 1}})
    # Increment special link usage
    if r.get("special_link_token"):
        await db.special_links.update_one(
            {"token": r["special_link_token"]}, {"$inc": {"used": r["quantity"]}}
        )

    # Create invoice
    latest = await db.invoices.find({}, {"_id": 0}).sort("number", -1).limit(1).to_list(1)
    next_num = (latest[0]["number"] + 1) if latest else 1000
    vat_rate = 0.19  # Romanian standard VAT for entertainment (simplified)
    total = r["total_ron"]
    net = round(total / (1 + vat_rate), 2)
    vat_amount = round(total - net, 2)
    invoice = {
        "invoice_id": new_id("inv"),
        "number": next_num,
        "series": "UMB",
        "reservation_id": reservation_id,
        "user_id": r["user_id"],
        "event_id": r["event_id"],
        "issued_at": now_utc().isoformat(),
        "currency": "RON",
        "total": total,
        "net": net,
        "vat_rate": vat_rate,
        "vat_amount": vat_amount,
        "quantity": r["quantity"],
    }
    await db.invoices.insert_one(invoice)


@api.get("/payments/status/{session_id}")
async def payment_status(session_id: str, request: Request):
    tx = await db.payment_transactions.find_one({"session_id": session_id}, {"_id": 0})
    if not tx:
        raise HTTPException(404, "Transaction not found")

    if tx["payment_status"] == "paid":
        return tx

    host_url = str(request.base_url)
    stripe = StripeCheckout(api_key=STRIPE_API_KEY, webhook_url=f"{host_url}api/webhook/stripe")
    status = await stripe.get_checkout_status(session_id)

    new_status = status.payment_status
    await db.payment_transactions.update_one(
        {"session_id": session_id},
        {"$set": {"payment_status": new_status, "status": status.status}},
    )
    if new_status == "paid":
        await _finalize_paid_reservation(tx["reservation_id"])
    tx = await db.payment_transactions.find_one({"session_id": session_id}, {"_id": 0})
    return tx


@api.post("/webhook/stripe")
async def stripe_webhook(request: Request):
    body = await request.body()
    sig = request.headers.get("Stripe-Signature", "")
    host_url = str(request.base_url)
    stripe = StripeCheckout(api_key=STRIPE_API_KEY, webhook_url=f"{host_url}api/webhook/stripe")
    try:
        evt = await stripe.handle_webhook(body, sig)
    except Exception as e:
        logger.exception("Webhook error")
        raise HTTPException(400, str(e))
    if evt.payment_status == "paid":
        tx = await db.payment_transactions.find_one({"session_id": evt.session_id}, {"_id": 0})
        if tx:
            await db.payment_transactions.update_one(
                {"session_id": evt.session_id},
                {"$set": {"payment_status": "paid"}},
            )
            await _finalize_paid_reservation(tx["reservation_id"])
    return {"received": True}


# ---------- My tickets ----------

@api.get("/my/tickets")
async def my_tickets(user=Depends(get_current_user)):
    tickets = await db.tickets.find({"user_id": user["user_id"]}, {"_id": 0}).sort("created_at", -1).to_list(500)
    result = []
    for t in tickets:
        ev = await db.events.find_one({"event_id": t["event_id"]}, {"_id": 0, "waves": 0})
        result.append({**t, "event": ev})
    return result


@api.get("/my/reservations")
async def my_reservations(user=Depends(get_current_user)):
    return await db.reservations.find({"user_id": user["user_id"]}, {"_id": 0}).sort("created_at", -1).to_list(200)


@api.get("/tickets/{qr_code}/qr.png")
async def ticket_qr_png(qr_code: str, user=Depends(get_current_user)):
    t = await db.tickets.find_one({"qr_code": qr_code}, {"_id": 0})
    if not t:
        raise HTTPException(404, "Not found")
    if t["user_id"] != user["user_id"] and user.get("role") not in ("admin", "door"):
        raise HTTPException(403, "Forbidden")
    img = qrcode.make(qr_code)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return StreamingResponse(buf, media_type="image/png")


# ---------- Invoices (PDF) ----------

@api.get("/invoices/mine")
async def my_invoices(user=Depends(get_current_user)):
    return await db.invoices.find({"user_id": user["user_id"]}, {"_id": 0}).sort("issued_at", -1).to_list(200)


@api.get("/invoices/{invoice_id}/pdf")
async def invoice_pdf(invoice_id: str, user=Depends(get_current_user)):
    inv = await db.invoices.find_one({"invoice_id": invoice_id}, {"_id": 0})
    if not inv:
        raise HTTPException(404, "Not found")
    if inv["user_id"] != user["user_id"] and user.get("role") != "admin":
        raise HTTPException(403, "Forbidden")

    ev = await db.events.find_one({"event_id": inv["event_id"]}, {"_id": 0}) or {}
    buyer = await db.users.find_one({"user_id": inv["user_id"]}, {"_id": 0}) or {}

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    W, H = A4
    c.setFillColor(colors.black)
    c.setFont("Helvetica-Bold", 22)
    c.drawString(40, H - 60, "UMBRA COLLECTIVE")
    c.setFont("Helvetica", 9)
    c.drawString(40, H - 75, "Bucharest, Romania · VAT compliant invoice")
    c.setFont("Helvetica-Bold", 14)
    c.drawString(40, H - 120, f"INVOICE {inv['series']}-{inv['number']:06d}")
    c.setFont("Helvetica", 10)
    c.drawString(40, H - 138, f"Issued: {inv['issued_at'][:19].replace('T', ' ')} UTC")
    c.drawString(40, H - 155, f"Bill to: {buyer.get('name', '')} <{buyer.get('email', '')}>")
    c.drawString(40, H - 172, f"Event: {ev.get('title', '')}")
    c.drawString(40, H - 189, f"Venue: {ev.get('venue', '')}")

    y = H - 240
    c.setFont("Helvetica-Bold", 10)
    c.drawString(40, y, "DESCRIPTION")
    c.drawString(340, y, "QTY")
    c.drawString(400, y, "NET (RON)")
    c.drawString(480, y, "VAT")
    c.drawString(530, y, "TOTAL")
    c.line(40, y - 4, 570, y - 4)
    y -= 22
    c.setFont("Helvetica", 10)
    c.drawString(40, y, f"Ticket · {ev.get('title', '')}")
    c.drawString(340, y, str(inv["quantity"]))
    c.drawString(400, y, f"{inv['net']:.2f}")
    c.drawString(480, y, f"{inv['vat_amount']:.2f}")
    c.drawString(530, y, f"{inv['total']:.2f}")

    y -= 50
    c.setFont("Helvetica-Bold", 11)
    c.drawString(400, y, "Net:")
    c.drawString(500, y, f"{inv['net']:.2f} RON")
    y -= 16
    c.drawString(400, y, f"VAT ({int(inv['vat_rate']*100)}%):")
    c.drawString(500, y, f"{inv['vat_amount']:.2f} RON")
    y -= 16
    c.setFont("Helvetica-Bold", 13)
    c.drawString(400, y, "Total:")
    c.drawString(500, y, f"{inv['total']:.2f} RON")

    c.setFont("Helvetica-Oblique", 8)
    c.drawString(40, 50, "All sales final unless event cancelled. This is a proforma invoice for the MVP.")

    c.showPage()
    c.save()
    buf.seek(0)
    return StreamingResponse(buf, media_type="application/pdf",
                             headers={"Content-Disposition": f"inline; filename={inv['series']}-{inv['number']}.pdf"})


# ---------- Door scanner ----------

class ScanIn(BaseModel):
    qr_code: str


@api.post("/scan")
async def scan_ticket(body: ScanIn, user=Depends(require_admin_or_door)):
    t = await db.tickets.find_one({"qr_code": body.qr_code}, {"_id": 0})
    if not t:
        return {"valid": False, "reason": "TICKET NOT FOUND"}
    if t["status"] != "issued":
        return {"valid": False, "reason": f"TICKET {t['status'].upper()}", "ticket": t}

    ev = await db.events.find_one({"event_id": t["event_id"]}, {"_id": 0}) or {}
    now_iso = now_utc().isoformat()
    doors = ev.get("doors_open_at") or ev.get("starts_at")
    ends = ev.get("ends_at")
    if doors and now_iso < doors:
        return {"valid": False, "reason": "DOORS NOT OPEN YET", "ticket": t, "event": ev}
    if ends and now_iso > ends:
        return {"valid": False, "reason": "EVENT ENDED", "ticket": t, "event": ev}

    # first-scan-wins
    upd = await db.tickets.update_one(
        {"qr_code": body.qr_code, "status": "issued"},
        {"$set": {"status": "used", "scanned_at": now_iso, "scanned_by": user["user_id"]}},
    )
    if upd.modified_count != 1:
        t2 = await db.tickets.find_one({"qr_code": body.qr_code}, {"_id": 0})
        return {"valid": False, "reason": "ALREADY SCANNED", "ticket": t2, "event": ev}

    ticket = await db.tickets.find_one({"qr_code": body.qr_code}, {"_id": 0})
    return {"valid": True, "ticket": ticket, "event": ev}


# ---------- Admin ----------

@api.get("/admin/stats")
async def admin_stats(user=Depends(require_admin)):
    total_orders = await db.reservations.count_documents({"status": "paid"})
    total_tickets = await db.tickets.count_documents({})
    scanned = await db.tickets.count_documents({"status": "used"})
    revenue_docs = await db.reservations.find({"status": "paid"}, {"_id": 0, "total_ron": 1}).to_list(5000)
    revenue = sum(r["total_ron"] for r in revenue_docs)
    events = await db.events.count_documents({})
    return {
        "revenue_ron": round(revenue, 2),
        "total_orders": total_orders,
        "total_tickets": total_tickets,
        "scanned": scanned,
        "events": events,
    }


@api.get("/admin/events")
async def admin_list_events(user=Depends(require_admin)):
    return await db.events.find({}, {"_id": 0}).sort("starts_at", -1).to_list(500)


@api.post("/admin/events")
async def admin_create_event(body: EventIn, user=Depends(require_admin)):
    e = body.model_dump()
    e["event_id"] = new_id("evt")
    waves = []
    for w in e.get("waves", []):
        w["wave_id"] = new_id("wave")
        w["available"] = w["capacity"]
        waves.append(w)
    e["waves"] = waves
    e["created_at"] = now_utc().isoformat()
    await db.events.insert_one(e)
    return {**{k: v for k, v in e.items() if k != "_id"}}


@api.patch("/admin/events/{event_id}")
async def admin_update_event(event_id: str, body: dict, user=Depends(require_admin)):
    body.pop("event_id", None)
    body.pop("_id", None)
    if "waves" in body:
        new_waves = []
        existing = await db.events.find_one({"event_id": event_id}, {"_id": 0})
        by_id = {w["wave_id"]: w for w in (existing.get("waves", []) if existing else [])}
        for w in body["waves"]:
            if w.get("wave_id") and w["wave_id"] in by_id:
                prev = by_id[w["wave_id"]]
                sold = prev["capacity"] - prev.get("available", prev["capacity"])
                w["available"] = max(0, w["capacity"] - sold)
            else:
                w["wave_id"] = new_id("wave")
                w["available"] = w["capacity"]
            new_waves.append(w)
        body["waves"] = new_waves
    await db.events.update_one({"event_id": event_id}, {"$set": body})
    return await db.events.find_one({"event_id": event_id}, {"_id": 0})


@api.delete("/admin/events/{event_id}")
async def admin_delete_event(event_id: str, user=Depends(require_admin)):
    await db.events.delete_one({"event_id": event_id})
    return {"ok": True}


@api.post("/admin/events/{event_id}/cancel")
async def admin_cancel_event(event_id: str, user=Depends(require_admin)):
    await db.events.update_one({"event_id": event_id}, {"$set": {"is_published": False, "cancelled": True}})
    # Refund policy: mark tickets as refunded (real refund via Stripe would happen out-of-band)
    await db.tickets.update_many({"event_id": event_id, "status": "issued"}, {"$set": {"status": "refunded"}})
    return {"ok": True}


@api.get("/admin/orders")
async def admin_orders(user=Depends(require_admin)):
    return await db.reservations.find({}, {"_id": 0}).sort("created_at", -1).limit(500).to_list(500)


@api.post("/admin/orders/{reservation_id}/refund")
async def admin_refund(reservation_id: str, user=Depends(require_admin)):
    await db.reservations.update_one({"reservation_id": reservation_id}, {"$set": {"status": "refunded"}})
    await db.tickets.update_many({"reservation_id": reservation_id}, {"$set": {"status": "refunded"}})
    return {"ok": True}


@api.get("/admin/artists")
async def admin_list_artists(user=Depends(require_admin)):
    return await db.artists.find({}, {"_id": 0}).to_list(500)


@api.post("/admin/artists")
async def admin_create_artist(body: ArtistIn, user=Depends(require_admin)):
    a = body.model_dump()
    a["artist_id"] = new_id("art")
    a["created_at"] = now_utc().isoformat()
    await db.artists.insert_one(a)
    return {k: v for k, v in a.items() if k != "_id"}


@api.patch("/admin/artists/{artist_id}")
async def admin_update_artist(artist_id: str, body: dict, user=Depends(require_admin)):
    body.pop("_id", None)
    await db.artists.update_one({"artist_id": artist_id}, {"$set": body})
    return await db.artists.find_one({"artist_id": artist_id}, {"_id": 0})


@api.delete("/admin/artists/{artist_id}")
async def admin_delete_artist(artist_id: str, user=Depends(require_admin)):
    await db.artists.delete_one({"artist_id": artist_id})
    return {"ok": True}


@api.get("/admin/projects")
async def admin_list_projects(user=Depends(require_admin)):
    return await db.projects.find({}, {"_id": 0}).to_list(500)


@api.post("/admin/projects")
async def admin_create_project(body: ProjectIn, user=Depends(require_admin)):
    p = body.model_dump()
    p["project_id"] = new_id("prj")
    p["created_at"] = now_utc().isoformat()
    await db.projects.insert_one(p)
    return {k: v for k, v in p.items() if k != "_id"}


@api.delete("/admin/projects/{project_id}")
async def admin_delete_project(project_id: str, user=Depends(require_admin)):
    await db.projects.delete_one({"project_id": project_id})
    return {"ok": True}


@api.get("/admin/discounts")
async def admin_list_discounts(user=Depends(require_admin)):
    return await db.discounts.find({}, {"_id": 0}).to_list(500)


@api.post("/admin/discounts")
async def admin_create_discount(body: DiscountIn, user=Depends(require_admin)):
    d = body.model_dump()
    d["code"] = d["code"].upper()
    d["discount_id"] = new_id("dsc")
    d["uses"] = 0
    d["created_at"] = now_utc().isoformat()
    await db.discounts.insert_one(d)
    return {k: v for k, v in d.items() if k != "_id"}


@api.delete("/admin/discounts/{discount_id}")
async def admin_delete_discount(discount_id: str, user=Depends(require_admin)):
    await db.discounts.delete_one({"discount_id": discount_id})
    return {"ok": True}


@api.get("/admin/special-links")
async def admin_list_special(user=Depends(require_admin)):
    return await db.special_links.find({}, {"_id": 0}).to_list(500)


@api.post("/admin/special-links")
async def admin_create_special(body: SpecialLinkIn, user=Depends(require_admin)):
    s = body.model_dump()
    s["link_id"] = new_id("spc")
    s["token"] = uuid.uuid4().hex[:16]
    s["used"] = 0
    s["created_at"] = now_utc().isoformat()
    await db.special_links.insert_one(s)
    return {k: v for k, v in s.items() if k != "_id"}


@api.delete("/admin/special-links/{link_id}")
async def admin_delete_special(link_id: str, user=Depends(require_admin)):
    await db.special_links.delete_one({"link_id": link_id})
    return {"ok": True}


@api.get("/special-links/{token}")
async def get_special_link(token: str):
    s = await db.special_links.find_one({"token": token}, {"_id": 0})
    if not s:
        raise HTTPException(404, "Not found")
    ev = await db.events.find_one({"event_id": s["event_id"]}, {"_id": 0})
    return {"link": s, "event": ev}


@api.get("/admin/users")
async def admin_users(user=Depends(require_admin)):
    return await db.users.find({}, {"_id": 0}).to_list(500)


@api.patch("/admin/users/{user_id}/role")
async def admin_set_role(user_id: str, body: dict, user=Depends(require_admin)):
    role = body.get("role")
    if role not in ("user", "admin", "door"):
        raise HTTPException(400, "Invalid role")
    await db.users.update_one({"user_id": user_id}, {"$set": {"role": role}})
    return {"ok": True}


@api.get("/admin/gallery")
async def admin_gallery(user=Depends(require_admin)):
    return await db.gallery.find({}, {"_id": 0}).to_list(500)


class GalleryIn(BaseModel):
    image_url: str
    caption: str = ""


@api.post("/admin/gallery")
async def admin_add_gallery(body: GalleryIn, user=Depends(require_admin)):
    g = body.model_dump()
    g["gallery_id"] = new_id("gal")
    g["created_at"] = now_utc().isoformat()
    await db.gallery.insert_one(g)
    return {k: v for k, v in g.items() if k != "_id"}


@api.delete("/admin/gallery/{gallery_id}")
async def admin_delete_gallery(gallery_id: str, user=Depends(require_admin)):
    await db.gallery.delete_one({"gallery_id": gallery_id})
    return {"ok": True}


# ---------- Seed ----------

@api.post("/seed")
async def seed_demo():
    """Seed demo data if empty. Public for MVP convenience."""
    if await db.events.count_documents({}) > 0:
        return {"seeded": False, "reason": "already has data"}

    a1 = {"artist_id": new_id("art"), "name": "VOID ORCHESTRA", "slug": "void-orchestra",
          "bio": "Berlin-based collective bending techno with live strings.",
          "image_url": "https://images.unsplash.com/photo-1762289581607-fc292299dc87?crop=entropy&cs=srgb&fm=jpg&q=85",
          "links": {"soundcloud": "https://soundcloud.com/", "instagram": "https://instagram.com/"},
          "created_at": now_utc().isoformat()}
    a2 = {"artist_id": new_id("art"), "name": "NOKTURN", "slug": "nokturn",
          "bio": "Romanian producer channelling minimal micro-house.",
          "image_url": "https://images.unsplash.com/photo-1593408995262-1d8933c37afc?crop=entropy&cs=srgb&fm=jpg&q=85",
          "links": {}, "created_at": now_utc().isoformat()}
    a3 = {"artist_id": new_id("art"), "name": "LUMEN / CORPS", "slug": "lumen-corps",
          "bio": "Contemporary dance duo working at the intersection of light and body.",
          "image_url": "https://images.unsplash.com/photo-1618601208267-baa5b780b70e?crop=entropy&cs=srgb&fm=jpg&q=85",
          "links": {}, "created_at": now_utc().isoformat()}
    await db.artists.insert_many([a1, a2, a3])

    p1 = {"project_id": new_id("prj"), "title": "BLACK ROOM · WINTER 2023", "slug": "black-room-2023",
          "description": "48h continuous programme across four Bucharest venues.",
          "year": 2023, "image_url": "https://images.unsplash.com/photo-1687511844598-165c1fc387cc?crop=entropy&cs=srgb&fm=jpg&q=85",
          "artist_ids": [a1["artist_id"], a2["artist_id"]], "is_past": True,
          "created_at": now_utc().isoformat()}
    p2 = {"project_id": new_id("prj"), "title": "CORPUS · SUMMER RESIDENCY", "slug": "corpus-2024",
          "description": "Cross-disciplinary residency with dancers, producers and light artists.",
          "year": 2024, "image_url": "https://images.unsplash.com/photo-1593408995262-1d8933c37afc?crop=entropy&cs=srgb&fm=jpg&q=85",
          "artist_ids": [a3["artist_id"]], "is_past": True,
          "created_at": now_utc().isoformat()}
    await db.projects.insert_many([p1, p2])

    # Gallery
    await db.gallery.insert_many([
        {"gallery_id": new_id("gal"), "image_url": "https://images.unsplash.com/photo-1545128485-c400e7702796?crop=entropy&cs=srgb&fm=jpg&q=85", "caption": "Black Room · Night 02", "created_at": now_utc().isoformat()},
        {"gallery_id": new_id("gal"), "image_url": "https://images.unsplash.com/photo-1687511844598-165c1fc387cc?crop=entropy&cs=srgb&fm=jpg&q=85", "caption": "Crowd · Opening", "created_at": now_utc().isoformat()},
        {"gallery_id": new_id("gal"), "image_url": "https://images.unsplash.com/photo-1593408995262-1d8933c37afc?crop=entropy&cs=srgb&fm=jpg&q=85", "caption": "Corpus · Residency", "created_at": now_utc().isoformat()},
        {"gallery_id": new_id("gal"), "image_url": "https://images.unsplash.com/photo-1618601208267-baa5b780b70e?crop=entropy&cs=srgb&fm=jpg&q=85", "caption": "Light installation", "created_at": now_utc().isoformat()},
    ])

    # Event with three waves
    now = now_utc()
    starts = (now + timedelta(days=21)).replace(microsecond=0)
    doors = (starts - timedelta(hours=1)).isoformat()
    ends = (starts + timedelta(hours=8)).isoformat()

    def wave(name, price, cap, offset_start_days, dur_days, tier):
        s = (now + timedelta(days=offset_start_days)).isoformat()
        e = (now + timedelta(days=offset_start_days + dur_days)).isoformat()
        return {
            "wave_id": new_id("wave"),
            "name": name, "price_ron": price, "capacity": cap, "available": cap,
            "starts_at": s, "ends_at": e, "tier": tier,
        }

    e1 = {
        "event_id": new_id("evt"),
        "title": "OBSIDIAN · CHAPTER I",
        "slug": "obsidian-chapter-i",
        "description": "A single-night programme by Void Orchestra and Nokturn, curated across two rooms. Doors 22:00, close 06:00.",
        "venue": "HALA 3, Bucharest",
        "starts_at": starts.isoformat(),
        "ends_at": ends,
        "doors_open_at": doors,
        "image_url": "https://images.unsplash.com/photo-1545128485-c400e7702796?crop=entropy&cs=srgb&fm=jpg&q=85",
        "artist_ids": [a1["artist_id"], a2["artist_id"]],
        "max_tickets_per_user": 4,
        "is_published": True,
        "waves": [
            wave("EARLY BIRD", 90.00, 100, -1, 30, "early_bird"),
            wave("GENERAL", 130.00, 250, -1, 30, "general"),
            wave("VIP", 250.00, 40, -1, 30, "vip"),
        ],
        "created_at": now_utc().isoformat(),
    }

    starts2 = (now + timedelta(days=45)).replace(microsecond=0)
    e2 = {
        "event_id": new_id("evt"),
        "title": "CORPUS · LIVE",
        "slug": "corpus-live",
        "description": "Lumen/Corps present a 90-minute performance in complete darkness.",
        "venue": "STUDIO M, Bucharest",
        "starts_at": starts2.isoformat(),
        "ends_at": (starts2 + timedelta(hours=2)).isoformat(),
        "doors_open_at": (starts2 - timedelta(minutes=30)).isoformat(),
        "image_url": "https://images.unsplash.com/photo-1593408995262-1d8933c37afc?crop=entropy&cs=srgb&fm=jpg&q=85",
        "artist_ids": [a3["artist_id"]],
        "max_tickets_per_user": 2,
        "is_published": True,
        "waves": [wave("GENERAL", 75.00, 120, -1, 40, "general")],
        "created_at": now_utc().isoformat(),
    }
    await db.events.insert_many([e1, e2])

    # Discount code
    await db.discounts.insert_one({
        "discount_id": new_id("dsc"),
        "code": "WELCOME10", "percent_off": 10,
        "expires_at": (now + timedelta(days=90)).isoformat(),
        "max_uses": 0, "uses": 0, "event_id": None,
        "created_at": now_utc().isoformat(),
    })

    return {"seeded": True}


# ---------- Register ----------

app.include_router(api)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=[o.strip() for o in os.environ.get("CORS_ORIGINS", "*").split(",")],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("shutdown")
async def shutdown():
    client.close()
