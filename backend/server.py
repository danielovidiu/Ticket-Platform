"""
Supersanity - Ticketing platform backend
FastAPI + MongoDB, first-party auth (password + Google/Apple OAuth) + Stripe Checkout
"""
import io
import os
import re
import csv
import json
import uuid
import base64
import secrets
import hashlib
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
from urllib.parse import urlencode, quote
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo import ReturnDocument
from pydantic import BaseModel, Field
from PIL import Image
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.pdfgen import canvas
from starlette.middleware.cors import CORSMiddleware
# Simple in-memory sliding-window rate limiter. Enough for a single-node MVP.
# For multi-node prod, swap for a Redis-backed limiter (this one is per-process, so N
# workers currently means N times the configured allowance).
#
# SECURITY [H2 — fixed]: this dict used to grow without bound. Keys were created per
# (bucket, ip) and per (bucket, email) and never removed — `popleft()` drained the expired
# timestamps but left the empty deque and its key behind forever. Combined with H1 below,
# where the caller chooses its own key, that was a straightforward memory-exhaustion DoS.
# It is now bounded two ways: a periodic sweep drops keys whose window has fully expired,
# and each bucket has a hard key cap with LRU eviction as a backstop against a burst that
# outruns the sweep.
#
# SECURITY [H1 — fixed]: the client IP used to be read straight from `X-Forwarded-For`
# with no trusted-proxy check, so any caller could pick its own bucket and bypass every
# limit outright (reproduced: 14/14 requests accepted against a 10/60s limit by rotating
# the header). Forwarding headers are now believed only when TRUSTED_IP_HEADER names one
# — see the note on that constant below.
from collections import defaultdict, deque, OrderedDict
from threading import Lock

# Per bucket. 10k keys x a short deque is a few MB — enough headroom for real traffic
# from a large NAT, small enough that filling it is not a denial of service.
RATE_LIMIT_MAX_KEYS = 10_000
RATE_LIMIT_SWEEP_SECONDS = 60

_rate_buckets: dict = defaultdict(OrderedDict)   # bucket -> {key: deque[timestamps]}
_rate_windows: dict = {}                         # bucket -> window, for the sweep
_rate_last_sweep = 0.0
_rate_lock = Lock()


def _sweep_rate_buckets(now: float):
    """Drop keys with nothing left inside their window. Caller must hold _rate_lock.

    Runs at most once every RATE_LIMIT_SWEEP_SECONDS: the work is proportional to the
    number of live keys, and doing it on every request would hand an attacker a cheap way
    to burn CPU.
    """
    global _rate_last_sweep
    if now - _rate_last_sweep < RATE_LIMIT_SWEEP_SECONDS:
        return
    _rate_last_sweep = now
    for bucket, keys in _rate_buckets.items():
        window = _rate_windows.get(bucket, 3600)
        dead = [k for k, dq in keys.items() if not dq or dq[-1] <= now - window]
        for k in dead:
            del keys[k]


def _rate_check(bucket: str, key: str, max_calls: int, window_seconds: int):
    """Record a hit against (bucket, key). Returns retry_after seconds if over the
    limit, else None. Caller must hold _rate_lock."""
    _rate_windows[bucket] = max(_rate_windows.get(bucket, 0), window_seconds)
    now = datetime.now(timezone.utc).timestamp()
    _sweep_rate_buckets(now)

    keys = _rate_buckets[bucket]
    dq = keys.get(key)
    if dq is None:
        # Backstop for a burst that arrives faster than the sweep: evict least-recently
        # used. An attacker can still push honest clients out of the table, but that
        # costs them their own rate limiting too, and memory stays flat either way.
        while len(keys) >= RATE_LIMIT_MAX_KEYS:
            keys.popitem(last=False)
        dq = keys[key] = deque()
    keys.move_to_end(key)  # LRU ordering

    while dq and dq[0] < now - window_seconds:
        dq.popleft()
    if len(dq) >= max_calls:
        return int(window_seconds - (now - dq[0])) + 1
    dq.append(now)
    return None


# SECURITY [H1 — fixed]: which header, if any, may be believed when it claims to carry
# the client's IP. A forwarding header is only trustworthy when something in front of the
# app overwrites it on every request; otherwise the caller picks its own value and with it
# its own rate-limit bucket. So nothing is trusted unless it is named here:
#
#   unset (default)             direct exposure or local dev — use the socket peer.
#   x-vercel-forwarded-for      on Vercel. The platform sets it itself and discards any
#                               client-supplied copy, so it cannot be spoofed.
#   x-forwarded-for             behind your own nginx/ALB — ONLY if that proxy replaces
#                               the header rather than appending to it, and the app is
#                               unreachable except through it.
#
# Note this is deliberately not `x-forwarded-for` by default. That was the old behaviour
# and it made every limit in the app bypassable by rotating the header, which turned
# /api/newsletter and /api/auth/forgot-password into mail-bomb amplifiers.
TRUSTED_IP_HEADER = os.environ.get("TRUSTED_IP_HEADER", "").strip().lower()


def _client_ip(request: Optional[Request]) -> str:
    """The caller's IP, or "" when it cannot be established.

    Used both for rate-limit bucketing and as the evidence recorded in the consent log,
    so a spoofable value here is worth more than it looks.
    """
    if request is None:
        return ""
    if TRUSTED_IP_HEADER:
        # Left-most entry is the original client; the proxy appends itself to the right.
        forwarded = request.headers.get(TRUSTED_IP_HEADER, "").split(",")[0].strip()
        if forwarded:
            return forwarded
    return request.client.host if request.client else ""


def rate_limit(key: str, max_calls: int, window_seconds: int):
    """Returns a FastAPI dependency that raises 429 when exceeded."""
    async def _dep(request: Request):
        ip = _client_ip(request) or "unknown"
        with _rate_lock:
            retry_after = _rate_check(key, ip, max_calls, window_seconds)
        if retry_after is not None:
            raise HTTPException(
                status_code=429,
                detail=f"Too many requests. Try again in {retry_after}s.",
                headers={"Retry-After": str(retry_after)},
            )
    return _dep

import asyncio
import stripe as stripe_sdk

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

# Imported after load_dotenv, not with the other imports at the top: storage picks its
# backend from BLOB_READ_WRITE_TOKEN at import time, and on a laptop that variable comes
# from .env rather than the real environment.
import storage  # noqa: E402

MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]
STRIPE_API_KEY = os.environ.get("STRIPE_API_KEY", "").strip()
STRIPE_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET", "").strip()
INITIAL_ADMIN_EMAIL = os.environ.get("INITIAL_ADMIN_EMAIL", "").strip().lower()

APP_ENV = os.environ.get("APP_ENV", "development").strip().lower()

# True when running as short-lived function instances rather than one long-lived process.
# Vercel sets VERCEL=1 in every build and runtime environment; set it by hand on another
# serverless host. It only changes lifecycle assumptions (see the shutdown hook), never
# behaviour a request can observe.
SERVERLESS = bool(os.environ.get("VERCEL", "").strip())

# Which build is running, for GET /api/health. Vercel injects VERCEL_GIT_COMMIT_SHA on
# every deployment; GIT_COMMIT is the portable fallback to set by hand elsewhere (a
# Dockerfile ARG, a CI variable). Empty means "nobody told us", which the endpoint
# reports as-is rather than guessing.
COMMIT_SHA = (os.environ.get("VERCEL_GIT_COMMIT_SHA")
              or os.environ.get("GIT_COMMIT") or "").strip()

# Public origin of the FRONTEND (where OAuth callbacks and email links send users
# back to). Its scheme also decides how session cookies are scoped (below).
PUBLIC_APP_URL = os.environ.get("PUBLIC_APP_URL", "http://localhost:3000").rstrip("/")
POLICY_VERSION = os.environ.get("POLICY_VERSION", "2026-07-22")

# Feature flag for the mandatory phone number. OFF by default: an account needs a first
# name and a surname, and the phone is collected but optional. Set REQUIRE_PHONE=1 to
# make it mandatory everywhere at once — registration, the profile form, and the
# "profile complete" rule the frontend gate and the reservation check both read. A
# number that IS entered is validated either way; the flag only decides whether leaving
# it blank is allowed. Turning it on later makes every phone-less account incomplete,
# and those users are asked for one the next time they sign in.
REQUIRE_PHONE = os.environ.get("REQUIRE_PHONE", "").strip() == "1"

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("supersanity")

# ---------- Payment mode (fails closed) ----------
# Two modes. "stripe" uses the real SDK and requires a webhook signing secret. "fake"
# simulates the whole reserve→pay→finalize loop with no Stripe account, so a fresh
# checkout is usable immediately.
#
# SECURITY [C1]: the fake simulator finalizes orders through two UNAUTHENTICATED
# endpoints (`payment_status` and `stripe_webhook`), so reaching it in production means
# giving away tickets. It used to be selected silently whenever STRIPE_API_KEY was
# absent or malformed — a typo in the key was enough. It is now opt-in only:
#
#   LOCAL_FAKE_PAYMENTS=1   -> fake, and refused outright under APP_ENV=production
#   STRIPE_API_KEY=sk_...   -> stripe (STRIPE_WEBHOOK_SECRET then mandatory)
#   neither                 -> hard startup failure in production; loud warning in dev
#
# There is deliberately no path where a missing or malformed key quietly downgrades a
# production deployment to the simulator.
if os.environ.get("LOCAL_FAKE_PAYMENTS", "").strip() == "1":
    if APP_ENV == "production":
        raise RuntimeError(
            "LOCAL_FAKE_PAYMENTS=1 is a development-only simulator that issues tickets "
            "without payment, and it exposes unauthenticated order-finalizing endpoints. "
            "It cannot be used with APP_ENV=production."
        )
    PAYMENTS_MODE = "fake"
elif STRIPE_API_KEY.startswith("sk_"):
    PAYMENTS_MODE = "stripe"
elif APP_ENV == "production":
    raise RuntimeError(
        "STRIPE_API_KEY must be a live 'sk_...' key when APP_ENV=production. Refusing to "
        "start: without one the app would fall back to the fake payment simulator and "
        "hand out tickets for free."
    )
else:
    PAYMENTS_MODE = "fake"
    logger.warning(
        "No STRIPE_API_KEY set — using the FAKE payment simulator. Orders finalize with "
        "no payment and no authentication. Development only; this is refused in production."
    )

