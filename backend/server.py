"""
Supersanity - Ticketing platform backend
FastAPI + MongoDB, first-party auth (password + Google/Apple OAuth) + Stripe Checkout
"""
import io
import os
import csv
import json
import uuid
import base64
import secrets
import logging
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import List, Optional

import jwt
import httpx
import qrcode
from dotenv import load_dotenv
from fastapi import FastAPI, APIRouter, Depends, HTTPException, Request, Response, Cookie, Header, UploadFile, File, Form, Query
from fastapi.responses import StreamingResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from urllib.parse import urlencode
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field
from PIL import Image
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.pdfgen import canvas
from starlette.middleware.cors import CORSMiddleware
# Simple in-memory sliding-window rate limiter. Enough for a single-node MVP.
# For multi-node prod, swap for a Redis-backed limiter.
from collections import defaultdict, deque
from threading import Lock
_rate_buckets: dict = defaultdict(lambda: defaultdict(deque))
_rate_lock = Lock()

def rate_limit(key: str, max_calls: int, window_seconds: int):
    """Returns a FastAPI dependency that raises 429 when exceeded."""
    async def _dep(request: Request):
        ip = request.headers.get("x-forwarded-for", "").split(",")[0].strip() or (request.client.host if request.client else "unknown")
        now = datetime.now(timezone.utc).timestamp()
        with _rate_lock:
            dq = _rate_buckets[key][ip]
            while dq and dq[0] < now - window_seconds:
                dq.popleft()
            if len(dq) >= max_calls:
                retry_after = int(window_seconds - (now - dq[0])) + 1
                raise HTTPException(
                    status_code=429,
                    detail=f"Too many requests. Try again in {retry_after}s.",
                    headers={"Retry-After": str(retry_after)},
                )
            dq.append(now)
    return _dep

import asyncio
import stripe as stripe_sdk

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]
STRIPE_API_KEY = os.environ.get("STRIPE_API_KEY", "").strip()
STRIPE_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET", "").strip()
INITIAL_ADMIN_EMAIL = os.environ.get("INITIAL_ADMIN_EMAIL", "").strip().lower()

# Payments run in one of two modes. "fake" (the out-of-box default) simulates the
# whole reserve→pay→finalize loop locally with no Stripe account, so the app is fully
# usable in dev. "stripe" uses the real SDK and REQUIRES a webhook signing secret.
_force_fake = os.environ.get("LOCAL_FAKE_PAYMENTS", "").strip() == "1"
PAYMENTS_MODE = "stripe" if (STRIPE_API_KEY.startswith("sk_") and not _force_fake) else "fake"
if PAYMENTS_MODE == "stripe":
    stripe_sdk.api_key = STRIPE_API_KEY
    if not STRIPE_WEBHOOK_SECRET:
        raise RuntimeError("STRIPE_WEBHOOK_SECRET is required when running live Stripe payments")

APP_ENV = os.environ.get("APP_ENV", "development").strip().lower()
# Public origin of the FRONTEND (where OAuth callbacks and email links send users
# back to). Its scheme also decides how session cookies are scoped (below).
PUBLIC_APP_URL = os.environ.get("PUBLIC_APP_URL", "http://localhost:3000").rstrip("/")
POLICY_VERSION = os.environ.get("POLICY_VERSION", "2026-07-22")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("supersanity")

# SESSION_SECRET signs all our stateless tokens (email verification, password reset,
# newsletter confirm/unsubscribe). It is REQUIRED in production; in dev we fall back to
# an ephemeral secret so a fresh checkout still boots (tokens just don't survive a restart).
SESSION_SECRET = os.environ.get("SESSION_SECRET", "").strip()
if not SESSION_SECRET:
    if APP_ENV == "production":
        raise RuntimeError("SESSION_SECRET is required when APP_ENV=production")
    SESSION_SECRET = "dev-insecure-" + secrets.token_hex(16)
    logger.warning("SESSION_SECRET not set — using an ephemeral dev secret; tokens reset on restart")

# Session cookie scoping is derived from the frontend scheme. Cross-site HTTPS needs
# SameSite=None; Secure; plain-http localhost needs Lax + insecure or browsers drop it.
COOKIE_SECURE = PUBLIC_APP_URL.startswith("https://")
COOKIE_SAMESITE = "none" if COOKIE_SECURE else "lax"

# OAuth providers — each is fully optional. A provider whose vars are unset simply
# doesn't appear in GET /auth/methods and its start/callback endpoints return 404.
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "").strip()
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "").strip()
GOOGLE_REDIRECT_URI = os.environ.get("GOOGLE_REDIRECT_URI", "").strip()
GOOGLE_ENABLED = bool(GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI)

APPLE_CLIENT_ID = os.environ.get("APPLE_CLIENT_ID", "").strip()      # Services ID
APPLE_TEAM_ID = os.environ.get("APPLE_TEAM_ID", "").strip()
APPLE_KEY_ID = os.environ.get("APPLE_KEY_ID", "").strip()
APPLE_PRIVATE_KEY = os.environ.get("APPLE_PRIVATE_KEY", "").strip()  # .p8 contents
APPLE_REDIRECT_URI = os.environ.get("APPLE_REDIRECT_URI", "").strip()
APPLE_ENABLED = bool(APPLE_CLIENT_ID and APPLE_TEAM_ID and APPLE_KEY_ID and APPLE_PRIVATE_KEY and APPLE_REDIRECT_URI)

client = AsyncIOMotorClient(MONGO_URL)
db = client[DB_NAME]

app = FastAPI(title="Supersanity API")
api = APIRouter(prefix="/api")

UPLOAD_DIR = ROOT_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)
app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")

IMAGE_CONTENT_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif"}
VIDEO_CONTENT_TYPES = {"video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov"}
MAX_UPLOAD_BYTES = 25 * 1024 * 1024

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


# ---------- Signed tokens ----------
# Stateless, single-file-secret tokens for flows that arrive by email/link and can't
# carry a session cookie: email verification, password reset, and newsletter
# confirm/unsubscribe. Each purpose gets its own JWT `aud` so a token minted for one
# flow can never be replayed against another, plus a purpose-specific TTL.

TOKEN_TTLS = {
    "email-verify": 24 * 3600,
    "pwd-reset": 3600,
    "news-confirm": 7 * 24 * 3600,
    "news-unsub": 365 * 24 * 3600,
}


def make_token(purpose: str, subject: str, extra: Optional[dict] = None) -> str:
    now = now_utc()
    payload = {
        "aud": f"ss:{purpose}",
        "sub": subject,
        "iat": now,
        "exp": now + timedelta(seconds=TOKEN_TTLS[purpose]),
        "jti": uuid.uuid4().hex,
        **(extra or {}),
    }
    return jwt.encode(payload, SESSION_SECRET, algorithm="HS256")


def read_token(purpose: str, token: str) -> dict:
    """Decode + verify a token for a specific purpose. Raises jwt.PyJWTError
    (expired/invalid/wrong-audience) — callers map that to HTTP 400."""
    return jwt.decode(token, SESSION_SECRET, algorithms=["HS256"], audience=f"ss:{purpose}")


# ---------- Auth ----------


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
    if user.get("role") != "admin":
        raise HTTPException(403, "Admin access required")
    return user


async def require_admin_or_editor(user=Depends(get_current_user)):
    if user.get("role") not in ("admin", "editor"):
        raise HTTPException(403, "Editor access required")
    return user


async def require_admin_or_door(user=Depends(get_current_user)):
    if user.get("role") not in ("admin", "door"):
        raise HTTPException(403, "Access denied")
    return user


# ---------- Auth helpers ----------

import bcrypt  # noqa: E402


def hash_password(pw: str) -> str:
    # bcrypt caps at 72 bytes; encode + truncate so long inputs don't silently error.
    return bcrypt.hashpw(pw.encode("utf-8")[:72], bcrypt.gensalt(rounds=12)).decode()


def verify_password(pw: str, hashed: Optional[str]) -> bool:
    if not hashed:
        return False
    try:
        return bcrypt.checkpw(pw.encode("utf-8")[:72], hashed.encode("utf-8"))
    except (ValueError, TypeError):
        return False


# Precomputed hash used to equalize timing on the "no such user" login path so an
# attacker can't distinguish a missing account from a wrong password by response time.
_DUMMY_HASH = hash_password("timing-equalizer-not-a-real-password")


def _valid_email(email: str) -> bool:
    email = (email or "").strip()
    return "@" in email and "." in email.split("@")[-1] and 3 <= len(email) <= 254


def _client_ip(request: Optional[Request]) -> str:
    if request is None:
        return ""
    return request.headers.get("x-forwarded-for", "").split(",")[0].strip() or (
        request.client.host if request.client else ""
    )


def _email_rate_check(bucket: str, email: str, max_calls: int, window: int):
    """Per-email sibling of rate_limit() (which keys on IP). Guards password login
    against distributed brute force of one account from many IPs."""
    now = datetime.now(timezone.utc).timestamp()
    key = (email or "").strip().lower()
    with _rate_lock:
        dq = _rate_buckets[bucket][key]
        while dq and dq[0] < now - window:
            dq.popleft()
        if len(dq) >= max_calls:
            raise HTTPException(429, "Too many attempts. Try again later.")
        dq.append(now)


async def _issue_session(response: Response, user_id: str, old_token: Optional[str] = None) -> str:
    """Create a fresh opaque session, set the cookie, and rotate out any prior
    session token (defeats fixation). expires_at is a real datetime so the Phase E
    TTL index can reap it server-side."""
    if old_token:
        await db.user_sessions.delete_one({"session_token": old_token})
    token = secrets.token_urlsafe(32)
    await db.user_sessions.insert_one({
        "user_id": user_id,
        "session_token": token,
        "expires_at": now_utc() + timedelta(days=7),
        "created_at": now_utc().isoformat(),
    })
    response.set_cookie(
        key="session_token", value=token, max_age=7 * 24 * 3600,
        httponly=True, secure=COOKIE_SECURE, samesite=COOKIE_SAMESITE, path="/",
    )
    return token


async def _log_consent(user_id: str, kind: str, granted: bool, request: Optional[Request], source: str):
    await db.consent_log.insert_one({
        "log_id": new_id("cst"),
        "user_id": user_id,
        "kind": kind,
        "granted": bool(granted),
        "at": now_utc().isoformat(),
        "ip": _client_ip(request),
        "policy_version": POLICY_VERSION,
        "source": source,
    })


async def _audit(actor_id: str, action: str, target_type: str, target_id: str, meta: Optional[dict] = None):
    """Append-only admin/action audit trail (role changes, refunds, cancellations,
    deletions). Never blocks the caller."""
    try:
        await db.audit_log.insert_one({
            "audit_id": new_id("aud"),
            "actor_id": actor_id,
            "action": action,
            "target_type": target_type,
            "target_id": target_id,
            "meta": meta or {},
            "at": now_utc().isoformat(),
        })
    except Exception:
        logger.exception("audit write failed: %s %s", action, target_id)


async def _get_or_create_user(email, *, name="", picture="", provider=None, sub=None, email_verified=False):
    """OAuth identity resolution + the verified-email account-linking gate.

    Match order: provider `sub` first (survives email changes / Apple private relay),
    then email. Email-based auto-linking is allowed ONLY when the existing account's
    email is already verified OR the incoming IdP asserts the email is verified —
    otherwise a stranger who pre-registered the victim's address with a password could
    be silently merged into. Returns (user_doc, created_bool). Raises 409 on a blocked
    link so the frontend can tell the user to use their original method.
    """
    email = (email or "").strip().lower()
    sub_field = {"google": "google_sub", "apple": "apple_sub"}.get(provider)

    if sub_field and sub:
        u = await db.users.find_one({sub_field: sub}, {"_id": 0})
        if u:
            upd = {}
            if name and not u.get("name"):
                upd["name"] = name
            if picture:
                upd["picture"] = picture
            if upd:
                await db.users.update_one({"user_id": u["user_id"]}, {"$set": upd})
                u = await db.users.find_one({"user_id": u["user_id"]}, {"_id": 0})
            return u, False

    if email:
        u = await db.users.find_one({"email": email}, {"_id": 0})
        if u:
            if not (u.get("email_verified_at") or email_verified):
                raise HTTPException(409, {"reason": "use_existing_method", "email": email})
            upd = {}
            if sub_field and sub and not u.get(sub_field):
                upd[sub_field] = sub
            if email_verified and not u.get("email_verified_at"):
                upd["email_verified_at"] = now_utc().isoformat()
            if name and not u.get("name"):
                upd["name"] = name
            if picture:
                upd["picture"] = picture
            if upd:
                await db.users.update_one({"user_id": u["user_id"]}, {"$set": upd})
                u = await db.users.find_one({"user_id": u["user_id"]}, {"_id": 0})
            return u, False

    user_id = f"user_{uuid.uuid4().hex[:12]}"
    is_first = (await db.users.count_documents({})) == 0
    doc = {
        "user_id": user_id,
        "email": email,
        "name": name or "",
        "picture": picture or "",
        "phone": "",
        "role": "admin" if is_first else "user",
        "password_hash": None,
        "email_verified_at": now_utc().isoformat() if email_verified else None,
        "email_opt_in": False,
        "news_opt_in": False,
        "promo_opt_in": False,
        "consent_at": None,
        "tos_accepted_at": now_utc().isoformat(),  # accepting ToS is implied by OAuth sign-in
        "policy_version": POLICY_VERSION,
        "created_at": now_utc().isoformat(),
    }
    # Only store provider-sub keys when present, so the Phase E sparse-unique index works.
    if sub_field and sub:
        doc[sub_field] = sub
    await db.users.insert_one(doc)
    return await db.users.find_one({"user_id": user_id}, {"_id": 0}), True


# ---------- Models (light-touch, we use dicts for storage) ----------

class RegisterIn(BaseModel):
    email: str
    password: str
    name: str = ""
    tos_accepted: bool = False
    email_opt_in: bool = False
    news_opt_in: bool = False
    promo_opt_in: bool = False


class LoginIn(BaseModel):
    email: str
    password: str


class ConsentsIn(BaseModel):
    email_opt_in: Optional[bool] = None
    news_opt_in: Optional[bool] = None
    promo_opt_in: Optional[bool] = None


class ForgotPasswordIn(BaseModel):
    email: str


class ResetPasswordIn(BaseModel):
    token: str
    new_password: str


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
    city: str = ""
    starts_at: str
    ends_at: Optional[str] = None
    doors_open_at: Optional[str] = None
    image_url: str = ""
    artist_ids: List[str] = []
    max_tickets_per_user: int = 4
    is_published: bool = False
    sold_out_message: str = ""
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

def _public_user(u: Optional[dict]) -> Optional[dict]:
    """Strip secret-bearing fields before returning a user to the client."""
    if not u:
        return u
    return {k: v for k, v in u.items() if k not in ("password_hash", "_id")}