if PAYMENTS_MODE == "stripe":
    stripe_sdk.api_key = STRIPE_API_KEY
    if not STRIPE_WEBHOOK_SECRET:
        raise RuntimeError("STRIPE_WEBHOOK_SECRET is required when running live Stripe payments")

# SESSION_SECRET signs all our stateless tokens (email verification, password reset,
# newsletter confirm/unsubscribe). It is REQUIRED in production; in dev we fall back to
# an ephemeral secret so a fresh checkout still boots (tokens just don't survive a restart).
SESSION_SECRET = os.environ.get("SESSION_SECRET", "").strip()
if not SESSION_SECRET:
    if APP_ENV == "production":
        raise RuntimeError("SESSION_SECRET is required when APP_ENV=production")
    if SERVERLESS:
        # The dev fallback below mints a secret per process. One uvicorn on a laptop has
        # exactly one of those; a serverless deployment has one per instance, so a
        # verification or reset link signed by the instance that sent the email is
        # rejected by whichever instance the user's click lands on. It would fail
        # intermittently, look like a token-expiry bug, and never reproduce locally.
        raise RuntimeError(
            "SESSION_SECRET must be set on a serverless host, regardless of APP_ENV: "
            "instances do not share an ephemeral secret, so email-verification, "
            "password-reset and newsletter links would validate only by coincidence. "
            'Generate one with: python -c "import secrets; print(secrets.token_hex(32))"'
        )
    SESSION_SECRET = "dev-insecure-" + secrets.token_hex(16)
    logger.warning("SESSION_SECRET not set — using an ephemeral dev secret; tokens reset on restart")

# Session cookie scoping is derived from the frontend scheme. Cross-site HTTPS needs
# SameSite=None; Secure; plain-http localhost needs Lax + insecure or browsers drop it.
#
# SECURITY [M3]: SameSite=None means the session cookie IS sent on cross-site requests,
# and there is no CSRF token or Origin check anywhere in this app. JSON bodies are
# protected only incidentally (they force a CORS preflight the allowlist rejects), but
# multipart/form-data is CORS-safelisted and needs no preflight — see /admin/uploads.
# Prefer SameSite=Lax whenever the frontend is same-site, and add an Origin check on
# state-changing routes regardless.
#
# SECURITY [M1]: no security response headers are set anywhere in this app — no HSTS,
# CSP, X-Frame-Options, nosniff, or Referrer-Policy. The Referrer-Policy gap matters most
# because email-verification and password-reset tokens travel in the URL query string.
COOKIE_SECURE = PUBLIC_APP_URL.startswith("https://")
# The default below assumes the API is on a different origin from the frontend, which is
# what "none" is for. When they are the SAME origin — the Vercel services layout serves
# the frontend and /api from one domain — that assumption is wrong and needlessly costly:
# SameSite=None means the session cookie rides along on cross-site requests, and this app
# has no CSRF token or Origin check to catch them (M3). Set COOKIE_SAMESITE=lax there.
COOKIE_SAMESITE = os.environ.get("COOKIE_SAMESITE", "").strip().lower() or (
    "none" if COOKIE_SECURE else "lax"
)
if COOKIE_SAMESITE not in {"lax", "strict", "none"}:
    raise RuntimeError(f"COOKIE_SAMESITE must be lax, strict or none (got {COOKIE_SAMESITE!r})")
if COOKIE_SAMESITE == "none" and not COOKIE_SECURE:
    raise RuntimeError("COOKIE_SAMESITE=none requires an https PUBLIC_APP_URL; browsers drop the cookie otherwise")

# OAuth providers — each is fully optional. A provider whose vars are unset simply
# doesn't appear in GET /auth/methods and its start/callback endpoints return 404.
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "").strip()
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET", "").strip()
GOOGLE_REDIRECT_URI = os.environ.get("GOOGLE_REDIRECT_URI", "").strip()
GOOGLE_ENABLED = bool(GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI)

APPLE_CLIENT_ID = os.environ.get("APPLE_CLIENT_ID", "").strip()      # Services ID
# STALE: TEAM_ID / KEY_ID / PRIVATE_KEY exist to sign the client-secret JWT for Apple's
# token endpoint, but this flow uses response_type="code id_token" and only ever verifies
# the id_token — the code is never exchanged, so none of these three are used anywhere.
# They are required-but-inert: they gate APPLE_ENABLED below and nothing else. Either
# drop them from the gate, or implement the code exchange that needs them.
APPLE_TEAM_ID = os.environ.get("APPLE_TEAM_ID", "").strip()
APPLE_KEY_ID = os.environ.get("APPLE_KEY_ID", "").strip()
APPLE_PRIVATE_KEY = os.environ.get("APPLE_PRIVATE_KEY", "").strip()  # .p8 contents
APPLE_REDIRECT_URI = os.environ.get("APPLE_REDIRECT_URI", "").strip()
APPLE_ENABLED = bool(APPLE_CLIENT_ID and APPLE_TEAM_ID and APPLE_KEY_ID and APPLE_PRIVATE_KEY and APPLE_REDIRECT_URI)

# Pool sizing matters on serverless hosts, where "one app" is really N short-lived
# instances that each open their own pool. Motor's default ceiling of 100 sockets per
# instance will exhaust an Atlas cluster's connection allowance (500 on M0/M10) after a
# handful of concurrent instances, and the symptom is connection errors under load rather
# than anything obviously pool-shaped. A single request only ever needs a couple of
# sockets, so cap it low and let the instance count do the scaling.
MONGO_MAX_POOL_SIZE = int(os.environ.get("MONGO_MAX_POOL_SIZE", "5"))
client = AsyncIOMotorClient(
    MONGO_URL,
    maxPoolSize=MONGO_MAX_POOL_SIZE,
    # Fail fast rather than sitting on a request until the platform's own timeout kills
    # it — a misconfigured MONGO_URL or a missing Atlas IP allowlist entry should surface
    # as a prompt 500, not a 60-second hang.
    serverSelectionTimeoutMS=int(os.environ.get("MONGO_SERVER_SELECTION_TIMEOUT_MS", "5000")),
)
db = client[DB_NAME]

app = FastAPI(title="Supersanity API")
api = APIRouter(prefix="/api")

# Uploaded media lives in Vercel Blob when BLOB_READ_WRITE_TOKEN is set, and on local
# disk otherwise — see storage.py. The /uploads mount exists only in the local case:
# under Blob the stored URLs are absolute and served by Vercel's CDN, and creating or
# mounting a directory inside a read-only function bundle would abort the cold start.
if storage.is_local():
    UPLOAD_DIR = storage.ensure_local_dir()
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


# ---------- Session tokens ----------

def _hash_token(token: str) -> str:
    """What actually goes in the database for a session.

    SECURITY [M2]: session tokens are bearer credentials — whoever holds one *is* the
    user. Storing them verbatim made `user_sessions` a credential store, so any read of
    that collection (backup, log, dump) handed over every live session including admins'.
    Hashing means a leaked database contains nothing replayable.

    Plain SHA-256, deliberately, not bcrypt: the input is 256 bits of `secrets`-grade
    randomness, so there is no dictionary to attack and nothing for a slow KDF to buy —
    and this runs on every authenticated request, where bcrypt's cost would be a
    self-inflicted DoS.
    """
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _presented_token(session_token: Optional[str], authorization: Optional[str]) -> Optional[str]:
    """The session token on this request: cookie first, then `Authorization: Bearer`.

    Both call sites must agree on this. They did not: `get_current_user` accepted either,
    but `logout` looked only at the cookie — so a Bearer-authenticated client (mobile, a
    script, our own test fixtures) got `200 {"ok": true}` from logout while its session
    stayed valid server-side. A logout that reports success without revoking anything is
    worse than one that fails loudly.
    """
    if session_token:
        return session_token
    if authorization and authorization.startswith("Bearer "):
        return authorization.split(" ", 1)[1]
    return None


# ---------- Auth ----------
# SECURITY — TRUST BOUNDARY. Everything below this line decides *who the caller is* and
# *what they may do*. `get_current_user` is the only place a request becomes an identity;
# the three `require_*` helpers are the only authorization gates in the application. A
# route with none of them as a dependency is public by definition — check that this is
# intended before adding one.


async def get_current_user(
    request: Request,
    session_token: Optional[str] = Cookie(default=None),
    authorization: Optional[str] = Header(default=None),
):
    token = _presented_token(session_token, authorization)
    if not token:
        raise HTTPException(401, "Not authenticated")

    # SECURITY [M2]: match on the hash — the plaintext token is never stored.
    session = await db.user_sessions.find_one({"session_token": _hash_token(token)}, {"_id": 0})
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


def _initial_role(email: str) -> str:
    """Role a brand-new account starts with.

    SECURITY [H3 — fixed]: this used to be "admin if you are the first row in the users
    collection". On a fresh public deploy that handed full admin to whoever registered
    first, and the INITIAL_ADMIN_EMAIL startup bootstrap re-promoted the intended
    operator WITHOUT demoting the squatter. Arrival order is now irrelevant: admin comes
    only from configuration, and every other account starts as "user". Do not reintroduce
    a count-based rule here.
    """
    if INITIAL_ADMIN_EMAIL and (email or "").strip().lower() == INITIAL_ADMIN_EMAIL:
        return "admin"
    return "user"


def _valid_email(email: str) -> bool:
    # SECURITY [M12]: deliberately loose, but it does NOT reject CR/LF. That is safe only
    # because the mailer talks JSON to Resend; it would become header injection the moment
    # anything builds SMTP headers from this value. Reject \r and \n here rather than
    # relying on the transport.
    email = (email or "").strip()
    return "@" in email and "." in email.split("@")[-1] and 3 <= len(email) <= 254


# Every account must carry a first name and a last name, plus a phone number when
# REQUIRE_PHONE is on. Email and password (or an OAuth identity) are handled separately —
# these are the fields a provider can't always give us, so they are what "profile
# complete" means.
_PHONE_SEPARATORS = re.compile(r"[\s\-().]")
_PHONE_RE = re.compile(r"^\+?[0-9]{7,15}$")