@api.post("/auth/register", dependencies=[Depends(rate_limit("auth_register", 5, 300))])
async def register(body: RegisterIn, request: Request, response: Response):
    email = body.email.strip().lower()
    if not _valid_email(email):
        raise HTTPException(400, "Enter a valid email address")
    if len(body.password) < 8:
        raise HTTPException(400, "Password must be at least 8 characters")
    if not body.tos_accepted:
        raise HTTPException(400, "You must accept the Terms of Service")

    # Generic message on collision — never reveal whether an email is registered.
    if await db.users.find_one({"email": email}, {"_id": 1}):
        raise HTTPException(400, "Unable to register with those details")

    user_id = f"user_{uuid.uuid4().hex[:12]}"
    is_first = (await db.users.count_documents({})) == 0
    now_iso = now_utc().isoformat()
    doc = {
        "user_id": user_id,
        "email": email,
        "name": body.name.strip(),
        "picture": "",
        "phone": "",
        "role": "admin" if is_first else "user",
        "password_hash": hash_password(body.password),
        "email_verified_at": None,
        "email_opt_in": bool(body.email_opt_in),
        "news_opt_in": bool(body.news_opt_in),
        "promo_opt_in": bool(body.promo_opt_in),
        "consent_at": now_iso,
        "tos_accepted_at": now_iso,
        "policy_version": POLICY_VERSION,
        "created_at": now_iso,
    }
    await db.users.insert_one(doc)

    # Consent audit trail (one row per opt-in kind + the ToS acceptance).
    await _log_consent(user_id, "tos", True, request, "register")
    for kind in ("email_opt_in", "news_opt_in", "promo_opt_in"):
        await _log_consent(user_id, kind, doc[kind], request, "register")

    # Fire-and-forget verification email (outbox in dev).
    token = make_token("email-verify", user_id)
    await send_mail("verify_email", email, {"verify_url": f"{PUBLIC_APP_URL}/verify?token={token}"})

    await _issue_session(response, user_id)
    return {"user": _public_user(await db.users.find_one({"user_id": user_id}, {"_id": 0}))}


@api.post("/auth/login", dependencies=[Depends(rate_limit("auth_login", 10, 300))])
async def login(body: LoginIn, request: Request, response: Response, session_token: Optional[str] = Cookie(default=None)):
    email = body.email.strip().lower()
    _email_rate_check("auth_login_email", email, 10, 300)
    u = await db.users.find_one({"email": email}, {"_id": 0})
    # Same generic failure + verify-against-dummy timing for every failure mode:
    # missing user, OAuth-only account (no password_hash), or wrong password.
    if not u or not verify_password(body.password, u.get("password_hash")):
        if not u:
            verify_password(body.password, _DUMMY_HASH)
        raise HTTPException(401, "Invalid email or password")
    await _issue_session(response, u["user_id"], old_token=session_token)
    return {"user": _public_user(u)}


@api.get("/auth/methods")
async def auth_methods():
    """Which sign-in methods this deployment has configured — drives the login UI."""
    return {"password": True, "google": GOOGLE_ENABLED, "apple": APPLE_ENABLED}


@api.get("/auth/me")
async def auth_me(user=Depends(get_current_user)):
    return _public_user(user)


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
    return _public_user(await db.users.find_one({"user_id": user["user_id"]}, {"_id": 0}))


@api.post("/auth/consents")
async def update_consents(body: ConsentsIn, request: Request, user=Depends(get_current_user)):
    """Change marketing opt-ins. Separate from PATCH /auth/profile because each
    change must be written to the consent audit log with ip + policy version."""
    changes = {k: v for k, v in body.model_dump().items() if v is not None}
    if changes:
        changes["consent_at"] = now_utc().isoformat()
        await db.users.update_one({"user_id": user["user_id"]}, {"$set": changes})
        for kind, granted in changes.items():
            if kind == "consent_at":
                continue
            await _log_consent(user["user_id"], kind, granted, request, "settings")
    return _public_user(await db.users.find_one({"user_id": user["user_id"]}, {"_id": 0}))


# ----- Email verification + password reset -----

@api.post("/auth/request-verify", dependencies=[Depends(rate_limit("auth_verify_req", 3, 900))])
async def request_verify(user=Depends(get_current_user)):
    if user.get("email_verified_at"):
        return {"ok": True, "already_verified": True}
    token = make_token("email-verify", user["user_id"])
    await send_mail("verify_email", user["email"], {"verify_url": f"{PUBLIC_APP_URL}/verify?token={token}"})
    return {"ok": True}


@api.get("/auth/verify")
async def verify_email(token: str):
    try:
        claims = read_token("email-verify", token)
    except jwt.PyJWTError:
        raise HTTPException(400, "This verification link is invalid or has expired")
    await db.users.update_one(
        {"user_id": claims["sub"]},
        {"$set": {"email_verified_at": now_utc().isoformat()}},
    )
    return {"ok": True}


@api.post("/auth/forgot-password", dependencies=[Depends(rate_limit("auth_forgot", 5, 900))])
async def forgot_password(body: ForgotPasswordIn):
    email = body.email.strip().lower()
    u = await db.users.find_one({"email": email}, {"_id": 0})
    # Only send when a password account actually exists, but ALWAYS return ok
    # (no account enumeration).
    if u and u.get("password_hash"):
        token = make_token("pwd-reset", u["user_id"], {"ph": u["password_hash"][-12:]})
        await send_mail("password_reset", email, {"reset_url": f"{PUBLIC_APP_URL}/reset-password?token={token}"})
    return {"ok": True}


@api.post("/auth/reset-password", dependencies=[Depends(rate_limit("auth_reset", 5, 900))])
async def reset_password(body: ResetPasswordIn, response: Response):
    if len(body.new_password) < 8:
        raise HTTPException(400, "Password must be at least 8 characters")
    try:
        claims = read_token("pwd-reset", body.token)
    except jwt.PyJWTError:
        raise HTTPException(400, "This reset link is invalid or has expired")
    u = await db.users.find_one({"user_id": claims["sub"]}, {"_id": 0})
    # Single-use: the token is bound to the password hash it was minted against, so
    # any password change (or reuse of a spent token) invalidates it.
    if not u or not u.get("password_hash") or u["password_hash"][-12:] != claims.get("ph"):
        raise HTTPException(400, "This reset link is invalid or has expired")
    await db.users.update_one(
        {"user_id": u["user_id"]},
        {"$set": {"password_hash": hash_password(body.new_password)}},
    )
    # Global logout — invalidate every existing session for this user.
    await db.user_sessions.delete_many({"user_id": u["user_id"]})
    response.delete_cookie("session_token", path="/")
    return {"ok": True}


# ----- OAuth (Google + Apple), direct clients -----

_jwks_clients: dict = {}


def _jwks(url: str) -> "jwt.PyJWKClient":
    c = _jwks_clients.get(url)
    if c is None:
        c = jwt.PyJWKClient(url)
        _jwks_clients[url] = c
    return c


def _verify_google_id_token(id_token: str) -> dict:
    key = _jwks("https://www.googleapis.com/oauth2/v3/certs").get_signing_key_from_jwt(id_token)
    return jwt.decode(
        id_token, key.key, algorithms=["RS256"], audience=GOOGLE_CLIENT_ID,
        issuer=["https://accounts.google.com", "accounts.google.com"],
    )


def _verify_apple_id_token(id_token: str) -> dict:
    key = _jwks("https://appleid.apple.com/auth/keys").get_signing_key_from_jwt(id_token)
    return jwt.decode(
        id_token, key.key, algorithms=["RS256"], audience=APPLE_CLIENT_ID,
        issuer="https://appleid.apple.com",
    )


def _safe_return(path: Optional[str]) -> str:
    """Only allow same-site relative paths as post-login redirect targets —
    blocks open-redirect via the `return` param."""
    if not path or not path.startswith("/") or path.startswith("//"):
        return "/"
    return path


async def _oauth_finish(request, *, provider, email, name, picture, sub, email_verified, return_path, clear_cookies):
    try:
        user, created = await _get_or_create_user(
            email, name=name, picture=picture, provider=provider, sub=sub, email_verified=email_verified,
        )
    except HTTPException as e:
        if e.status_code == 409:
            resp = RedirectResponse(f"{PUBLIC_APP_URL}/login?error=use_existing_method", status_code=302)
            for c in clear_cookies:
                resp.delete_cookie(c, path="/")
            return resp
        raise
    resp = RedirectResponse(f"{PUBLIC_APP_URL}{_safe_return(return_path)}", status_code=302)
    await _issue_session(resp, user["user_id"])
    for c in clear_cookies:
        resp.delete_cookie(c, path="/")
    if created:
        await _log_consent(user["user_id"], "tos", True, request, f"oauth-{provider}")
    return resp


@api.get("/auth/google/start")
async def google_start(return_: str = Query("/", alias="return")):
    if not GOOGLE_ENABLED:
        raise HTTPException(404, "Not found")
    state = secrets.token_urlsafe(24)
    params = urlencode({
        "client_id": GOOGLE_CLIENT_ID,
        "redirect_uri": GOOGLE_REDIRECT_URI,
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "prompt": "select_account",
    })
    resp = RedirectResponse(f"https://accounts.google.com/o/oauth2/v2/auth?{params}", status_code=302)
    # Callback lands on our own origin, so SameSite=Lax is enough and survives the
    # top-level redirect back from Google.
    resp.set_cookie("g_state", state, max_age=600, httponly=True, secure=COOKIE_SECURE, samesite="lax", path="/")
    resp.set_cookie("g_return", _safe_return(return_), max_age=600, httponly=True, secure=COOKIE_SECURE, samesite="lax", path="/")
    return resp


@api.get("/auth/google/callback", dependencies=[Depends(rate_limit("oauth_google_cb", 20, 60))])
async def google_callback(
    request: Request,
    code: str = "",
    state: str = "",
    g_state: Optional[str] = Cookie(default=None),
    g_return: Optional[str] = Cookie(default=None),
):
    if not GOOGLE_ENABLED:
        raise HTTPException(404, "Not found")
    if not code or not state or not g_state or not secrets.compare_digest(state, g_state):
        raise HTTPException(400, "Invalid OAuth state")
    async with httpx.AsyncClient(timeout=15.0) as hc:
        tok = await hc.post("https://oauth2.googleapis.com/token", data={
            "code": code,
            "client_id": GOOGLE_CLIENT_ID,
            "client_secret": GOOGLE_CLIENT_SECRET,
            "redirect_uri": GOOGLE_REDIRECT_URI,
            "grant_type": "authorization_code",
        })
    if tok.status_code != 200:
        raise HTTPException(400, "Google token exchange failed")
    id_token = tok.json().get("id_token")
    if not id_token:
        raise HTTPException(400, "Google returned no id_token")
    try:
        claims = _verify_google_id_token(id_token)
    except jwt.PyJWTError:
        raise HTTPException(400, "Could not verify Google identity")
    return await _oauth_finish(
        request, provider="google",
        email=claims.get("email", ""), name=claims.get("name", ""), picture=claims.get("picture", ""),
        sub=claims.get("sub"), email_verified=bool(claims.get("email_verified")),
        return_path=g_return or "/", clear_cookies=("g_state", "g_return"),
    )


@api.get("/auth/apple/start")
async def apple_start(return_: str = Query("/", alias="return")):
    if not APPLE_ENABLED:
        raise HTTPException(404, "Not found")
    state = secrets.token_urlsafe(24)
    params = urlencode({
        "client_id": APPLE_CLIENT_ID,
        "redirect_uri": APPLE_REDIRECT_URI,
        "response_type": "code id_token",
        "response_mode": "form_post",
        "scope": "name email",
        "state": state,
    })
    resp = RedirectResponse(f"https://appleid.apple.com/auth/authorize?{params}", status_code=302)
    # Apple's callback is a cross-site POST, so the state cookie MUST be
    # SameSite=None; Secure (Apple only ever runs over HTTPS anyway).
    resp.set_cookie("a_state", state, max_age=600, httponly=True, secure=True, samesite="none", path="/")
    resp.set_cookie("a_return", _safe_return(return_), max_age=600, httponly=True, secure=True, samesite="none", path="/")
    return resp


@api.post("/auth/apple/callback", dependencies=[Depends(rate_limit("oauth_apple_cb", 20, 60))])
async def apple_callback(
    request: Request,
    id_token: str = Form(""),
    state: str = Form(""),
    user: str = Form(""),  # JSON {name:{firstName,lastName}, email} — first authorization ONLY
    a_state: Optional[str] = Cookie(default=None),
    a_return: Optional[str] = Cookie(default=None),
):
    if not APPLE_ENABLED:
        raise HTTPException(404, "Not found")
    if not id_token or not state or not a_state or not secrets.compare_digest(state, a_state):
        raise HTTPException(400, "Invalid OAuth state")
    try:
        claims = _verify_apple_id_token(id_token)
    except jwt.PyJWTError:
        raise HTTPException(400, "Could not verify Apple identity")
    email = claims.get("email", "")
    name = ""
    # Apple sends name/email in the form body only on the very first authorization.
    if user:
        try:
            u = json.loads(user)
            nm = u.get("name") or {}
            name = f"{nm.get('firstName', '')} {nm.get('lastName', '')}".strip()
            email = email or u.get("email", "")
        except (ValueError, TypeError):
            pass
    ev = claims.get("email_verified")
    return await _oauth_finish(
        request, provider="apple",
        email=email, name=name, picture="",
        sub=claims.get("sub"), email_verified=(ev is True or ev == "true"),
        return_path=a_return or "/", clear_cookies=("a_state", "a_return"),
    )


# ----- Data rights (GDPR: export + erasure) -----

@api.get("/auth/export", dependencies=[Depends(rate_limit("auth_export", 3, 3600))])
async def export_my_data(user=Depends(get_current_user)):
    """Machine-readable copy of everything tied to this account (GDPR art. 20)."""
    uid = user["user_id"]
    async def grab(coll, query):
        return await coll.find(query, {"_id": 0}).to_list(5000)

    bundle = {
        "exported_at": now_utc().isoformat(),
        "user": _public_user(user),
        "reservations": await grab(db.reservations, {"user_id": uid}),
        "tickets": await grab(db.tickets, {"user_id": uid}),
        "invoices": await grab(db.invoices, {"user_id": uid}),
        "payments": await grab(db.payment_transactions, {"user_id": uid}),
        "consent_log": await grab(db.consent_log, {"user_id": uid}),
        # session metadata only — tokens are omitted by the projection below
        "sessions": [
            {"created_at": s.get("created_at"), "expires_at": str(s.get("expires_at"))}
            for s in await db.user_sessions.find({"user_id": uid}, {"_id": 0, "session_token": 0}).to_list(500)
        ],
        "newsletter": await grab(db.newsletter_subscriptions, {"email": user["email"]}),
    }
    return Response(
        content=json.dumps(bundle, indent=2, default=str),
        media_type="application/json",
        headers={"Content-Disposition": "attachment; filename=supersanity-export.json"},
    )