def _normalize_phone(phone: str) -> str:
    """Strip the separators people type and keep an optional leading +.

    Returns "" when the result isn't a plausible phone number, so callers can treat
    falsy as invalid. Stored normalized, so the same number is always the same value.
    """
    cleaned = _PHONE_SEPARATORS.sub("", (phone or "").strip())
    return cleaned if _PHONE_RE.match(cleaned) else ""


def _full_name(first: str, last: str) -> str:
    """The single display name kept alongside the parts, because tickets, invoices,
    the Stripe customer and the admin lists all want one string."""
    return " ".join(p for p in ((first or "").strip(), (last or "").strip()) if p)


def _split_name(name: str) -> tuple:
    """Best-effort first/last split for a legacy or provider-supplied single name.
    Everything after the first token is the surname ("Ana Maria Popescu" -> Ana Maria
    is wrong far less often than dropping the middle name entirely)."""
    parts = (name or "").strip().split()
    if not parts:
        return "", ""
    if len(parts) == 1:
        return parts[0], ""
    return parts[0], " ".join(parts[1:])


def _profile_complete(u: Optional[dict]) -> bool:
    """Read REQUIRE_PHONE at call time, not import time, so flipping the flag needs
    only a restart — and so tests can exercise both settings."""
    if not u:
        return False
    fields = ("first_name", "last_name", "phone") if REQUIRE_PHONE else ("first_name", "last_name")
    return all((u.get(f) or "").strip() for f in fields)


def _validate_phone(raw: str) -> str:
    """Normalized phone, or "" when the field was left blank and that is allowed.

    Two separate rules, easy to conflate: whether a phone number is REQUIRED is the
    feature flag's business, but whether a number someone actually typed is plausible
    is not — a typo is rejected either way rather than silently stored.
    """
    raw = (raw or "").strip()
    phone = _normalize_phone(raw)
    if not phone and (raw or REQUIRE_PHONE):
        raise HTTPException(400, "Enter a valid phone number, e.g. +40 721 234 567")
    return phone


def _email_rate_check(bucket: str, email: str, max_calls: int, window: int):
    """Per-email sibling of rate_limit() (which keys on IP). Guards password login
    against distributed brute force of one account from many IPs.

    Shares _rate_check so this table is bounded too — it is keyed on attacker-supplied
    email addresses, so it was the easier half of the H2 memory-exhaustion problem.
    """
    with _rate_lock:
        retry_after = _rate_check(bucket, (email or "").strip().lower(), max_calls, window)
    if retry_after is not None:
        raise HTTPException(429, "Too many attempts. Try again later.",
                            headers={"Retry-After": str(retry_after)})