@api.delete("/auth/account")
async def delete_my_account(request: Request, response: Response, user=Depends(get_current_user)):
    """Right to erasure. We anonymize rather than hard-delete: invoices and tickets
    must survive for fiscal/audit retention, but every piece of personal data on the
    account is scrubbed and all sessions killed."""
    uid = user["user_id"]
    if user.get("role") == "admin":
        # Don't let the last admin lock everyone out by deleting themselves.
        if await db.users.count_documents({"role": "admin"}) <= 1:
            raise HTTPException(400, "You are the only admin — assign another admin before deleting your account")

    await db.users.update_one(
        {"user_id": uid},
        {
            "$set": {
                "email": f"deleted+{uid}@anon.invalid",
                "name": "",
                "phone": "",
                "picture": "",
                "role": "user",
                "email_opt_in": False,
                "news_opt_in": False,
                "promo_opt_in": False,
                "deleted_at": now_utc().isoformat(),
            },
            "$unset": {"password_hash": "", "google_sub": "", "apple_sub": ""},
        },
    )
    await db.user_sessions.delete_many({"user_id": uid})
    await db.newsletter_subscriptions.update_many(
        {"email": user["email"]},
        {"$set": {"status": "unsubscribed", "unsubscribed_at": now_utc().isoformat()}},
    )
    await _log_consent(uid, "account_deleted", True, request, "self-service")
    await _audit(uid, "account_deleted", "user", uid, None)
    response.delete_cookie("session_token", path="/")
    return {"ok": True}


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
    # An event stays "upcoming" for its whole duration, not just until it starts —
    # judged by ends_at, falling back to starts_at only when no end time is set.
    if upcoming:
        query["$or"] = [
            {"ends_at": {"$gte": now_iso}},
            {"ends_at": None, "starts_at": {"$gte": now_iso}},
            {"ends_at": {"$exists": False}, "starts_at": {"$gte": now_iso}},
        ]
    else:
        query["$or"] = [
            {"ends_at": {"$lt": now_iso}},
            {"ends_at": None, "starts_at": {"$lt": now_iso}},
            {"ends_at": {"$exists": False}, "starts_at": {"$lt": now_iso}},
        ]
    items = await db.events.find(query, {"_id": 0}).sort("starts_at", 1 if upcoming else -1).to_list(200)
    # Batch-fetch albums for every listed event in one query instead of N+1,
    # so cards can show a cover photo without a per-event round trip.
    event_ids = [e["event_id"] for e in items]
    gallery_items = await db.gallery.find({"event_id": {"$in": event_ids}}, {"_id": 0}).sort("created_at", 1).to_list(2000)
    gallery_by_event = {}
    for g in gallery_items:
        gallery_by_event.setdefault(g["event_id"], []).append(g)
    for e in items:
        e["total_available"] = sum(max(0, w.get("available", w.get("capacity", 0))) for w in e.get("waves", []))
        e["gallery"] = gallery_by_event.get(e["event_id"], [])
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
    e["gallery"] = await db.gallery.find({"event_id": e["event_id"]}, {"_id": 0}).sort("created_at", 1).to_list(200)
    return e


@api.get("/gallery")
async def gallery():
    # Sitewide "Documentation" gallery only — event albums (event_id set) live
    # on their own event page instead.
    return await db.gallery.find({"event_id": None}, {"_id": 0}).to_list(200)


@api.get("/gallery/clusters")
async def gallery_clusters():
    """Powers the public Gallery page: standalone photos plus one cover tile
    per event album, so 100s of event photos don't flood the main grid."""
    standalone = await db.gallery.find({"event_id": None}, {"_id": 0}).sort("created_at", 1).to_list(200)

    event_items = await db.gallery.find({"event_id": {"$ne": None}}, {"_id": 0}).sort("created_at", 1).to_list(5000)
    by_event = {}
    for g in event_items:
        by_event.setdefault(g["event_id"], []).append(g)

    events = await db.events.find(
        {"event_id": {"$in": list(by_event.keys())}, "is_published": True},
        {"_id": 0, "event_id": 1, "title": 1, "slug": 1},
    ).to_list(500)

    event_albums = []
    for ev in events:
        items = by_event.get(ev["event_id"], [])
        if not items:
            continue
        event_albums.append({
            "event_id": ev["event_id"], "title": ev["title"], "slug": ev["slug"],
            "cover": items[0], "count": len(items), "items": items,
        })

    return {"standalone": standalone, "event_albums": event_albums}


class ContactMsg(BaseModel):
    name: str
    email: str
    message: str


@api.post("/contact", dependencies=[Depends(rate_limit("contact", 5, 60))])
async def contact(msg: ContactMsg):
    await db.contact_messages.insert_one({
        "id": new_id("msg"),
        "name": msg.name,
        "email": msg.email,
        "message": msg.message,
        "created_at": now_utc().isoformat(),
    })
    return {"ok": True}


# ---------- Newsletter ----------

class NewsletterIn(BaseModel):
    email: str
    source: Optional[str] = None  # optional label ("home hero", "footer", …)


class NewsletterUnsubIn(BaseModel):
    token: str


def _newsletter_status(s: dict) -> str:
    """Legacy subscribers predate the status field — treat an existing row with no
    status as already-confirmed so we don't silently drop them."""
    if s.get("unsubscribed_at"):
        return "unsubscribed"
    return s.get("status") or "confirmed"


@api.post("/newsletter", dependencies=[Depends(rate_limit("newsletter", 10, 60))])
async def newsletter_subscribe(body: NewsletterIn):
    email = body.email.strip().lower()
    if not _valid_email(email):
        raise HTTPException(400, "Invalid email")
    existing = await db.newsletter_subscriptions.find_one({"email": email}, {"_id": 0})
    if existing and _newsletter_status(existing) == "confirmed":
        return {"ok": True}  # never reveal subscription state
    if not existing:
        await db.newsletter_subscriptions.insert_one({
            "sub_id": new_id("sub"),
            "email": email,
            "source": body.source or "",
            "status": "pending",
            "created_at": now_utc().isoformat(),
            "confirmed_at": None,
            "unsubscribed_at": None,
        })
    else:
        # Re-subscribe / re-confirm a pending or previously unsubscribed address.
        await db.newsletter_subscriptions.update_one(
            {"email": email},
            {"$set": {"status": "pending", "unsubscribed_at": None}},
        )
    # Double opt-in: nothing is "subscribed" until the confirm link is clicked.
    token = make_token("news-confirm", email)
    unsub = make_token("news-unsub", email)
    unsub_url = f"{PUBLIC_APP_URL}/newsletter/unsubscribe?token={unsub}"
    await send_mail("newsletter_confirm", email, {
        "confirm_url": f"{PUBLIC_APP_URL}/newsletter/confirm?token={token}",
        "headers": {"List-Unsubscribe": f"<{unsub_url}>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"},
    })
    return {"ok": True}


@api.get("/newsletter/confirm")
async def newsletter_confirm(token: str):
    try:
        claims = read_token("news-confirm", token)
    except jwt.PyJWTError:
        raise HTTPException(400, "This confirmation link is invalid or has expired")
    email = claims["sub"]
    await db.newsletter_subscriptions.update_one(
        {"email": email},
        {"$set": {"status": "confirmed", "confirmed_at": now_utc().isoformat(), "unsubscribed_at": None}},
    )
    return {"ok": True}


@api.post("/newsletter/unsubscribe", dependencies=[Depends(rate_limit("newsletter_unsub", 30, 60))])
async def newsletter_unsubscribe(body: NewsletterUnsubIn):
    try:
        claims = read_token("news-unsub", body.token)
    except jwt.PyJWTError:
        raise HTTPException(400, "This unsubscribe link is invalid or has expired")
    # Idempotent — safe to click twice.
    await db.newsletter_subscriptions.update_one(
        {"email": claims["sub"]},
        {"$set": {"status": "unsubscribed", "unsubscribed_at": now_utc().isoformat()}},
    )
    return {"ok": True}


@api.get("/admin/newsletter")
async def admin_list_newsletter(user=Depends(require_admin_or_editor)):
    return await db.newsletter_subscriptions.find({}, {"_id": 0}).sort("created_at", -1).to_list(2000)


@api.get("/admin/newsletter.csv")
async def admin_export_newsletter(user=Depends(require_admin_or_editor)):
    from fastapi.responses import PlainTextResponse
    subs = await db.newsletter_subscriptions.find({}, {"_id": 0}).sort("created_at", 1).to_list(20000)
    # Use the stdlib CSV writer so commas/quotes/newlines and spreadsheet formula
    # injection (=, +, -, @) in the source field can't corrupt or weaponize the file.
    buf = io.StringIO()
    w = csv.writer(buf, quoting=csv.QUOTE_MINIMAL)
    w.writerow(["email", "source", "status", "created_at", "confirmed_at", "unsubscribed_at"])
    for s in subs:
        src = s.get("source", "") or ""
        if src and src[0] in ("=", "+", "-", "@"):
            src = "'" + src  # neutralize spreadsheet formula injection
        w.writerow([s.get("email", ""), src, _newsletter_status(s),
                    s.get("created_at", ""), s.get("confirmed_at") or "", s.get("unsubscribed_at") or ""])
    return PlainTextResponse(buf.getvalue(), headers={"Content-Disposition": "attachment; filename=newsletter.csv"})


@api.delete("/admin/newsletter/{sub_id}")
async def admin_delete_subscription(sub_id: str, user=Depends(get_current_user)):
    if user.get("role") not in ("admin", "editor"):
        raise HTTPException(403, "Editor access required")
    r = await db.newsletter_subscriptions.delete_one({"sub_id": sub_id})
    if r.deleted_count == 0:
        raise HTTPException(404, "Subscription not found")
    await _audit(user["user_id"], "newsletter_delete", "newsletter", sub_id, None)
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


@api.post("/reservations", dependencies=[Depends(rate_limit("reservations", 20, 60))])
async def create_reservation(body: ReserveIn, user=Depends(get_current_user)):
    if body.quantity < 1:
        raise HTTPException(400, "Invalid quantity")

    event = await db.events.find_one({"event_id": body.event_id}, {"_id": 0})
    if not event or not event.get("is_published"):
        raise HTTPException(404, "Event not found")

    await _cleanup_expired_reservations(body.event_id)
    event = await db.events.find_one({"event_id": body.event_id}, {"_id": 0})

    await _enforce_user_ticket_cap(event, user["user_id"], body.quantity)
    wave = _find_wave(event, body.wave_id)
    unit_price, special = await _resolve_pricing_source(body, event, wave)
    discount_percent, discount_code_used = await _apply_discount(body, using_special=bool(special))

    subtotal = unit_price * body.quantity
    discount_amount = subtotal * (discount_percent / 100.0)
    total = round(subtotal - discount_amount, 2)

    # Deduct from wave availability (only if not a special link).
    if not special:
        await _atomic_hold_wave_stock(body.event_id, body.wave_id, body.quantity)

    doc = {
        "reservation_id": new_id("res"),
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
        "expires_at": (now_utc() + timedelta(minutes=HOLD_MINUTES)).isoformat(),
        "created_at": now_utc().isoformat(),
    }
    await db.reservations.insert_one(doc)
    return {**{k: v for k, v in doc.items() if k != "_id"}, "hold_minutes": HOLD_MINUTES}


async def _enforce_user_ticket_cap(event, user_id: str, quantity: int):
    """Raise 400 if adding `quantity` tickets would exceed the event's per-user cap."""
    max_per_user = event.get("max_tickets_per_user", 4)
    existing = await db.tickets.count_documents({"event_id": event["event_id"], "user_id": user_id})
    pending_docs = await db.reservations.find(
        {"event_id": event["event_id"], "user_id": user_id, "status": "pending"}, {"_id": 0, "quantity": 1}
    ).to_list(50)
    pending_qty = sum(r["quantity"] for r in pending_docs)
    if existing + pending_qty + quantity > max_per_user:
        raise HTTPException(400, f"Ticket limit reached ({max_per_user} per user)")


def _find_wave(event, wave_id: str):
    for w in event.get("waves", []):
        if w["wave_id"] == wave_id:
            return w
    raise HTTPException(404, "Wave not found")


async def _resolve_pricing_source(body: "ReserveIn", event, wave):
    """Return (unit_price, special_doc_or_None). Validates special link or wave window/capacity."""
    now_iso = now_utc().isoformat()
    if body.special_link_token:
        special = await db.special_links.find_one(
            {"token": body.special_link_token, "event_id": body.event_id}, {"_id": 0}
        )
        if not special:
            raise HTTPException(400, "Invalid special link")
        if special.get("used", 0) + body.quantity > special["capacity"]:
            raise HTTPException(400, "Special link capacity exceeded")
        return float(special["price_ron"]), special
    # Regular wave path: enforce sale window + inventory hint (atomic decrement will re-check)
    if not (wave["starts_at"] <= now_iso <= wave["ends_at"]):
        raise HTTPException(400, "Wave not active")
    if wave.get("available", wave["capacity"]) < body.quantity:
        raise HTTPException(400, "Not enough tickets available")
    return float(wave["price_ron"]), None


async def _apply_discount(body: "ReserveIn", using_special: bool):
    """Return (percent_off, code_string) or (0, None). Raises 400 on invalid/expired/exhausted."""
    if not body.discount_code or using_special:
        return 0, None
    now_iso = now_utc().isoformat()
    code = await db.discounts.find_one({"code": body.discount_code.upper()}, {"_id": 0})
    if not code:
        raise HTTPException(400, "Invalid discount code")
    if code.get("event_id") and code["event_id"] != body.event_id:
        raise HTTPException(400, "Discount not valid for this event")
    if code.get("expires_at") and code["expires_at"] < now_iso:
        raise HTTPException(400, "Discount code expired")
    if code.get("max_uses", 0) > 0 and code.get("uses", 0) >= code["max_uses"]:
        raise HTTPException(400, "Discount code exhausted")
    return int(code["percent_off"]), code["code"]


async def _atomic_hold_wave_stock(event_id: str, wave_id: str, quantity: int):
    """Atomically decrement wave availability. Raises 400 if not enough stock at write-time."""
    upd = await db.events.update_one(
        {
            "event_id": event_id,
            "waves": {"$elemMatch": {"wave_id": wave_id, "available": {"$gte": quantity}}},
        },
        {"$inc": {"waves.$.available": -quantity}},
    )
    if upd.modified_count != 1:
        raise HTTPException(400, "Failed to hold tickets (sold out)")


@api.get("/reservations/{reservation_id}")
async def get_reservation(reservation_id: str, user=Depends(get_current_user)):
    r = await db.reservations.find_one({"reservation_id": reservation_id, "user_id": user["user_id"]}, {"_id": 0})
    if not r:
        raise HTTPException(404, "Not found")
    return r


async def _stripe_customer_id(user: dict) -> str:
    """Get-or-create the user's Stripe customer, persisting the id on the user doc."""
    if user.get("stripe_customer_id"):
        return user["stripe_customer_id"]
    cust = await asyncio.to_thread(
        stripe_sdk.Customer.create, email=user["email"], name=user.get("name") or None,
        metadata={"user_id": user["user_id"]},
    )
    await db.users.update_one({"user_id": user["user_id"]}, {"$set": {"stripe_customer_id": cust.id}})
    return cust.id