async def _issue_session(response: Response, user_id: str, old_token: Optional[str] = None) -> str:
    """Create a fresh opaque session, set the cookie, and rotate out any prior
    session token (defeats fixation). expires_at is a real datetime so the Phase E
    TTL index can reap it server-side.

    SECURITY [M2 — fixed]: only the SHA-256 of the token is persisted. The plaintext
    exists in the user's cookie and nowhere else, so a read-only exposure of
    `user_sessions` (a backup, a dump, an injection) no longer yields usable sessions.
    Lookups hash the presented token and match on that — see `_hash_token`.
    """
    if old_token:
        await db.user_sessions.delete_one({"session_token": _hash_token(old_token)})
    token = secrets.token_urlsafe(32)
    await db.user_sessions.insert_one({
        "user_id": user_id,
        "session_token": _hash_token(token),
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


def _identity_name_updates(u: dict, first: str, last: str) -> dict:
    """Fields to fill in on an existing account from what a provider just told us.

    Only ever fills blanks: a name the user typed themselves outranks the one on their
    Google profile. The single `name` is rebuilt whenever a part changes, so the two
    representations can't drift.
    """
    upd = {}
    if first and not (u.get("first_name") or "").strip():
        upd["first_name"] = first
    if last and not (u.get("last_name") or "").strip():
        upd["last_name"] = last
    if upd or not (u.get("name") or "").strip():
        merged = _full_name(upd.get("first_name", u.get("first_name", "")),
                            upd.get("last_name", u.get("last_name", "")))
        if merged:
            upd["name"] = merged
    return upd


async def _get_or_create_user(email, *, name="", first_name="", last_name="", picture="",
                              provider=None, sub=None, email_verified=False):
    """OAuth identity resolution + the verified-email account-linking gate.

    Match order: provider `sub` first (survives email changes / Apple private relay),
    then email. Email-based auto-linking is allowed ONLY when the existing account's
    email is already verified OR the incoming IdP asserts the email is verified —
    otherwise a stranger who pre-registered the victim's address with a password could
    be silently merged into. Returns (user_doc, created_bool). Raises 409 on a blocked
    link so the frontend can tell the user to use their original method.

    Providers give us name parts (Google's given_name/family_name, Apple's first
    authorization payload) but never a phone number, so an account created here starts
    profile-incomplete and the frontend collects the rest — see _profile_complete.
    """
    email = (email or "").strip().lower()
    sub_field = {"google": "google_sub", "apple": "apple_sub"}.get(provider)
    # Fall back to splitting the display name when the provider sent no separate parts.
    if not (first_name or last_name):
        first_name, last_name = _split_name(name)
    name = name or _full_name(first_name, last_name)

    if sub_field and sub:
        u = await db.users.find_one({sub_field: sub}, {"_id": 0})
        if u:
            upd = _identity_name_updates(u, first_name, last_name)
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
            upd = _identity_name_updates(u, first_name, last_name)
            if sub_field and sub and not u.get(sub_field):
                upd[sub_field] = sub
            if email_verified and not u.get("email_verified_at"):
                upd["email_verified_at"] = now_utc().isoformat()
            if picture:
                upd["picture"] = picture
            if upd:
                await db.users.update_one({"user_id": u["user_id"]}, {"$set": upd})
                u = await db.users.find_one({"user_id": u["user_id"]}, {"_id": 0})
            return u, False

    user_id = f"user_{uuid.uuid4().hex[:12]}"
    doc = {
        "user_id": user_id,
        "email": email,
        "name": name or "",
        "first_name": first_name or "",
        "last_name": last_name or "",
        "picture": picture or "",
        "phone": "",
        "role": _initial_role(email),  # SECURITY [H3]: config, never arrival order
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
    first_name: str = ""
    last_name: str = ""
    phone: str = ""
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
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    phone: Optional[str] = None


class ResendVerifyIn(BaseModel):
    email: str


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
    # When holders of *this* tier may start entering. Per-tier rather than
    # per-event, so VIP/early-bird can be granted earlier access than general.
    access_from: Optional[str] = None


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
    """Strip secret-bearing fields before returning a user to the client.

    The two booleans are derived rather than stored, so the client never has to know
    which combination of fields means "still needs to finish signing up".
    """
    if not u:
        return u
    out = {k: v for k, v in u.items() if k not in ("password_hash", "_id")}
    out["email_verified"] = bool(u.get("email_verified_at"))
    out["profile_complete"] = _profile_complete(u)
    return out


async def _send_verification(user_id: str, email: str):
    token = make_token("email-verify", user_id)
    await send_mail("verify_email", email, {"verify_url": f"{PUBLIC_APP_URL}/verify?token={token}"})


@api.get("/health", dependencies=[Depends(rate_limit("health", 60, 60))])
async def health():
    """Which build is live, and whether its migrations have run against this database.

    Answering "is the fix deployed?" previously meant inspecting the deployment in the
    Vercel dashboard and probing an endpoint that only exists after the commit you care
    about. This turns it into one request.

    The two version fields are the useful part. `schema_version_expected` is the constant
    compiled into the running code; `schema_version` is what the database records having
    completed. Equal means init finished and every migration behind that number has run.
    Expected ahead of actual means the new code is live but has not yet cold-started into
    its migrations — which is exactly the window where a backfill looks like it failed.

    Deliberately unauthenticated, so it works from a monitor with no session, and
    deliberately narrow for the same reason: nothing here describes how the app is
    configured. PAYMENTS_MODE in particular stays out — it is the single most useful
    thing an attacker could learn, because the fake-payment fallback issues real tickets
    for free (audit C1), and it is verified from the deployment's own environment
    variables rather than from the open internet.

    SCHEMA_VERSION is defined further down the module; the lookup happens per request, by
    which point it exists.
    """
    recorded = None
    db_ok = True
    try:
        marker = await db.app_meta.find_one({"_id": "init"}, {"_id": 0, "version": 1})
        recorded = (marker or {}).get("version")
    except Exception:
        # A health check that 500s tells a monitor less than one that says which half is
        # broken: the process is clearly up, or this handler would not be running.
        logger.exception("health: could not read the init marker")
        db_ok = False

    return {
        "ok": db_ok and recorded == SCHEMA_VERSION,
        "commit": COMMIT_SHA,
        "schema_version": recorded,
        "schema_version_expected": SCHEMA_VERSION,
        "db": db_ok,
    }


@api.post("/auth/register", dependencies=[Depends(rate_limit("auth_register", 5, 300))])
async def register(body: RegisterIn, request: Request, response: Response):
    email = body.email.strip().lower()
    first_name = body.first_name.strip()
    last_name = body.last_name.strip()
    if not first_name:
        raise HTTPException(400, "Enter your first name")
    if not last_name:
        raise HTTPException(400, "Enter your surname")
    if not _valid_email(email):
        raise HTTPException(400, "Enter a valid email address")
    phone = _validate_phone(body.phone)
    if len(body.password) < 8:
        raise HTTPException(400, "Password must be at least 8 characters")
    if not body.tos_accepted:
        raise HTTPException(400, "You must accept the Terms of Service")

    # Generic message on collision — never reveal whether an email is registered.
    if await db.users.find_one({"email": email}, {"_id": 1}):
        raise HTTPException(400, "Unable to register with those details")

    user_id = f"user_{uuid.uuid4().hex[:12]}"
    now_iso = now_utc().isoformat()
    doc = {
        "user_id": user_id,
        "email": email,
        "name": _full_name(first_name, last_name),
        "first_name": first_name,
        "last_name": last_name,
        "picture": "",
        "phone": phone,
        "role": _initial_role(email),  # SECURITY [H3]: config, never arrival order
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

    # Ticking "email me about upcoming events" at signup puts the address on the
    # newsletter list as pending; verifying the account promotes it to confirmed.
    if doc["news_opt_in"]:
        await _sync_newsletter_subscription(email, True, source="register", confirmed=False)

    # Fire-and-forget verification email (outbox in dev).
    await _send_verification(user_id, email)

    # Deliberately NO session: an account is unusable until the emailed link is clicked
    # (see the same gate in login()). Returning the address lets the client show
    # "check your inbox" and offer a resend without asking for it again.
    return {"ok": True, "verification_required": True, "email": email}


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
    # Unverified accounts get no session at all. The credentials were correct, so saying
    # so leaks nothing an attacker who just guessed the password doesn't already know,
    # and the alternative — a generic error — strands the legitimate owner.
    # No mail is sent from here: this path is reachable ten times per window per address,
    # and re-sending on each attempt would turn a login form into a mail amplifier. The
    # client offers a resend button, which goes through the tighter /auth/resend-verification.
    if not u.get("email_verified_at"):
        raise HTTPException(403, {"reason": "email_not_verified", "email": email})
    await _issue_session(response, u["user_id"], old_token=session_token)
    return {"user": _public_user(u)}


@api.get("/auth/methods")
async def auth_methods():
    """What this deployment expects at the door — drives the login and signup UI.

    `require_phone` rides along rather than living on its own endpoint: the signup form
    needs it at exactly the moment it already fetches this, and a second round trip
    would just mean the phone field renders with the wrong label first.
    """
    return {"password": True, "google": GOOGLE_ENABLED, "apple": APPLE_ENABLED,
            "require_phone": REQUIRE_PHONE}


@api.get("/auth/me")
async def auth_me(user=Depends(get_current_user)):
    return _public_user(user)


@api.post("/auth/logout")
async def logout(
    response: Response,
    session_token: Optional[str] = Cookie(default=None),
    authorization: Optional[str] = Header(default=None),
):
    # Resolve the token the same way get_current_user does. Reading only the cookie meant
    # Bearer clients were told they had logged out while the session stayed live.
    token = _presented_token(session_token, authorization)
    if token:
        await db.user_sessions.delete_one({"session_token": _hash_token(token)})
    response.delete_cookie("session_token", path="/")
    return {"ok": True}


@api.patch("/auth/profile")
async def update_profile(body: ProfileUpdate, user=Depends(get_current_user)):
    """Also the "finish your profile" endpoint.

    The mandatory fields are validated on the MERGED result rather than only on what was
    sent — a partial patch can fill a blank but can never empty one, and an OAuth account
    that arrived without a phone number is completed through exactly the same route as an
    edit from Settings.
    """
    patch = body.model_dump()
    first = (patch["first_name"] if patch["first_name"] is not None else user.get("first_name", "")).strip()
    last = (patch["last_name"] if patch["last_name"] is not None else user.get("last_name", "")).strip()
    raw_phone = patch["phone"] if patch["phone"] is not None else user.get("phone", "")

    if not first:
        raise HTTPException(400, "Enter your first name")
    if not last:
        raise HTTPException(400, "Enter your surname")
    phone = _validate_phone(raw_phone)

    await db.users.update_one(
        {"user_id": user["user_id"]},
        {"$set": {"first_name": first, "last_name": last, "phone": phone,
                  "name": _full_name(first, last)}},
    )
    return _public_user(await db.users.find_one({"user_id": user["user_id"]}, {"_id": 0}))


async def _sync_newsletter_subscription(email: str, granted: bool, *, source: str, confirmed: bool):
    """Keep the newsletter subscriber list in step with an account's news_opt_in flag.

    These used to be two disconnected things: `news_opt_in` is a consent flag on the user
    document, while the admin Newsletter tab lists `newsletter_subscriptions`, which only
    the public signup form ever wrote to — so ticking Newsletter in Settings subscribed
    the user to nothing anybody could see or export.

    `confirmed` is what distinguishes the two entry points. A signed-in user ticking the
    box has, by definition, a verified address (login requires it), so there is nothing
    for a double opt-in email to prove and the row goes straight in as confirmed. Ticking
    it during registration lands as pending, and verify_email promotes it.

    An existing confirmed row is never downgraded — a user who confirmed through the
    public form should not be knocked back to pending by an unrelated consent edit.
    """
    email = (email or "").strip().lower()
    if not email:
        return
    now_iso = now_utc().isoformat()

    if not granted:
        await db.newsletter_subscriptions.update_one(
            {"email": email},
            {"$set": {"status": "unsubscribed", "unsubscribed_at": now_iso}},
        )
        return

    existing = await db.newsletter_subscriptions.find_one({"email": email}, {"_id": 0, "status": 1, "unsubscribed_at": 1})
    if existing and _newsletter_status(existing) == "confirmed":
        return

    set_fields = {"status": "confirmed" if confirmed else "pending", "source": source, "unsubscribed_at": None}
    insert_fields = {"sub_id": new_id("sub"), "email": email, "created_at": now_iso}
    # confirmed_at belongs to exactly one of the two operators — Mongo rejects a field
    # that appears in both $set and $setOnInsert.
    if confirmed:
        set_fields["confirmed_at"] = now_iso
    else:
        insert_fields["confirmed_at"] = None

    await db.newsletter_subscriptions.update_one(
        {"email": email}, {"$set": set_fields, "$setOnInsert": insert_fields}, upsert=True,
    )


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
        if "news_opt_in" in changes:
            await _sync_newsletter_subscription(
                user["email"], changes["news_opt_in"], source="settings",
                confirmed=bool(user.get("email_verified_at")),
            )
    return _public_user(await db.users.find_one({"user_id": user["user_id"]}, {"_id": 0}))


# ----- Email verification + password reset -----

@api.post("/auth/request-verify", dependencies=[Depends(rate_limit("auth_verify_req", 3, 900))])
async def request_verify(user=Depends(get_current_user)):
    if user.get("email_verified_at"):
        return {"ok": True, "already_verified": True}
    await _send_verification(user["user_id"], user["email"])
    return {"ok": True}


@api.post("/auth/resend-verification", dependencies=[Depends(rate_limit("auth_verify_resend", 5, 900))])
async def resend_verification(body: ResendVerifyIn):
    """Unauthenticated sibling of /auth/request-verify.

    Needed because an unverified account has no session to authenticate with — that is
    the whole point of the gate in login(). Always returns ok, and is rate-limited per
    address as well as per IP, so it can't be used to enumerate accounts or to mail-bomb
    one.
    """
    email = body.email.strip().lower()
    _email_rate_check("auth_verify_resend_email", email, 3, 900)
    u = await db.users.find_one({"email": email}, {"_id": 0, "user_id": 1, "email_verified_at": 1})
    if u and not u.get("email_verified_at"):
        await _send_verification(u["user_id"], email)
    return {"ok": True}


@api.get("/auth/verify")
async def verify_email(token: str):
    try:
        claims = read_token("email-verify", token)
    except jwt.PyJWTError:
        raise HTTPException(400, "This verification link is invalid or has expired")
    u = await db.users.find_one({"user_id": claims["sub"]}, {"_id": 0})
    if not u:
        raise HTTPException(400, "This verification link is invalid or has expired")
    if not u.get("email_verified_at"):
        await db.users.update_one(
            {"user_id": u["user_id"]},
            {"$set": {"email_verified_at": now_utc().isoformat()}},
        )
        # A newsletter opt-in taken at registration was held as pending until exactly
        # this moment — the address is now proven.
        if u.get("news_opt_in"):
            await _sync_newsletter_subscription(u["email"], True, source="register", confirmed=True)
    # No session is issued here on purpose — clicking a link out of an inbox proves the
    # address, not that the person at this browser owns the account. They sign in next.
    return {"ok": True, "email": u["email"], "profile_complete": _profile_complete(u)}


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


async def _oauth_finish(request, *, provider, email, name, first_name="", last_name="", picture,
                        sub, email_verified, return_path, clear_cookies):
    try:
        user, created = await _get_or_create_user(
            email, name=name, first_name=first_name, last_name=last_name, picture=picture,
            provider=provider, sub=sub, email_verified=email_verified,
        )
    except HTTPException as e:
        if e.status_code == 409:
            resp = RedirectResponse(f"{PUBLIC_APP_URL}/login?error=use_existing_method", status_code=302)
            for c in clear_cookies:
                resp.delete_cookie(c, path="/")
            return resp
        raise
    # Same rule as password login: no session until the address is confirmed. Providers
    # normally assert email_verified, so this only fires for the ones that don't.
    if not user.get("email_verified_at"):
        await _send_verification(user["user_id"], user["email"])
        resp = RedirectResponse(
            f"{PUBLIC_APP_URL}/login?error=email_not_verified&email={quote(user['email'])}", status_code=302)
        for c in clear_cookies:
            resp.delete_cookie(c, path="/")
        return resp
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
        email=claims.get("email", ""), name=claims.get("name", ""),
        # Google returns the parts separately, which is exactly what the account needs —
        # splitting the display name is only the fallback inside _get_or_create_user.
        first_name=(claims.get("given_name") or "").strip(),
        last_name=(claims.get("family_name") or "").strip(),
        picture=claims.get("picture", ""),
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
    first_name = last_name = ""
    # Apple sends name/email in the form body only on the very first authorization.
    if user:
        try:
            u = json.loads(user)
            nm = u.get("name") or {}
            first_name = (nm.get("firstName") or "").strip()
            last_name = (nm.get("lastName") or "").strip()
            email = email or u.get("email", "")
        except (ValueError, TypeError):
            pass
    ev = claims.get("email_verified")
    return await _oauth_finish(
        request, provider="apple",
        email=email, name=_full_name(first_name, last_name),
        first_name=first_name, last_name=last_name, picture="",
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
                "first_name": "",
                "last_name": "",
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
    gallery_items = await db.gallery.find({"event_id": {"$in": event_ids}}, {"_id": 0}).sort([("sort_order", 1), ("created_at", 1)]).to_list(2000)
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
    e["gallery"] = await db.gallery.find({"event_id": e["event_id"]}, {"_id": 0}).sort([("sort_order", 1), ("created_at", 1)]).to_list(200)
    return e


@api.get("/gallery")
async def gallery():
    # Sitewide "Documentation" gallery only — event albums (event_id set) live
    # on their own event page instead.
    return await db.gallery.find({"event_id": None}, {"_id": 0}).sort([("sort_order", 1), ("created_at", 1)]).to_list(200)


# ----- Sitewide gallery identity (title + slug) -----
#
# One document, not a collection: there is exactly one sitewide gallery, and its title
# and slug are what the public page shows and lives at (/gallery/<slug>). Event albums
# keep taking their title and slug from the event they belong to.

GALLERY_SETTINGS_DEFAULT = {"title": "Gallery", "slug": "gallery", "description": ""}
_SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def _slugify(value: str) -> str:
    """Lowercase, ASCII-ish, hyphen-separated. Accepts what an editor types
    ("Live Documentation") and returns what a URL needs ("live-documentation")."""
    s = re.sub(r"[^a-z0-9]+", "-", (value or "").strip().lower())
    return s.strip("-")


async def _gallery_settings() -> dict:
    """Stored values over defaults, ignoring blanks so a half-written document can't
    leave the public page with no title or an empty URL."""
    doc = await db.site_settings.find_one({"_id": "gallery"}, {"_id": 0}) or {}
    merged = dict(GALLERY_SETTINGS_DEFAULT)
    for k in merged:
        v = doc.get(k)
        if isinstance(v, str) and (v.strip() or k == "description"):
            merged[k] = v.strip()
    return merged


@api.get("/gallery/settings")
async def gallery_settings():
    return await _gallery_settings()


def _album_cover(items: List[dict]) -> dict:
    """The explicitly chosen cover, else the first item in the album's order."""
    return next((g for g in items if g.get("is_cover")), items[0])


@api.get("/gallery/clusters")
async def gallery_clusters():
    """Powers the public Gallery page: standalone photos plus one cover tile
    per event album, so 100s of event photos don't flood the main grid."""
    standalone = await db.gallery.find({"event_id": None}, {"_id": 0}).sort([("sort_order", 1), ("created_at", 1)]).to_list(200)

    event_items = await db.gallery.find({"event_id": {"$ne": None}}, {"_id": 0}).sort([("sort_order", 1), ("created_at", 1)]).to_list(5000)
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
            "cover": _album_cover(items), "count": len(items), "items": items,
        })

    # Settings ride along so the page renders its heading and canonical URL from one
    # request instead of flashing a placeholder title while a second one lands.
    return {"standalone": standalone, "event_albums": event_albums,
            "settings": await _gallery_settings()}


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

    # The server-side half of the mandatory-profile rule. The UI redirects to the
    # completion form long before this, but sessions predating the rule (and any direct
    # API caller) reach checkout without a name or a phone number to put on the ticket.
    if not user.get("email_verified_at"):
        raise HTTPException(403, {"reason": "email_not_verified", "email": user.get("email", "")})
    if not _profile_complete(user):
        raise HTTPException(403, {"reason": "profile_incomplete"})

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
    """Raise 400 if adding `quantity` tickets would exceed the event's per-user cap.

    SECURITY [M5 — TOCTOU]: the count below and the reservation insert that follows are
    not atomic, so concurrent requests all observe the same pre-state and all pass. The
    anti-scalping cap is therefore advisory under concurrency.
    """
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
        # SECURITY [M4 — TOCTOU]: this reads `used`, but `used` is only incremented in
        # _finalize_paid_reservation. Nothing holds capacity across the reserve→pay window,
        # so N concurrent reservations all pass this check and can all be paid — the link
        # oversells. Contrast _atomic_hold_wave_stock() below, which does this correctly
        # with a conditional $inc. This path needs the same treatment.
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

    # SECURITY [M7]: origin_url is client-supplied and unvalidated, then handed to Stripe
    # as the success/cancel redirect. The client has no legitimate reason to choose this —
    # derive it from PUBLIC_APP_URL server-side and drop the field from CheckoutIn.
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


# Romanian standard VAT, currently 21%. Both tickets and merchandise sit at this rate;
# prices everywhere are stored GROSS (VAT-inclusive, as Romanian retail quotes them) and
# the net and VAT components are derived from the total at invoice time.
#
# This is only the STARTING value. The live rate is a single editable setting (see
# get_vat_rate below) so a statutory change is an edit in the admin UI, not a redeploy —
# and one field covers tickets and the shop rather than each keeping its own.
VAT_RATE_DEFAULT = float(os.environ.get("VAT_RATE", "0.21"))


async def get_vat_rate() -> float:
    """The VAT rate to apply to something being invoiced right now.

    Read per invoice rather than cached at import: a rate change has to take effect on
    the next order without restarting every serverless instance. Already-issued invoices
    are unaffected — each one stores the rate it was raised under, which is what makes a
    rate change safe to apply at any point in a fiscal year.
    """
    doc = await db.site_settings.find_one({"_id": "billing"}, {"_id": 0, "vat_rate": 1})
    rate = (doc or {}).get("vat_rate")
    return float(rate) if isinstance(rate, (int, float)) else VAT_RATE_DEFAULT


async def set_vat_rate(rate: float) -> float:
    if not (0 <= rate < 1):
        raise HTTPException(400, "VAT rate is a fraction, e.g. 0.21 for 21%")
    await db.site_settings.update_one({"_id": "billing"}, {"$set": {"vat_rate": float(rate)}}, upsert=True)
    return await get_vat_rate()

_invoice_counter_ready = False


async def _next_invoice_number() -> int:
    """Allocate the next invoice number atomically.

    Fiscal numbering has to be one unbroken sequence per series, so tickets and shop
    orders draw from the same counter. This was previously `max(number) + 1` — a read
    followed by a write, which hands two concurrent finalizes the same number and
    produces two invoices claiming to be SNTY-001234.

    The counter is seeded once per process from whatever has already been issued, with
    `$max` so racing instances converge on the same floor instead of resetting it.
    """
    global _invoice_counter_ready
    if not _invoice_counter_ready:
        latest = await db.invoices.find({}, {"_id": 0, "number": 1}).sort("number", -1).limit(1).to_list(1)
        floor = max(999, latest[0]["number"] if latest else 999)
        await db.counters.update_one({"_id": "invoice_number"}, {"$max": {"seq": floor}}, upsert=True)
        _invoice_counter_ready = True
    doc = await db.counters.find_one_and_update(
        {"_id": "invoice_number"}, {"$inc": {"seq": 1}},
        return_document=ReturnDocument.AFTER, upsert=True,
    )
    return int(doc["seq"])


async def issue_invoice(*, user_id: str, total: float, net: float, vat_amount: float,
                        vat_rate: float, lines: Optional[List[dict]] = None,
                        meta: Optional[dict] = None) -> dict:
    """Write one invoice row. `lines` is the multi-line form the shop uses; ticket
    invoices carry event_id/quantity in `meta` instead and render from that."""
    inv = {
        "invoice_id": new_id("inv"),
        "number": await _next_invoice_number(),
        "series": "SNTY",
        "user_id": user_id,
        "issued_at": now_utc().isoformat(),
        "currency": "RON",
        "total": round(total, 2),
        "net": round(net, 2),
        "vat_rate": vat_rate,
        "vat_amount": round(vat_amount, 2),
        **({"lines": lines} if lines else {}),
        **(meta or {}),
    }
    await db.invoices.insert_one(dict(inv))
    return {k: v for k, v in inv.items() if k != "_id"}


async def create_stripe_session(*, user: dict, total_ron: float, metadata: dict,
                                line_items: List[dict], success_path: str, cancel_path: str):
    """Open a Checkout Session (or simulate one) and return (session_id, url).

    Redirect targets are built from PUBLIC_APP_URL rather than anything the client sent —
    the ticket path takes an `origin_url` from the request body, which is the open-redirect
    noted as M7 in the audit and is not repeated here.
    """
    success_url = f"{PUBLIC_APP_URL}{success_path}"
    cancel_url = f"{PUBLIC_APP_URL}{cancel_path}"

    if PAYMENTS_MODE == "fake":
        session_id = f"cs_local_{uuid.uuid4().hex}"
        return session_id, f"{success_url.replace('{CHECKOUT_SESSION_ID}', session_id)}&mock=1"

    session = await asyncio.to_thread(
        stripe_sdk.checkout.Session.create,
        mode="payment",
        customer=await _stripe_customer_id(user),
        line_items=[{
            "price_data": {
                "currency": "ron",
                "unit_amount": int(round(float(li["amount_ron"]) * 100)),
                "product_data": {"name": li["name"]},
            },
            "quantity": int(li.get("quantity", 1)),
        } for li in line_items],
        success_url=success_url,
        cancel_url=cancel_url,
        metadata=metadata,
        payment_intent_data={"metadata": metadata},
    )
    return session.id, session.url


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
    vat_rate = await get_vat_rate()  # the one sitewide rate, shared with the shop
    total = r["total_ron"]
    net = round(total / (1 + vat_rate), 2)
    vat_amount = round(total - net, 2)
    invoice = await issue_invoice(
        user_id=r["user_id"], total=total, net=net, vat_amount=vat_amount, vat_rate=vat_rate,
        meta={"reservation_id": reservation_id, "event_id": r["event_id"], "quantity": r["quantity"]},
    )
    next_num = invoice["number"]

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
    # SECURITY [C1 fixed / L2 open]: deliberately unauthenticated so the post-Stripe
    # success page can poll before its session cookie is re-established.
    #   * The fake branch below MARKS THE ORDER PAID and issues real tickets. That is now
    #     reachable only under an explicit LOCAL_FAKE_PAYMENTS=1, which the startup guard
    #     refuses under APP_ENV=production — so it cannot exist on a production host.
    #   * STILL OPEN (L2): this returns the full transaction doc (user_id, amount) to
    #     anyone holding the session id. Unguessable, but an unauthenticated read of
    #     order data. Narrow the response to {payment_status, status}.
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
        await _finalize_transaction(tx)
    return await db.payment_transactions.find_one({"session_id": session_id}, {"_id": 0})


async def _finalize_transaction(tx: dict):
    """Route a paid transaction to whichever thing it was paying for.

    Tickets and the shop share the Checkout Session plumbing and this webhook, so the
    transaction row carries `kind` and dispatch happens here rather than by guessing from
    which id field is present."""
    if tx.get("kind") == "shop_order":
        await SHOP["finalize_paid_order"](tx["order_id"])
    else:
        await _finalize_paid_reservation(tx["reservation_id"])


async def _mark_paid_and_finalize(session_id: str):
    tx = await db.payment_transactions.find_one({"session_id": session_id}, {"_id": 0})
    if not tx:
        return
    await db.payment_transactions.update_one(
        {"session_id": session_id}, {"$set": {"payment_status": "paid"}},
    )
    await _finalize_transaction(tx)


@api.post("/webhook/stripe")
async def stripe_webhook(request: Request):
    body = await request.body()

    if PAYMENTS_MODE == "fake":
        # Dev-only shim so the webhook path is exercisable without Stripe. Accepts a
        # plain JSON {session_id, payment_status}. Refused entirely in stripe mode.
        #
        # SECURITY [C1 — fixed]: this branch is unauthenticated and unsigned. Anyone who
        # reaches it can finalize any reservation whose session_id they know (their own,
        # returned by /api/checkout) and receive real tickets and a real invoice without
        # paying. It is now gated on PAYMENTS_MODE == "fake", which requires an explicit
        # LOCAL_FAKE_PAYMENTS=1 and is refused at startup under APP_ENV=production. Do not
        # reintroduce a path where an absent or malformed Stripe key selects this mode.
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

    # Two shapes share this collection and this renderer: a ticket invoice references an
    # event and a quantity, a shop invoice carries its own `lines`.
    ev = await db.events.find_one({"event_id": inv.get("event_id")}, {"_id": 0}) or {}
    buyer = await db.users.find_one({"user_id": inv["user_id"]}, {"_id": 0}) or {}
    lines = inv.get("lines") or [{
        "description": f"Ticket · {ev.get('title', '')}",
        "quantity": inv.get("quantity", 1),
        "total": inv["total"],
    }]
    order = await db.shop_orders.find_one({"order_id": inv.get("order_id")}, {"_id": 0}) or {}

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
    if order:
        addr = order.get("shipping_address", {})
        c.drawString(40, H - 172, "Ship to: " + ", ".join(filter(None, [
            addr.get("full_name", ""), addr.get("line1", ""), addr.get("line2", ""),
            addr.get("postal_code", ""), addr.get("city", ""), addr.get("country", ""),
        ]))[:110])
        c.drawString(40, H - 189, f"Order: {order.get('order_id', '')}")
    else:
        c.drawString(40, H - 172, f"Event: {ev.get('title', '')}")
        venue_line = ", ".join(filter(None, [ev.get("venue", ""), ev.get("city", "")]))
        c.drawString(40, H - 189, f"Venue: {venue_line}")

    y = H - 240
    c.setFont("Helvetica-Bold", 10)
    c.drawString(40, y, "DESCRIPTION")
    c.drawString(400, y, "QTY")
    c.drawString(500, y, "TOTAL (RON)")
    c.line(40, y - 4, 570, y - 4)
    y -= 22
    c.setFont("Helvetica", 10)
    for line in lines:
        # Each line is gross; net and VAT are shown once for the whole invoice below,
        # which is what a single-rate invoice needs.
        c.drawString(40, y, str(line.get("description", ""))[:64])
        c.drawString(400, y, str(line.get("quantity", 1)))
        c.drawString(500, y, f"{float(line.get('total', 0)):.2f}")
        y -= 16
        if y < 140:  # keep clear of the totals block
            break

    y -= 34
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
    c.drawString(40, 50, "Goods remain returnable under EU distance-selling rules for 14 days. "
                         if order else
                         "All sales final unless event cancelled. ")
    c.drawString(40, 38, "This is a proforma invoice for the MVP.")

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

def _created_range(date_from: Optional[str], date_to: Optional[str]) -> dict:
    """Range filter on the ISO-8601 `created_at` strings. Those carry a fixed
    +00:00 offset, so lexical comparison is chronological. A bare YYYY-MM-DD
    `date_to` is widened to cover that whole day rather than midnight."""
    rng = {}
    if date_from:
        rng["$gte"] = date_from
    if date_to:
        rng["$lte"] = (date_to + "T23:59:59.999999") if len(date_to) == 10 else date_to
    return {"created_at": rng} if rng else {}


@api.get("/admin/stats")
async def admin_stats(
    event_id: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    user=Depends(require_admin),
):
    # Same scope applied to every metric so the cards stay mutually consistent.
    scope = _created_range(date_from, date_to)
    if event_id:
        scope["event_id"] = event_id

    total_orders = await db.reservations.count_documents({**scope, "status": "paid"})
    total_tickets = await db.tickets.count_documents(scope)
    scanned = await db.tickets.count_documents({**scope, "status": "used"})
    revenue_docs = await db.reservations.find({**scope, "status": "paid"}, {"_id": 0, "total_ron": 1}).to_list(5000)
    revenue = sum(r["total_ron"] for r in revenue_docs)
    # Unfiltered this is the catalogue size. Once any filter is on, counting the
    # whole catalogue (or events *scheduled* in the window, which reads as 0 for a
    # backward-looking range) would be the odd one out among four sales metrics —
    # so it becomes "how many events actually sold in this slice".
    if event_id or date_from or date_to:
        events = len(await db.reservations.distinct("event_id", {**scope, "status": "paid"}))
    else:
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
    # SECURITY [M6 — mass assignment]: `body` is an untyped dict $set wholesale, so every
    # EventIn validator is bypassed and ANY field name can be written — including dotted
    # paths that reach into nested docs (e.g. "waves.0.available"). Admin-only, so this is
    # privilege use rather than escalation, but it turns a hijacked admin session into
    # arbitrary document mutation. Replace with a typed patch model.
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
    return await db.gallery.find(query, {"_id": 0}).sort([("sort_order", 1), ("created_at", 1)]).to_list(500)


class GalleryIn(BaseModel):
    image_url: str
    thumbnail_url: str = ""
    caption: str = ""
    media_type: str = "image"
    event_id: Optional[str] = None


def _valid_media_url(url: str) -> bool:
    """What may be stored as an item's source: an http(s) address, or one of our own
    root-relative upload paths. Anything else — `javascript:`, `data:`, a
    protocol-relative `//host` — is refused rather than handed to an <img>/<video> src.
    """
    u = (url or "").strip()
    if u.startswith("//"):
        return False
    return u.startswith(("http://", "https://", "/"))


@api.post("/admin/gallery")
async def admin_add_gallery(body: GalleryIn, user=Depends(require_admin)):
    g = body.model_dump()
    # Items normally arrive from /admin/uploads, but an editor can also paste the URL of
    # an image that already lives somewhere else, so the value is checked here.
    g["image_url"] = (g.get("image_url") or "").strip()
    g["thumbnail_url"] = (g.get("thumbnail_url") or "").strip() or g["image_url"]
    if not _valid_media_url(g["image_url"]) or not _valid_media_url(g["thumbnail_url"]):
        raise HTTPException(400, "Enter a full http(s) image or video URL")
    if g.get("media_type") not in ("image", "video"):
        raise HTTPException(400, "media_type must be 'image' or 'video'")
    g["gallery_id"] = new_id("gal")
    g["created_at"] = now_utc().isoformat()
    # New items land at the end of their own bucket.
    last = await db.gallery.find({"event_id": g["event_id"]}).sort("sort_order", -1).limit(1).to_list(1)
    g["sort_order"] = (last[0].get("sort_order", -1) + 1) if last else 0
    g["is_cover"] = False
    await db.gallery.insert_one(g)
    return {k: v for k, v in g.items() if k != "_id"}


class GalleryReorderIn(BaseModel):
    event_id: Optional[str] = None
    ordered_ids: List[str]


@api.patch("/admin/gallery/reorder")
async def admin_reorder_gallery(body: GalleryReorderIn, user=Depends(require_admin)):
    """Rewrite sort_order to match ordered_ids. Every id must belong to the named
    bucket — otherwise a stale client could drag an item out of its own album."""
    bucket = body.event_id or None
    owned = await db.gallery.find({"event_id": bucket}, {"_id": 0, "gallery_id": 1}).to_list(5000)
    owned_ids = {g["gallery_id"] for g in owned}
    unknown = [i for i in body.ordered_ids if i not in owned_ids]
    if unknown:
        raise HTTPException(400, f"{len(unknown)} item(s) do not belong to this album")

    for i, gid in enumerate(body.ordered_ids):
        await db.gallery.update_one({"gallery_id": gid}, {"$set": {"sort_order": i}})
    return {"ok": True, "count": len(body.ordered_ids)}


class GallerySettingsIn(BaseModel):
    title: Optional[str] = None
    slug: Optional[str] = None
    description: Optional[str] = None


# Declared BEFORE /admin/gallery/{gallery_id} — FastAPI matches in declaration order, and
# a literal path registered after the parameterised one would be swallowed by it.
@api.get("/admin/gallery/settings")
async def admin_gallery_settings(user=Depends(require_admin)):
    return await _gallery_settings()


@api.patch("/admin/gallery/settings")
async def admin_update_gallery_settings(body: GallerySettingsIn, user=Depends(require_admin)):
    current = await _gallery_settings()
    updates = {}

    if body.title is not None:
        title = body.title.strip()
        if not title:
            raise HTTPException(400, "The gallery needs a title")
        updates["title"] = title

    if body.slug is not None:
        # Editors type a slug, or leave it blank and mean "derive it from the title".
        slug = _slugify(body.slug) or _slugify(updates.get("title", current["title"]))
        if not _SLUG_RE.match(slug or ""):
            raise HTTPException(400, "The slug must use letters, numbers and hyphens, e.g. live-documentation")
        updates["slug"] = slug

    if body.description is not None:
        updates["description"] = body.description.strip()

    if updates:
        await db.site_settings.update_one({"_id": "gallery"}, {"$set": updates}, upsert=True)
        await _audit(user["user_id"], "gallery_settings_updated", "gallery", "sitewide", updates)
    return await _gallery_settings()


class GalleryPatchIn(BaseModel):
    caption: Optional[str] = None
    is_cover: Optional[bool] = None


@api.patch("/admin/gallery/{gallery_id}")
async def admin_update_gallery(gallery_id: str, body: GalleryPatchIn, user=Depends(require_admin)):
    item = await db.gallery.find_one({"gallery_id": gallery_id}, {"_id": 0})
    if not item:
        raise HTTPException(404, "Not found")

    updates = {}
    if body.caption is not None:
        updates["caption"] = body.caption
    if body.is_cover is not None:
        if body.is_cover:
            # Exactly one cover per bucket.
            await db.gallery.update_many({"event_id": item.get("event_id")}, {"$set": {"is_cover": False}})
        updates["is_cover"] = body.is_cover
    if updates:
        await db.gallery.update_one({"gallery_id": gallery_id}, {"$set": updates})
    return await db.gallery.find_one({"gallery_id": gallery_id}, {"_id": 0})


@api.delete("/admin/gallery/{gallery_id}")
async def admin_delete_gallery(gallery_id: str, user=Depends(require_admin)):
    item = await db.gallery.find_one({"gallery_id": gallery_id}, {"_id": 0})
    if not item:
        return {"ok": True}
    await db.gallery.delete_one({"gallery_id": gallery_id})
    # Drop the bytes too, or uploads accumulate forever. The thumbnail may be the
    # same URL as the original (videos without a poster), so guard against that.
    await storage.delete(item.get("image_url"))
    thumb = item.get("thumbnail_url")
    if thumb and thumb != item.get("image_url"):
        await storage.delete(thumb)
    # Promote a new cover if this was it, so the album never loses its cover.
    if item.get("is_cover"):
        nxt = await db.gallery.find({"event_id": item.get("event_id")}).sort([("sort_order", 1)]).limit(1).to_list(1)
        if nxt:
            await db.gallery.update_one({"gallery_id": nxt[0]["gallery_id"]}, {"$set": {"is_cover": True}})
    return {"ok": True}


@api.post("/admin/uploads")
async def admin_upload_media(
    file: UploadFile = File(...),
    poster: Optional[UploadFile] = File(None),
    # Editors, not just admins: the CMS is an editor-role tool and its image blocks
    # upload through here, so admin-only made the feature 403 for the exact role it
    # exists for. Not an escalation — an editor can already publish a custom_html block.
    user=Depends(require_admin_or_editor),
):
    # SECURITY [M3/M8/M9 — see SECURITY_AUDIT.md]. Three things to know about this route:
    #   * The media type is decided by the CLIENT-DECLARED Content-Type below; nothing
    #     sniffs the actual bytes. The extension allowlist contains no HTML or SVG type
    #     and names are server-generated UUIDs, which is what keeps this from being stored
    #     XSS today — it stops being true if SVG is ever added, or if /uploads is served
    #     without `X-Content-Type-Options: nosniff` (currently it is: no headers are set).
    #   * Only the *thumbnail* is re-encoded through Pillow. The original bytes are
    #     written verbatim, and videos are never re-encoded at all.
    #   * The size cap is enforced AFTER the whole body is read into memory, and because
    #     multipart is a CORS-safelisted content type this POST needs no preflight — so
    #     with SameSite=None it is reachable cross-site against a logged-in admin.
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
    url = await storage.save(f"{file_id}{ext}", data, content_type)

    thumbnail_url = None
    if media_type == "image":
        try:
            img = Image.open(io.BytesIO(data))
            img = img.convert("RGB")
            img.thumbnail((640, 640))
            buf = io.BytesIO()
            img.save(buf, "JPEG", quality=82)
            thumbnail_url = await storage.save(f"{file_id}_thumb.jpg", buf.getvalue(), "image/jpeg")
        except Exception:
            logger.exception("Thumbnail generation failed for upload %s", file_id)
    elif poster is not None:
        # ffmpeg isn't a dependency here, so video posters are captured in the
        # browser at upload time and sent alongside. Treated as untrusted image
        # bytes: re-encoded through Pillow rather than written through as-is.
        try:
            pdata = await poster.read()
            if len(pdata) > MAX_UPLOAD_BYTES:
                raise ValueError("poster too large")
            pimg = Image.open(io.BytesIO(pdata)).convert("RGB")
            pimg.thumbnail((640, 640))
            buf = io.BytesIO()
            pimg.save(buf, "JPEG", quality=82)
            thumbnail_url = await storage.save(f"{file_id}_poster.jpg", buf.getvalue(), "image/jpeg")
        except Exception:
            logger.exception("Poster processing failed for upload %s", file_id)

    return {
        "url": url,
        "thumbnail_url": thumbnail_url or url,
        "media_type": media_type,
        "has_poster": bool(thumbnail_url) if media_type == "video" else True,
    }


# ---------- Seed ----------

@api.post("/seed")
async def seed_demo(user=Depends(require_admin)):
    """Seed demo data if empty. Admin-only (the docstring here used to claim it was
    public — it never is; the dependency above is the authority)."""
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

from cms_routes import register_cms_routes, ensure_core_nav_items, ensure_home_page  # noqa: E402
register_cms_routes(api, db, require_admin, require_admin_or_editor)

from mailer import init_mailer, send_mail  # noqa: E402
init_mailer(db, logger)

# The webshop gets the shared pieces handed to it rather than importing this module,
# which would be a cycle. SHOP exposes the two hooks server.py calls back into:
# finalising a paid order (from the webhook) and sweeping expired stock holds.
from types import SimpleNamespace  # noqa: E402
from shop_routes import register_shop_routes  # noqa: E402

SHOP = register_shop_routes(api, SimpleNamespace(
    db=db,
    logger=logger,
    now_utc=now_utc,
    new_id=new_id,
    parse_dt=parse_dt,
    get_current_user=get_current_user,
    require_admin=require_admin,
    rate_limit=rate_limit,
    # Keyed on any string rather than the caller's IP — the shop uses it per account.
    rate_check_key=_email_rate_check,
    profile_complete=_profile_complete,
    create_stripe_session=create_stripe_session,
    issue_invoice=issue_invoice,
    send_mail=send_mail,
    audit=_audit,
    public_app_url=PUBLIC_APP_URL,
    # One rate for the whole site: the shop reads and writes the same setting the
    # ticket invoices use, so there is a single field to change when the law does.
    get_vat_rate=get_vat_rate,
    set_vat_rate=set_vat_rate,
))

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

# SECURITY [M1 — fixed]: no security response headers were set at all. Added here rather
# than at the proxy so the guarantee travels with the app and holds in dev too.
#
# Two paths need different treatment:
#   * /uploads serves user-supplied bytes from the application origin. The upload
#     endpoint picks its extension from a client-declared Content-Type and writes the
#     original bytes verbatim (audit M8), so `nosniff` is what stops a browser deciding a
#     polyglot is HTML, and the sandboxed CSP neuters it if one is ever served as a
#     document. Neither affects <img>/<video> rendering, which is not document loading.
#   * /docs and /redoc load Swagger/ReDoc from a CDN, so the strict default CSP would
#     break them. They get a narrower policy instead of an exemption.
_DOCS_PATHS = ("/docs", "/redoc", "/openapi.json")
_CSP_DEFAULT = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
_CSP_UPLOADS = "default-src 'none'; img-src 'self'; media-src 'self'; frame-ancestors 'none'; sandbox"
_CSP_DOCS = ("default-src 'none'; img-src 'self' data: https://fastapi.tiangolo.com; "
             "script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; "
             "style-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; "
             "font-src 'self' https://cdn.jsdelivr.net; connect-src 'self'; frame-ancestors 'none'")


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    path = request.url.path

    # setdefault, not assignment: a route that deliberately sets its own value wins.
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    # Email-verification and password-reset tokens travel in URL query strings, so a
    # referrer leak is a credential leak. This is the cheapest half of that fix; moving
    # the tokens out of the query string entirely is audit item P1.6.
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    # camera=(self), not camera=(): an empty allowlist denies the camera to every origin
    # INCLUDING this one, so getUserMedia is rejected with NotAllowedError and the browser
    # never even prompts. That is what broke the door scanner on every device — it read as
    # "access denied" with no permission dialog to grant. Microphone and geolocation stay
    # fully denied; nothing here asks for them.
    #
    # On Vercel the document is served by the frontend service, so vercel.json carries the
    # header that actually governs the scanner page; this one matters the moment anything
    # serves the SPA from here instead.
    response.headers.setdefault("Permissions-Policy", "camera=(self), microphone=(), geolocation=()")

    # Only meaningful over TLS, and actively unhelpful on http dev where it would pin the
    # browser to a scheme localhost isn't serving.
    if COOKIE_SECURE:
        response.headers.setdefault(
            "Strict-Transport-Security", "max-age=31536000; includeSubDomains"
        )

    if path.startswith("/uploads"):
        csp = _CSP_UPLOADS
    elif path.startswith(_DOCS_PATHS):
        csp = _CSP_DOCS
    else:
        csp = _CSP_DEFAULT
    response.headers.setdefault("Content-Security-Policy", csp)
    return response


# Bump when a change below needs to run against an already-initialised database.
# 2: users gained first_name/last_name (split out of the single `name`).
# 3: news_opt_in backfilled into newsletter_subscriptions (opt-ins taken before the
#    two were kept in step were invisible to the admin tab and the CSV export).
# 4: the built-in nav links became reorderable `kind: "core"` rows in cms_pages.
# 5: the homepage is designated by an is_home flag rather than by the slug "home".
SCHEMA_VERSION = 5


@app.on_event("startup")
async def init_app():
    """One-time database setup, skipped once the database says it is already done.

    This used to be two unconditional startup hooks. That is fine for a long-lived
    uvicorn process that starts once a week, and wrong for a serverless host, where every
    cold start is a fresh "boot": each one would re-scan `user_sessions` end to end and
    walk every gallery bucket before serving its first request, on an instance that may
    exist for one request.

    So the work is gated on a marker document. The gate also covers INITIAL_ADMIN_EMAIL,
    which is why the marker stores it — changing that variable has to re-run the
    promotion, or an operator setting it after the first deploy would see nothing happen.

    Two cold starts can still race through the gate together. Everything below is
    idempotent (`create_index` and the migrations all converge on the same state), so the
    cost of losing that race is duplicated work, not corruption.
    """
    marker = {"version": SCHEMA_VERSION, "admin_email": INITIAL_ADMIN_EMAIL}
    try:
        current = await db.app_meta.find_one({"_id": "init"}, {"_id": 0, "version": 1, "admin_email": 1})
        if current == marker:
            return
    except Exception:
        # An unreachable database here means the whole app is broken anyway; fall through
        # and let the real operations below produce a useful error in the logs.
        logger.exception("Could not read the init marker — running setup unconditionally")

    await init_indexes()
    await bootstrap_admin()

    try:
        await db.app_meta.update_one({"_id": "init"}, {"$set": marker}, upsert=True)
    except Exception:
        logger.exception("Could not record the init marker — setup will re-run next boot")


async def bootstrap_admin():
    """Promote INITIAL_ADMIN_EMAIL to admin, and warn when nobody can administer.

    SECURITY [H3]: this is now the ONLY way an account becomes admin without an existing
    admin granting it — `_initial_role` covers accounts created after the env var is set,
    and this covers one that already existed before it was. Registration order confers
    nothing.

    The trade-off is that a deployment with no INITIAL_ADMIN_EMAIL has no admin at all
    and no way to make one through the API, so say so loudly rather than leaving an
    operator to discover it through 403s.
    """
    if INITIAL_ADMIN_EMAIL:
        result = await db.users.update_one(
            {"email": INITIAL_ADMIN_EMAIL},
            {"$set": {"role": "admin"}},
        )
        if result.matched_count:
            logger.info("Bootstrapped %s to admin", INITIAL_ADMIN_EMAIL)
        else:
            logger.info(
                "INITIAL_ADMIN_EMAIL=%s has no account yet — it will be created with the "
                "admin role when that address registers", INITIAL_ADMIN_EMAIL,
            )

    if not await db.users.count_documents({"role": "admin"}):
        logger.warning(
            "No admin account exists. Nothing grants admin except INITIAL_ADMIN_EMAIL "
            "(currently %s) — set it and restart, or promote a user directly in the "
            "database. The admin UI is unreachable until then.",
            INITIAL_ADMIN_EMAIL or "unset",
        )


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

        await migrate_session_token_hashes()
        await db.user_sessions.create_index("expires_at", expireAfterSeconds=0)
        await db.user_sessions.create_index("session_token", unique=True)
        await db.users.create_index("email", unique=True)
        # Partial (not sparse) unique: only enforce uniqueness on docs that actually
        # have a provider sub, so many null/absent values don't collide.
        await db.users.create_index("google_sub", unique=True, partialFilterExpression={"google_sub": {"$type": "string"}})
        await db.users.create_index("apple_sub", unique=True, partialFilterExpression={"apple_sub": {"$type": "string"}})
        await db.processed_stripe_events.create_index("event_id", unique=True)
        await db.newsletter_subscriptions.create_index("email", unique=True)
        await db.gallery.create_index([("event_id", 1), ("sort_order", 1)])
        # Webshop. The variant index backs the atomic stock hold, which filters on
        # product_id plus a variant with enough stock on every add-to-cart and checkout.
        await db.products.create_index("product_id", unique=True)
        await db.products.create_index("slug", unique=True)
        await db.products.create_index([("is_published", 1), ("sort_order", 1)])
        await db.products.create_index("variants.variant_id")
        await db.products.create_index("variants.sku")
        await db.carts.create_index("user_id", unique=True)
        await db.shop_orders.create_index("order_id", unique=True)
        await db.shop_orders.create_index([("user_id", 1), ("created_at", -1)])
        # The expiry sweep looks for pending orders past their hold; without this it is a
        # collection scan on every catalogue read.
        await db.shop_orders.create_index([("status", 1), ("hold_expires_at", 1)])
        await db.invoices.create_index("number", unique=True)
        logger.info("Indexes ensured")
    except Exception:
        logger.exception("init_indexes failed")

    try:
        await migrate_gallery_ordering()
    except Exception:
        logger.exception("migrate_gallery_ordering failed")

    try:
        await migrate_user_names()
    except Exception:
        logger.exception("migrate_user_names failed")

    try:
        await migrate_newsletter_optins()
    except Exception:
        logger.exception("migrate_newsletter_optins failed")

    try:
        created = await ensure_core_nav_items(db)
        if created:
            logger.info("Created %d core nav item(s)", created)
    except Exception:
        logger.exception("ensure_core_nav_items failed")

    try:
        adopted = await ensure_home_page(db)
        if adopted:
            logger.info("No homepage was set; adopted %r for /", adopted)
    except Exception:
        logger.exception("ensure_home_page failed")


async def migrate_session_token_hashes():
    """Replace plaintext session tokens with their SHA-256 (audit M2).

    This migrates in place and does NOT log anyone out: the value being hashed is exactly
    what the user's cookie already holds, so the next request hashes the same plaintext
    and matches the migrated row.

    Rows are identified by shape rather than a flag, because the old rows have no flag to
    read. `secrets.token_urlsafe(32)` yields 43 base64url characters; a hex SHA-256 is 64
    characters of [0-9a-f], so "64 hex chars" means already migrated. A stored token that
    is neither is not something this app issued — drop it rather than guess.
    """
    migrated = dropped = 0
    async for s in db.user_sessions.find({}, {"_id": 1, "session_token": 1}):
        tok = s.get("session_token") or ""
        if len(tok) == 64 and all(c in "0123456789abcdef" for c in tok):
            continue  # already hashed
        if not tok:
            await db.user_sessions.delete_one({"_id": s["_id"]})
            dropped += 1
            continue
        try:
            await db.user_sessions.update_one(
                {"_id": s["_id"]}, {"$set": {"session_token": _hash_token(tok)}}
            )
            migrated += 1
        except Exception:
            # A duplicate-key collision here means the same token was already migrated
            # under another row; the stale one is worthless either way.
            await db.user_sessions.delete_one({"_id": s["_id"]})
            dropped += 1
    if migrated or dropped:
        logger.info("Session tokens hashed at rest: %d migrated, %d dropped", migrated, dropped)


async def migrate_gallery_ordering():
    """Backfill the fields the album manager relies on.

    Pre-existing rows predate ordering entirely, and the earliest seeded ones also
    lack media_type/event_id. Ordering is assigned per bucket (each event album and
    the sitewide one are independent sequences) following the old created_at order,
    so existing albums keep exactly the order they already displayed in.
    """
    await db.gallery.update_many({"media_type": {"$exists": False}}, {"$set": {"media_type": "image"}})
    await db.gallery.update_many({"event_id": {"$exists": False}}, {"$set": {"event_id": None}})

    buckets = await db.gallery.distinct("event_id")
    fixed = 0
    for bucket in buckets:
        items = await db.gallery.find(
            {"event_id": bucket, "sort_order": {"$exists": False}}, {"_id": 0, "gallery_id": 1}
        ).sort("created_at", 1).to_list(5000)
        if not items:
            continue
        # Append after anything already ordered in this bucket.
        ordered = await db.gallery.find({"event_id": bucket, "sort_order": {"$exists": True}}).to_list(5000)
        base = max((o.get("sort_order", 0) for o in ordered), default=-1) + 1
        for i, g in enumerate(items):
            await db.gallery.update_one({"gallery_id": g["gallery_id"]}, {"$set": {"sort_order": base + i}})
            fixed += 1
    if fixed:
        logger.info("Gallery ordering backfilled for %d item(s)", fixed)


async def migrate_user_names():
    """Split the legacy single `name` into first_name/last_name.

    Accounts that predate the mandatory Name/Surname/Phone rule stored one string. The
    split is a guess (see _split_name), and phone is deliberately NOT invented — an
    account left without a surname or a number is profile-incomplete, and the user is
    asked to correct it at their next sign-in. This only fills fields that are absent,
    so it never overwrites what someone has since typed.
    """
    fixed = 0
    async for u in db.users.find({"first_name": {"$exists": False}}, {"_id": 0, "user_id": 1, "name": 1}):
        first, last = _split_name(u.get("name"))
        await db.users.update_one(
            {"user_id": u["user_id"]},
            {"$set": {"first_name": first, "last_name": last}},
        )
        fixed += 1
    if fixed:
        logger.info("Backfilled first/last name for %d user(s)", fixed)


async def migrate_newsletter_optins():
    """Create subscriber rows for opt-ins taken before the two were kept in step.

    `news_opt_in` on the user document and the `newsletter_subscriptions` collection were
    disconnected until _sync_newsletter_subscription landed, and that function only runs
    when a consent is *written* — at registration, on a Settings toggle, or when
    verify_email promotes a pending row. Anyone who ticked the box before it existed still
    has the flag and no row, so the admin Newsletter tab and the CSV export cannot see
    them, permanently, because nothing else reconciles the two.

    This only ever inserts. An address that already has a row is left exactly as it
    stands — including an unsubscribed one. That case is the reason this does not just
    call _sync_newsletter_subscription: the unsubscribe endpoint marks the subscription
    and does not clear `news_opt_in`, so a stale true on the user document would let a
    migration resurrect a subscription somebody explicitly ended. Nobody is consenting at
    boot; the more specific signal wins. `$setOnInsert` with no `$set` makes that
    race-safe against a second cold start rather than merely likely.

    Status follows the same rule as the Settings path: a verified address has already
    proved itself and needs no double opt-in, an unverified one lands pending and
    verify_email promotes it later.
    """
    now_iso = now_utc().isoformat()
    added = 0
    async for u in db.users.find({"news_opt_in": True}, {"_id": 0, "email": 1, "email_verified_at": 1}):
        email = (u.get("email") or "").strip().lower()
        if not email:
            continue
        confirmed = bool(u.get("email_verified_at"))
        result = await db.newsletter_subscriptions.update_one(
            {"email": email},
            {"$setOnInsert": {
                "sub_id": new_id("sub"),
                "email": email,
                "source": "backfill",
                "status": "confirmed" if confirmed else "pending",
                "created_at": now_iso,
                "confirmed_at": now_iso if confirmed else None,
                "unsubscribed_at": None,
            }},
            upsert=True,
        )
        if result.upserted_id is not None:
            added += 1
    if added:
        logger.info("Backfilled %d newsletter subscription(s) from news_opt_in", added)


@app.on_event("shutdown")
async def shutdown():
    # Only close the pool where "shutdown" means the process is going away for good.
    # Serverless instances are torn down with the pool still open — Vercel allows ~500ms
    # after SIGTERM and does not surface logs from it — so there is nothing to gain by
    # closing here, and a closed client on an instance the runtime turns out to reuse
    # fails the next request with an InvalidOperation that looks nothing like its cause.
    if not SERVERLESS:
        client.close()