@api.post("/checkout")
async def create_checkout(body: CheckoutIn, request: Request, user=Depends(get_current_user)):
    r = await db.reservations.find_one({"reservation_id": body.reservation_id, "user_id": user["user_id"]}, {"_id": 0})
    if not r:
        raise HTTPException(404, "Reservation not found")
    if r["status"] != "pending":
        raise HTTPException(400, f"Reservation is {r['status']}")
    if parse_dt(r["expires_at"]) < now_utc():
        raise HTTPException(400, "Reservation expired")

    origin = body.origin_url.rstrip("/")
    success_url = f"{origin}/checkout/success?session_id={{CHECKOUT_SESSION_ID}}"
    cancel_url = f"{origin}/checkout/cancel?reservation_id={r['reservation_id']}"
    metadata = {"reservation_id": r["reservation_id"], "user_id": user["user_id"], "event_id": r["event_id"]}
    total = float(r["total_ron"])
    customer_id = None

    if PAYMENTS_MODE == "fake":
        # Local simulation: no Stripe account needed. The success page then polls
        # /payments/status, which finalizes the reservation.
        session_id = f"cs_local_{uuid.uuid4().hex}"
        checkout_url = f"{success_url.replace('{CHECKOUT_SESSION_ID}', session_id)}&mock=1"
    else:
        event = await db.events.find_one({"event_id": r["event_id"]}, {"_id": 0, "title": 1})
        customer_id = await _stripe_customer_id(user)
        session = await asyncio.to_thread(
            stripe_sdk.checkout.Session.create,
            mode="payment",
            customer=customer_id,
            line_items=[{
                "price_data": {
                    "currency": "ron",
                    "unit_amount": int(round(total * 100)),
                    "product_data": {"name": (event or {}).get("title", "Supersanity ticket")},
                },
                "quantity": 1,
            }],
            success_url=success_url,
            cancel_url=cancel_url,
            metadata=metadata,
            payment_intent_data={"metadata": metadata},
        )
        session_id = session.id
        checkout_url = session.url

    await db.payment_transactions.insert_one({
        "session_id": session_id,
        "reservation_id": r["reservation_id"],
        "user_id": user["user_id"],
        "amount": total,
        "currency": "ron",
        "payment_status": "initiated",
        "created_at": now_utc().isoformat(),
    })
    await db.reservations.update_one(
        {"reservation_id": r["reservation_id"]},
        {"$set": {"stripe_session_id": session_id, "stripe_customer_id": customer_id}},
    )
    return {"url": checkout_url, "session_id": session_id}


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
        qr = f"SNTY-{uuid.uuid4().hex[:20].upper()}"
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
        "series": "SNTY",
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

    # Deliver tickets by email (transactional — no marketing opt-in needed). QR PNGs
    # are attached. Wrapped so a mail failure never rolls back a paid order.
    try:
        buyer = await db.users.find_one({"user_id": r["user_id"]}, {"_id": 0, "email": 1})
        event = await db.events.find_one({"event_id": r["event_id"]}, {"_id": 0, "title": 1, "starts_at": 1, "venue": 1, "city": 1})
        if buyer and buyer.get("email"):
            attachments = []
            for t in tickets:
                img = qrcode.make(t["qr_code"])
                b = io.BytesIO()
                img.save(b, format="PNG")
                attachments.append({"filename": f"{t['qr_code']}.png", "content": b.getvalue()})
            await send_mail("ticket_delivery", buyer["email"], {
                "tickets": [{"qr_code": t["qr_code"], "wave": t.get("wave_id", "")} for t in tickets],
                "event": {
                    "title": (event or {}).get("title", ""),
                    "when": (event or {}).get("starts_at", ""),
                    "where": ", ".join(filter(None, [(event or {}).get("venue"), (event or {}).get("city")])),
                },
                "invoice_no": next_num,
                "attachments": attachments,
            })
    except Exception:
        logger.exception("ticket delivery email failed for reservation %s", reservation_id)


@api.get("/payments/status/{session_id}")
async def payment_status(session_id: str, request: Request):
    tx = await db.payment_transactions.find_one({"session_id": session_id}, {"_id": 0})
    if not tx:
        raise HTTPException(404, "Transaction not found")
    if tx["payment_status"] == "paid":
        return tx

    if PAYMENTS_MODE == "fake":
        # Simulated success: mark paid and run the real finalize path.
        new_status, session_status = "paid", "complete"
    else:
        session = await asyncio.to_thread(stripe_sdk.checkout.Session.retrieve, session_id)
        new_status = "paid" if session.payment_status == "paid" else session.payment_status
        session_status = session.status

    await db.payment_transactions.update_one(
        {"session_id": session_id},
        {"$set": {"payment_status": new_status, "status": session_status}},
    )
    if new_status == "paid":
        await _finalize_paid_reservation(tx["reservation_id"])
    return await db.payment_transactions.find_one({"session_id": session_id}, {"_id": 0})


async def _mark_paid_and_finalize(session_id: str):
    tx = await db.payment_transactions.find_one({"session_id": session_id}, {"_id": 0})
    if not tx:
        return
    await db.payment_transactions.update_one(
        {"session_id": session_id}, {"$set": {"payment_status": "paid"}},
    )
    await _finalize_paid_reservation(tx["reservation_id"])


@api.post("/webhook/stripe")
async def stripe_webhook(request: Request):
    body = await request.body()

    if PAYMENTS_MODE == "fake":
        # Dev-only shim so the webhook path is exercisable without Stripe. Accepts a
        # plain JSON {session_id, payment_status}. Refused entirely in stripe mode.
        try:
            payload = json.loads(body)
        except ValueError:
            raise HTTPException(400, "Invalid payload")
        if payload.get("payment_status") == "paid" and payload.get("session_id"):
            await _mark_paid_and_finalize(payload["session_id"])
        return {"received": True}

    sig = request.headers.get("Stripe-Signature", "")
    try:
        event = stripe_sdk.Webhook.construct_event(body, sig, STRIPE_WEBHOOK_SECRET)
    except (ValueError, stripe_sdk.error.SignatureVerificationError):
        raise HTTPException(400, "Invalid signature")

    # Idempotency: a unique index on event_id makes replays a no-op.
    try:
        await db.processed_stripe_events.insert_one({"event_id": event["id"], "at": now_utc().isoformat()})
    except Exception:
        return {"received": True, "duplicate": True}

    if event["type"] in ("checkout.session.completed", "checkout.session.async_payment_succeeded"):
        obj = event["data"]["object"]
        if obj.get("payment_status") == "paid":
            await _mark_paid_and_finalize(obj["id"])
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
    c.drawString(40, H - 60, "SUPERSANITY")
    c.setFont("Helvetica", 9)
    c.drawString(40, H - 75, "Bucharest, Romania · VAT compliant invoice")
    c.setFont("Helvetica-Bold", 14)
    c.drawString(40, H - 120, f"INVOICE {inv['series']}-{inv['number']:06d}")
    c.setFont("Helvetica", 10)
    c.drawString(40, H - 138, f"Issued: {inv['issued_at'][:19].replace('T', ' ')} UTC")
    c.drawString(40, H - 155, f"Bill to: {buyer.get('name', '')} <{buyer.get('email', '')}>")
    c.drawString(40, H - 172, f"Event: {ev.get('title', '')}")
    venue_line = ", ".join(filter(None, [ev.get("venue", ""), ev.get("city", "")]))
    c.drawString(40, H - 189, f"Venue: {venue_line}")

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
    await _audit(user["user_id"], "event_delete", "event", event_id, None)
    return {"ok": True}


@api.post("/admin/events/{event_id}/cancel")
async def admin_cancel_event(event_id: str, user=Depends(require_admin)):
    await db.events.update_one({"event_id": event_id}, {"$set": {"is_published": False, "cancelled": True}})
    # Refund policy: mark tickets as refunded (real refund via Stripe would happen out-of-band)
    await db.tickets.update_many({"event_id": event_id, "status": "issued"}, {"$set": {"status": "refunded"}})
    await _audit(user["user_id"], "event_cancel", "event", event_id, None)
    return {"ok": True}


@api.get("/admin/orders")
async def admin_orders(user=Depends(require_admin)):
    return await db.reservations.find({}, {"_id": 0}).sort("created_at", -1).limit(500).to_list(500)


@api.post("/admin/orders/{reservation_id}/refund")
async def admin_refund(reservation_id: str, user=Depends(require_admin)):
    await db.reservations.update_one({"reservation_id": reservation_id}, {"$set": {"status": "refunded"}})
    await db.tickets.update_many({"reservation_id": reservation_id}, {"$set": {"status": "refunded"}})
    await _audit(user["user_id"], "order_refund", "reservation", reservation_id, None)
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
    return await db.users.find({}, {"_id": 0, "password_hash": 0}).to_list(500)


@api.patch("/admin/users/{user_id}/role")
async def admin_set_role(user_id: str, body: dict, user=Depends(require_admin)):
    role = body.get("role")
    if role not in ("user", "admin", "door", "editor"):
        raise HTTPException(400, "Invalid role")
    target = await db.users.find_one({"user_id": user_id}, {"_id": 0, "role": 1})
    old_role = target.get("role") if target else None
    # Guard against demoting the last admin into lockout.
    if old_role == "admin" and role != "admin" and await db.users.count_documents({"role": "admin"}) <= 1:
        raise HTTPException(400, "Cannot demote the only admin")
    await db.users.update_one({"user_id": user_id}, {"$set": {"role": role}})
    await _audit(user["user_id"], "role_change", "user", user_id, {"from": old_role, "to": role})
    return {"ok": True}


@api.get("/admin/audit")
async def admin_audit(limit: int = 100, skip: int = 0, user=Depends(require_admin)):
    limit = max(1, min(limit, 500))
    items = await db.audit_log.find({}, {"_id": 0}).sort("at", -1).skip(skip).limit(limit).to_list(limit)
    return items


@api.get("/admin/gallery")
async def admin_gallery(event_id: Optional[str] = None, user=Depends(require_admin)):
    # No event_id -> the sitewide "Documentation" gallery tab; with one -> that event's album.
    query = {"event_id": event_id if event_id else None}
    return await db.gallery.find(query, {"_id": 0}).sort("created_at", 1).to_list(500)


class GalleryIn(BaseModel):
    image_url: str
    thumbnail_url: str = ""
    caption: str = ""
    media_type: str = "image"
    event_id: Optional[str] = None


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


@api.post("/admin/uploads")
async def admin_upload_media(file: UploadFile = File(...), user=Depends(require_admin)):
    content_type = file.content_type or ""
    if content_type in IMAGE_CONTENT_TYPES:
        media_type, ext = "image", IMAGE_CONTENT_TYPES[content_type]
    elif content_type in VIDEO_CONTENT_TYPES:
        media_type, ext = "video", VIDEO_CONTENT_TYPES[content_type]
    else:
        raise HTTPException(400, "Unsupported file type — images (JPEG/PNG/WebP/GIF) or video (MP4/WebM/MOV) only")

    data = await file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(400, "File too large (max 25MB)")

    file_id = uuid.uuid4().hex
    (UPLOAD_DIR / f"{file_id}{ext}").write_bytes(data)

    thumbnail_url = None
    if media_type == "image":
        try:
            img = Image.open(io.BytesIO(data))
            img = img.convert("RGB")
            img.thumbnail((640, 640))
            thumb_name = f"{file_id}_thumb.jpg"
            img.save(UPLOAD_DIR / thumb_name, "JPEG", quality=82)
            thumbnail_url = f"/uploads/{thumb_name}"
        except Exception:
            logger.exception("Thumbnail generation failed for upload %s", file_id)

    return {
        "url": f"/uploads/{file_id}{ext}",
        "thumbnail_url": thumbnail_url or f"/uploads/{file_id}{ext}",
        "media_type": media_type,
    }


# ---------- Seed ----------

@api.post("/seed")
async def seed_demo(user=Depends(require_admin)):
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

from cms_routes import register_cms_routes  # noqa: E402
register_cms_routes(api, db, require_admin, require_admin_or_editor)

from mailer import init_mailer, send_mail  # noqa: E402
init_mailer(db, logger)

app.include_router(api)

# CORS. Credentialed requests (cookies) can NEVER be paired with a wildcard origin —
# browsers reject it, and silently-broken auth is worse than a loud failure. In
# production we refuse to start on a wildcard/empty origin list; in dev we fall back
# to the known frontend origin.
_cors_origins = [o.strip() for o in os.environ.get("CORS_ORIGINS", "").split(",") if o.strip()]
if "*" in _cors_origins or not _cors_origins:
    if APP_ENV == "production":
        raise RuntimeError("CORS_ORIGINS must be an explicit allowlist in production (no '*') when cookies are used")
    _cors_origins = [PUBLIC_APP_URL]
    logger.warning("CORS_ORIGINS not pinned — defaulting to %s for dev", PUBLIC_APP_URL)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=_cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def bootstrap_admin():
    """Promote INITIAL_ADMIN_EMAIL (if set) to admin role on every startup.
    Kills the 'first-user-becomes-admin' race that hit us when test users
    were seeded before the real admin signed in."""
    if not INITIAL_ADMIN_EMAIL:
        return
    result = await db.users.update_one(
        {"email": INITIAL_ADMIN_EMAIL},
        {"$set": {"role": "admin"}},
    )
    if result.matched_count:
        logger.info("Bootstrapped %s to admin", INITIAL_ADMIN_EMAIL)


@app.on_event("startup")
async def init_indexes():
    """Create indexes idempotently on boot.

    The session TTL index needs expires_at stored as a real BSON date; older sessions
    wrote ISO strings, so migrate those first or the TTL monitor silently ignores them.
    """
    try:
        async for s in db.user_sessions.find({"expires_at": {"$type": "string"}}, {"session_token": 1, "expires_at": 1}):
            dt = parse_dt(s["expires_at"])
            if dt:
                await db.user_sessions.update_one({"_id": s["_id"]}, {"$set": {"expires_at": dt}})

        await db.user_sessions.create_index("expires_at", expireAfterSeconds=0)
        await db.user_sessions.create_index("session_token", unique=True)
        await db.users.create_index("email", unique=True)
        # Partial (not sparse) unique: only enforce uniqueness on docs that actually
        # have a provider sub, so many null/absent values don't collide.
        await db.users.create_index("google_sub", unique=True, partialFilterExpression={"google_sub": {"$type": "string"}})
        await db.users.create_index("apple_sub", unique=True, partialFilterExpression={"apple_sub": {"$type": "string"}})
        await db.processed_stripe_events.create_index("event_id", unique=True)
        await db.newsletter_subscriptions.create_index("email", unique=True)
        logger.info("Indexes ensured")
    except Exception:
        logger.exception("init_indexes failed")


@app.on_event("shutdown")
async def shutdown():
    client.close()
