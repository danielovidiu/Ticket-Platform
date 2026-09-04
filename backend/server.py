"""
Supersanity - Ticketing platform backend
FastAPI + MongoDB, first-party auth (password + Google/Apple OAuth) + Stripe Checkout
"""
import io
import os
import re
import sys
import csv
import json
import uuid
import base64
import secrets
import hashlib
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone, timedelta, date
from pathlib import Path
from typing import List, Literal, Optional

import jwt
import httpx
import qrcode
from dotenv import load_dotenv
from fastapi import FastAPI, APIRouter, Depends, HTTPException, Request, Response, Cookie, Header, UploadFile, File, Form, Query
from fastapi.responses import StreamingResponse, RedirectResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from urllib.parse import urlencode, quote, urlsplit
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo import ReturnDocument
from pydantic import BaseModel, Field
from models_base import ApiModel, LONG_TEXT, MAX_JSON_DOC_BYTES
import password_policy
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


def _is_public_deployment() -> bool:
    """Is this instance reachable by strangers?

    Every dangerous default in this file used to be gated on APP_ENV == "production"
    alone — one operator-set string, and the failure mode of forgetting it was to run a
    public site with development semantics. So the question is asked of the environment
    instead of taken on trust, and any one of these is enough:

      * APP_ENV says so.
      * We are on a serverless host (Vercel sets VERCEL=1 itself — nobody has to remember).
      * The public origin is https on something that is not a loopback name.

    Wrong in the safe direction: the worst case is a developer on an https tunnel being
    told to configure Stripe properly.
    """
    if APP_ENV == "production" or SERVERLESS:
        return True
    if not PUBLIC_APP_URL.startswith("https://"):
        return False
    host = (urlsplit(PUBLIC_APP_URL).hostname or "").lower()
    return host not in {"localhost", "127.0.0.1", "::1", ""} and not host.endswith(".local")


# SECURITY [H1]: who is allowed to tell us the client's IP.
#
# `TRUSTED_IP_HEADER` decides whether the *application* believes a forwarding header. It
# does not, and cannot, decide whether `request.client.host` is the socket peer — and that
# is the other half of H1, which defeated the first half for months.
#
# uvicorn's ProxyHeadersMiddleware is ON by default (`--proxy-headers`) with
# `forwarded_allow_ips="127.0.0.1"`. For any peer in that list it **rewrites**
# `request.client.host` from `X-Forwarded-For` before the app sees the request. So the
# fallback in `_client_ip()` — the one that looks like "use the socket peer, which cannot
# be faked" — is reading an attacker-supplied header whenever the attacker can reach the
# app from an allowed address. Reproduced against `/api/contact` (5 per 60s): 14 of 14
# accepted while rotating the header, versus 5-then-429 without it.
#
# Whether that is exploitable depends entirely on the topology, which is exactly why it
# must not be left to a default:
#
#   * nothing in front         -> "" . uvicorn trusts no forwarding header at all.
#   * nginx on the same host   -> "127.0.0.1", and the proxy MUST overwrite the header
#                                 (`proxy_set_header X-Forwarded-For $remote_addr`) rather
#                                 than append (`$proxy_add_x_forwarded_for`). With append,
#                                 the left-most entry is the caller's and the bypass is
#                                 back — see DEPLOY_VPS.md, where that line is asserted by
#                                 test_deploy_config.py.
#   * serverless               -> not applicable; the platform terminates, and
#                                 TRUSTED_IP_HEADER=x-vercel-forwarded-for is the answer.
#
# An unset value is refused on a public deployment rather than defaulted, because the
# default is the unsafe one and "we happened to be behind a proxy that overwrites" is not
# a control. Read here only to validate: uvicorn reads the same variable itself — as long
# as nothing passes the flag that outranks it, which is what the block below enforces.
FORWARDED_ALLOW_IPS = os.environ.get("FORWARDED_ALLOW_IPS")


def _forwarded_allow_ips_flag(argv):
    """The value given to `--forwarded-allow-ips` on the command line, or None."""
    for i, arg in enumerate(argv):
        if arg == "--forwarded-allow-ips":
            return argv[i + 1] if i + 1 < len(argv) else ""
        if arg.startswith("--forwarded-allow-ips="):
            return arg.split("=", 1)[1]
    return None


def _same_trust_list(a, b):
    """uvicorn splits the value on commas, so spacing and order are not differences."""
    def parts(value):
        return {p.strip() for p in value.split(",") if p.strip()}
    return parts(a) == parts(b)


# SECURITY [H1, second half]: the flag outranks the variable, and the check below cannot
# see the flag. uvicorn resolves in this order (config.py, 0.52): `--forwarded-allow-ips`
# if given, else `$FORWARDED_ALLOW_IPS`, else `127.0.0.1`. So this start
#
#     FORWARDED_ALLOW_IPS="" uvicorn server:app --forwarded-allow-ips "*"
#
# satisfies the check below with "" and then trusts every caller — H1 reopened, with the
# guard reporting green. The comment above used to claim the two could not disagree. They
# can: click consumed the flag long before this module was imported, and nothing of it
# reaches the environment.
#
# What cannot be read can still be refused. Where the two spellings might not agree, the
# app declines to start rather than validate a value it has no reason to believe — which
# is what makes "uvicorn reads the same variable" true by construction instead of by
# convention. `sys.argv` is exact here because the flag can only arrive on a command line;
# a programmatic `uvicorn.run()` or a gunicorn worker passes it out of band and is as out
# of scope as serverless (see DEPLOY_VPS.md).
_PROXY_HEADERS_DISABLED = "--no-proxy-headers" in sys.argv
_FORWARDED_ALLOW_IPS_FLAG = (
    None if _PROXY_HEADERS_DISABLED else _forwarded_allow_ips_flag(sys.argv)
)

if _FORWARDED_ALLOW_IPS_FLAG is not None and FORWARDED_ALLOW_IPS is not None \
        and not _same_trust_list(_FORWARDED_ALLOW_IPS_FLAG, FORWARDED_ALLOW_IPS):
    # Never deliberate, and the flag is the half that wins, so the half being checked is
    # the wrong one. Refused everywhere, including a laptop: there is no reading of this
    # under which the operator got what they asked for.
    raise RuntimeError(
        "FORWARDED_ALLOW_IPS and --forwarded-allow-ips disagree (audit H1): the "
        f"environment says {FORWARDED_ALLOW_IPS!r} and the command line says "
        f"{_FORWARDED_ALLOW_IPS_FLAG!r}. uvicorn obeys the flag; this app can only "
        "validate the variable. State it once, in the variable, and drop the flag."
    )

if _FORWARDED_ALLOW_IPS_FLAG is not None and FORWARDED_ALLOW_IPS is None \
        and not SERVERLESS and _is_public_deployment():
    # Probably correct — but "probably" is the state this guard exists to refuse, and it
    # is one edit away from the disagreement above.
    raise RuntimeError(
        "--forwarded-allow-ips was passed but FORWARDED_ALLOW_IPS is unset (audit H1). "
        "uvicorn takes the flag and this app cannot see it, so the startup check would "
        "be validating the default rather than what the server is actually running. Set "
        "the environment variable instead — uvicorn reads it when the flag is absent, "
        "and reads it as `is None`, so \"\" still means trust nobody."
    )

if FORWARDED_ALLOW_IPS is None and not SERVERLESS and _is_public_deployment() \
        and not _PROXY_HEADERS_DISABLED:
    raise RuntimeError(
        "FORWARDED_ALLOW_IPS must be set explicitly on a public deployment (audit H1). "
        "uvicorn otherwise trusts X-Forwarded-For from 127.0.0.1 and rewrites "
        "request.client.host with it, which makes every rate limit bypassable if anything "
        "on this host can reach the app. Set it to \"\" when nothing fronts the app, or to "
        "the proxy's address (e.g. 127.0.0.1 for nginx on the same host) when something "
        "does — and make sure that proxy OVERWRITES X-Forwarded-For rather than appending "
        "to it. Starting with --no-proxy-headers also answers it: uvicorn then never "
        "rewrites request.client.host at all."
    )

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

# The dev half of the H1 guard above — a hard failure there covers public deployments, and
# this covers a laptop, where the same bypass is real but the fix is a flag nobody knows
# to pass. Lives here rather than beside its constant only because `logger` is defined
# between the two.
if FORWARDED_ALLOW_IPS is None and _FORWARDED_ALLOW_IPS_FLAG is not None:
    # The flag is doing the job correctly; this app simply cannot see it. Say that,
    # rather than the old text, which advised passing a flag that had just been passed.
    logger.warning(
        "--forwarded-allow-ips was passed but FORWARDED_ALLOW_IPS is unset — uvicorn is "
        "configured, this app is not checking it (audit H1). Set the variable instead; "
        "uvicorn reads it when the flag is absent. Refused rather than warned in public."
    )
elif FORWARDED_ALLOW_IPS is None and not _PROXY_HEADERS_DISABLED:
    logger.warning(
        "FORWARDED_ALLOW_IPS not set — uvicorn trusts X-Forwarded-For from 127.0.0.1, so "
        "rate limits are bypassable from this host (audit H1). Start with "
        'FORWARDED_ALLOW_IPS="" unless something fronts the app.'
    )

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
#   LOCAL_FAKE_PAYMENTS=1   -> fake, and refused outright on a public deployment
#   STRIPE_API_KEY=sk_...   -> stripe (STRIPE_WEBHOOK_SECRET then mandatory)
#   neither                 -> hard startup failure on a public deployment; warning in dev
#
# There is deliberately no path where a missing or malformed key quietly downgrades a
# reachable deployment to the simulator.
#
# The trigger is _is_public_deployment(), not APP_ENV alone. Keying purely on APP_ENV left
# one unset variable between a live site and giving tickets away: a Vercel deployment with
# no APP_ENV took the dev branch and selected the simulator silently, and the only symptom
# was a warning in a log nobody reads. Vercel sets VERCEL=1 on its own, so that case now
# fails closed whether or not anyone remembered APP_ENV.
_FAKE_OVERRIDE = os.environ.get("I_ACCEPT_FREE_TICKETS_IN_PUBLIC", "").strip() == "1"
if os.environ.get("LOCAL_FAKE_PAYMENTS", "").strip() == "1":
    if _is_public_deployment() and not _FAKE_OVERRIDE:
        raise RuntimeError(
            "LOCAL_FAKE_PAYMENTS=1 is a development-only simulator that issues tickets "
            "without payment, and it exposes unauthenticated order-finalizing endpoints. "
            "This instance looks publicly reachable "
            f"(APP_ENV={APP_ENV!r}, serverless={SERVERLESS}, PUBLIC_APP_URL={PUBLIC_APP_URL!r}). "
            "Configure a real STRIPE_API_KEY, or set I_ACCEPT_FREE_TICKETS_IN_PUBLIC=1 if "
            "this deployment genuinely sells nothing."
        )
    PAYMENTS_MODE = "fake"
elif STRIPE_API_KEY.startswith("sk_"):
    PAYMENTS_MODE = "stripe"
elif _is_public_deployment() and not _FAKE_OVERRIDE:
    raise RuntimeError(
        "STRIPE_API_KEY must be a live 'sk_...' key on a public deployment. Refusing to "
        "start: without one the app falls back to the fake payment simulator and hands "
        "out tickets for free. "
        f"(APP_ENV={APP_ENV!r}, serverless={SERVERLESS}, PUBLIC_APP_URL={PUBLIC_APP_URL!r}). "
        "Set I_ACCEPT_FREE_TICKETS_IN_PUBLIC=1 to run a demo that sells nothing."
    )
else:
    PAYMENTS_MODE = "fake"
    if _is_public_deployment():
        # Deliberately chosen, so it starts — but it must never be a quiet condition.
        logger.critical(
            "PUBLIC DEPLOYMENT RUNNING THE FAKE PAYMENT SIMULATOR "
            "(I_ACCEPT_FREE_TICKETS_IN_PUBLIC=1). Anyone who can reach this instance can "
            "issue themselves tickets and invoices for free."
        )
    else:
        logger.warning(
            "No STRIPE_API_KEY set — using the FAKE payment simulator. Orders finalize with "
            "no payment and no authentication. Development only; refused on a public host."
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
# "lax" is the default, unconditionally. It used to default to "none" whenever the origin
# was https, on the assumption that the API sits on a different origin from the frontend —
# but that is the minority layout (Vercel serves the frontend and /api from one domain),
# and getting it wrong is silent and expensive: SameSite=None means the session cookie
# rides along on cross-site requests, and this app has no CSRF token or Origin check to
# catch them (M3). So the safe value is what you get for free, and the permissive one has
# to be asked for. A deployment that genuinely needs "none" finds out immediately —
# sign-in stops sticking — rather than never finding out at all.
COOKIE_SAMESITE = os.environ.get("COOKIE_SAMESITE", "").strip().lower() or "lax"
if COOKIE_SAMESITE not in {"lax", "strict", "none"}:
    raise RuntimeError(f"COOKIE_SAMESITE must be lax, strict or none (got {COOKIE_SAMESITE!r})")
if COOKIE_SAMESITE == "none" and not COOKIE_SECURE:
    raise RuntimeError("COOKIE_SAMESITE=none requires an https PUBLIC_APP_URL; browsers drop the cookie otherwise")
if COOKIE_SAMESITE == "none":
    logger.warning(
        "COOKIE_SAMESITE=none — the session cookie is sent on cross-site requests and "
        "this app has no CSRF token or Origin check (audit M3). Only correct when the "
        "frontend really is on another site."
    )

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

@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Startup/shutdown, in the form FastAPI still supports.

    These were `@app.on_event("startup"/"shutdown")`, which has been deprecated since
    Starlette 0.26 and accounted for every warning the test suite emitted. The handlers
    themselves are unchanged and still defined further down, next to the schema-version
    constant they belong with — the names resolve when this runs, not when it is defined.
    """
    await init_app()
    yield
    await close_db_pool()


app = FastAPI(title="Supersanity API", lifespan=lifespan)
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
# Sound, for the CMS's audio blocks. Kept apart from video rather than folded into it:
# the two are stored the same way but they are not the same thing to the editor, and the
# response says which one arrived so a field that asked for a clip cannot be handed a film.
AUDIO_CONTENT_TYPES = {"audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav",
                       "audio/ogg": ".ogg", "audio/mp4": ".m4a", "audio/aac": ".m4a"}
# 100 MB, which is what a short video actually weighs. Reachable on a VPS, where nginx
# is the only thing in front; NOT reachable on Vercel, whose platform refuses any request
# body over about 4.5 MB before this process is reached at all — measured, not assumed:
# a 4 MB body gets a 401 from this app, a 5 MB body gets a 413 from the edge. Hosted
# uploads that large need the browser to talk to blob storage directly.
MAX_UPLOAD_BYTES = 100 * 1024 * 1024
UPLOAD_CHUNK_BYTES = 64 * 1024

# What a serverless platform will carry in a request body before anything of ours runs.
# Measured, not quoted: the documented figure is ~4.5 MB and rejection happens at the
# edge, so the ceiling advertised to the editor is set below it rather than at it.
PLATFORM_BODY_LIMIT_BYTES = 4 * 1024 * 1024

# The browser-straight-to-blob route was off by default while /api/blob-upload did not
# answer: a route that exists but hangs is worse than one that was never offered, because
# the editor picks it, waits, and gets nothing. It answers now — GET returns the service's
# status and POST refuses an unauthenticated caller in under a quarter of a second — so
# the default is on wherever blob storage is in use.
#
# DIRECT_BLOB_UPLOAD=0 turns it off again without a deploy, which is the switch to reach
# for if the route ever regresses: the editor falls back to the API path and a smaller
# ceiling rather than failing.
DIRECT_BLOB_UPLOAD = os.environ.get("DIRECT_BLOB_UPLOAD", "1").strip().lower() in {"1", "true", "yes", "on"}


def _upload_limits(is_local: bool, direct_enabled: bool) -> tuple:
    """`(max_bytes, direct_upload)` for a deployment shaped like this one.

    Pure, and separate from the route, so the combinations this deployment is not in can
    still be asserted. The one that matters is blob storage without a working direct
    route: the file must then fit in a serverless request body, and claiming otherwise
    costs the editor a long upload before the failure.
    """
    direct = direct_enabled and not is_local
    if direct or is_local:
        return MAX_UPLOAD_BYTES, direct
    return PLATFORM_BODY_LIMIT_BYTES, False

# What Pillow must report for a file the client called an image. Keyed by the declared
# type so the two can be compared: a PNG announced as a JPEG is not a mistake worth
# tolerating, it is the shape of a polyglot.
IMAGE_SNIFF_FORMATS = {"image/jpeg": {"JPEG", "MPO"}, "image/png": {"PNG"},
                       "image/webp": {"WEBP"}, "image/gif": {"GIF"}}

# Container signatures for the formats we accept as video. ffmpeg is not a dependency, so
# these cannot be re-encoded the way images are — reading the container header is what is
# available, and it is still strictly better than believing the Content-Type.
#   MP4/MOV: an ISO-BMFF `ftyp` box at offset 4.   WebM: the EBML magic.
VIDEO_SNIFF = {"video/mp4": [(4, b"ftyp")], "video/quicktime": [(4, b"ftyp")],
               "video/webm": [(0, b"\x1a\x45\xdf\xa3")]}

# The same idea for sound, and for the same reason: no transcoder here either, so the
# container header is the check that is available.
#   WAV: a RIFF chunk whose form type is WAVE.   OGG: the page magic.   M4A: ISO-BMFF.
# MP3 is deliberately absent — it has no single signature (see _sniff_audio).
AUDIO_SNIFF = {"audio/wav": [(0, b"RIFF"), (8, b"WAVE")], "audio/x-wav": [(0, b"RIFF"), (8, b"WAVE")],
               "audio/ogg": [(0, b"OggS")], "audio/mp4": [(4, b"ftyp")], "audio/aac": [(4, b"ftyp")]}


async def _read_capped(upload: UploadFile, limit: int = MAX_UPLOAD_BYTES) -> bytes:
    """Read an upload, refusing it the moment it passes `limit` (audit M9).

    `await upload.read()` buffered the whole body and *then* compared, so the ceiling
    protected nothing it was meant to protect. Starlette spools past a threshold, making
    that disk-then-RAM rather than pure RAM, but a limit enforced after the fact is a
    limit on what gets stored, not on what gets sent.

    nginx caps the body too on the VPS (`client_max_body_size`, kept in step with this in
    DEPLOY_VPS.md); this covers the paths where nothing is in front.
    """
    chunks, total = [], 0
    while chunk := await upload.read(UPLOAD_CHUNK_BYTES):
        total += len(chunk)
        if total > limit:
            raise HTTPException(413, f"File too large (max {limit // (1024 * 1024)}MB)")
        chunks.append(chunk)
    return b"".join(chunks)


def _reencode_image(data: bytes, declared: str) -> tuple:
    """Verify the bytes really are the image they claim, then rebuild them (audit M8).

    Returns `(bytes, content_type, extension)` for what should actually be stored.

    Two separate jobs. **Verification** — `Image.open` plus `verify()` refuses anything
    that is not a decodable image, and the format it reports is checked against what the
    client declared, so a PNG announced as a JPEG is refused rather than quietly stored.
    **Re-encoding** — the returned bytes are Pillow's output, not the caller's. That is
    what actually kills a polyglot: a file that is both a valid GIF and a valid HTML
    document does not survive being decoded to pixels and written back out.

    It also strips every metadata block, EXIF included. For a collective posting photos
    from venues, that means GPS coordinates stop being published as a side effect, which
    is worth as much as the polyglot defence.

    Animation is the one case worth preserving rather than flattening, so GIF and animated
    WebP are re-encoded in place rather than converted to JPEG.
    """
    try:
        Image.open(io.BytesIO(data)).verify()          # verify() exhausts the file object
        img = Image.open(io.BytesIO(data))             # …so re-open it to actually use it
    except Exception:
        raise HTTPException(400, "That file is not a readable image")

    fmt = (img.format or "").upper()
    if fmt not in IMAGE_SNIFF_FORMATS.get(declared, set()):
        raise HTTPException(
            400, f"File content is {fmt or 'unrecognised'}, which does not match the "
                 f"declared type {declared}")

    out = io.BytesIO()
    if getattr(img, "is_animated", False):
        img.save(out, format=fmt, save_all=True)
        return out.getvalue(), declared, IMAGE_CONTENT_TYPES[declared]
    if fmt == "PNG":
        img.convert("RGBA").save(out, format="PNG", optimize=True)
        return out.getvalue(), "image/png", ".png"
    if fmt == "WEBP":
        img.convert("RGBA").save(out, format="WEBP", quality=90)
        return out.getvalue(), "image/webp", ".webp"
    img.convert("RGB").save(out, format="JPEG", quality=90, optimize=True)
    return out.getvalue(), "image/jpeg", ".jpg"


def _sniff_video(data: bytes, declared: str) -> None:
    """Check the container header. Raises when it does not match the declared type."""
    for offset, magic in VIDEO_SNIFF.get(declared, []):
        if data[offset:offset + len(magic)] == magic:
            return
    raise HTTPException(400, f"File content does not look like {declared}")


def _sniff_audio(data: bytes, declared: str) -> None:
    """The audio counterpart, with two differences from `_sniff_video` worth naming.

    The signature list is ALL of them, not any of them. WAV is a RIFF container and so is
    AVI; only the form type at offset 8 tells them apart, so a rule that passed on the
    first match would accept a video file announced as a wav.

    MP3 has no single signature at all. A file with ID3 metadata starts with the tag; one
    without starts at an audio frame, whose only fixed part is eleven set sync bits. Both
    are checked, because either is a real MP3 and refusing the second would refuse the
    output of half the encoders in use.
    """
    if declared == "audio/mpeg":
        if data[:3] == b"ID3":
            return
        if len(data) >= 2 and data[0] == 0xFF and (data[1] & 0xE0) == 0xE0:
            return
        raise HTTPException(400, "File content does not look like an MP3")

    signatures = AUDIO_SNIFF.get(declared, [])
    if signatures and all(data[at:at + len(magic)] == magic for at, magic in signatures):
        return
    raise HTTPException(400, f"File content does not look like {declared}")

# ---------- Utility ----------

def now_utc():
    return datetime.now(timezone.utc)


# ---------- Ticket serials ----------
#
# A ticket carries two identifiers and they do different jobs.
#
#   `qr_code`  — SNTY-<20 random hex>. Unguessable on purpose: it is the thing scanned at
#                the door, so anyone who could predict one could print a ticket. It is NOT
#                touched by any of this.
#   `serial`   — SNTY-<event>-<type>-<0001>. Human-readable, sequential, and the number a
#                fiscal report is written against. Predictable BY DESIGN, which is exactly
#                why it cannot be the thing the door trusts.
#
# The sequence runs per event AND per ticket type, so every tier owns one unbroken range
# and "Early Bird 0001–0150" in the fiscal summary is a statement that can be checked.

SERIAL_PREFIX = "SNTY"

# Tiers that have a settled abbreviation. Anything else is derived from the tier's own
# name, so a promoter inventing "LATE RELEASE" gets LR without a code change.
TIER_CODES = {"early_bird": "EB", "general": "G", "vip": "VIP"}


def _code_from_words(text: str, limit: int) -> str:
    """Initials when there is more than one word, otherwise the leading letters.
    "LATE RELEASE" -> LR, "BACKSTAGE" -> BACK. Digits are kept: "NIGHT 2" -> N2."""
    words = re.findall(r"[A-Za-z0-9]+", (text or "").upper())
    if not words:
        return ""
    if len(words) > 1:
        return "".join(w[0] for w in words)[:limit]
    return words[0][:limit]


def event_code_for(title: str) -> str:
    """The short code standing for one event inside a serial."""
    return _code_from_words(title, 4) or "EVT"


# Where a tier stands, and what each state does to it:
#
#   active   — offered, buyable. The default, and what every tier predating this was.
#   paused   — still listed on the event page, refused at checkout. Sales stopped without
#              the tier disappearing, which is what an editor wants while they rewrite a
#              price or wait on a decision.
#   archived — gone from the event page entirely, refused at checkout, kept in the admin
#              with its sold count and still resolved by the door and the exports.
#
# Archiving is the answer to "delete a tier that has sold", and it is REVERSIBLE: an
# archived tier goes back to active or paused from the same control, with its stock and
# its sold tickets exactly where they were. That reversibility is the whole reason a sold
# tier is archived rather than deleted — an archive undone costs nothing, and a delete
# undone is not a thing that exists.
WAVE_STATUSES = ("active", "paused", "archived")

# Tickets issued per unit bought. The ceiling is a sanity bound, not a business rule: a
# pack is a handful of friends, and a four-figure pack_size is a typo that would issue
# four thousand QR codes and email them all at once.
MAX_PACK_SIZE = 20


def wave_status(wave: dict) -> str:
    """A tier's state, defaulting for every tier written before states existed."""
    st = (wave or {}).get("status")
    return st if st in WAVE_STATUSES else "active"


def wave_pack_size(wave: dict) -> int:
    """How many tickets one purchase of this tier issues.

    1 for an ordinary tier, and for anything written before packs existed. `price_ron` is
    the price of the whole pack, not of one ticket in it — see _pack_ticket_prices.
    """
    try:
        n = int((wave or {}).get("pack_size") or 1)
    except (TypeError, ValueError):
        return 1
    return min(max(n, 1), MAX_PACK_SIZE)


def wave_ticket_cap(event: dict, wave: dict) -> int:
    """How many tickets one person may hold FROM THIS TIER.

    The cap is a property of the tier now, not of the night: a promoter caps the
    four-packs at one per person while general admission stays at six. The tier's own
    number when it sets one, the event's otherwise — so every wave written before the
    field existed carries None, inherits, and behaves exactly as it did.

    Counted per tier, which is the whole point: the same buyer may hold their limit on
    each of two tiers. See _user_ticket_count, which counts by wave_id for the same
    reason.
    """
    cap = (wave or {}).get("max_tickets_per_user")
    if cap is None:
        return event.get("max_tickets_per_user", 4)
    return cap


def _pack_ticket_prices(pack_price: float, pack_size: int) -> List[float]:
    """What each ticket in one pack is individually worth.

    A four-for-the-price-of-three pack sold at 300 issues four tickets worth 75, not three
    worth 100 and one worth nothing. The distinction is not cosmetic: refunds are settled
    per ticket, so a guest turned away at the door is owed 75 — their actual share of what
    was paid — and a ticket carrying 100 would refund money the buyer never handed over,
    while a ticket carrying 0 would refund them nothing for a seat they bought.

    Split in whole cents, remainder onto the earliest tickets, so the prices add back up
    to the pack price EXACTLY. 100 across 3 is 33.34 + 33.33 + 33.33; three tickets at a
    naively rounded 33.33 lose a cent that no fiscal summary can then reconcile.
    """
    size = min(max(int(pack_size or 1), 1), MAX_PACK_SIZE)
    cents = int(round(float(pack_price or 0) * 100))
    base, rem = divmod(cents, size)
    return [round((base + (1 if i < rem else 0)) / 100, 2) for i in range(size)]


def _check_wave_states(waves: List[dict]) -> None:
    """Refuse a tier whose state or pack size is not one we can sell.

    Both are checked here rather than by a Pydantic validator so the message can name the
    tier — an editor with six tiers open needs to know which one.
    """
    for w in waves:
        name = w.get("name") or "A tier"
        if w.get("status") is not None and w.get("status") not in WAVE_STATUSES:
            raise HTTPException(
                400, f"\"{name}\" has an unknown state. "
                     f"Choose one of: {', '.join(WAVE_STATUSES)}.")
        size = w.get("pack_size", 1)
        if not isinstance(size, int) or isinstance(size, bool) or not 1 <= size <= MAX_PACK_SIZE:
            raise HTTPException(
                400, f"\"{name}\" has a pack size of {size!r}. "
                     f"It must be a whole number from 1 to {MAX_PACK_SIZE}.")
        # Capacity counts individual tickets, not packs, so the venue total stays a count
        # of people whatever mix of tiers it is made of. A capacity that is not a whole
        # number of packs simply strands the remainder — 200 seats sold in threes leaves
        # two nobody can buy — so it is refused at the point where it can still be fixed.
        cap = w.get("capacity")
        if size > 1 and isinstance(cap, int) and cap % size:
            raise HTTPException(
                400, f"\"{name}\" sells in packs of {size}, so its ticket count must "
                     f"divide by {size}. {cap} leaves {cap % size} that nobody can buy.")


def _check_access_window(waves: List[dict]) -> None:
    """A tier may carry one end of an admission window, never both.

    The editor picks `until` or `from` with a toggle, so both being set means the request
    did not come from that form. Refused rather than quietly preferring one: the door
    checks `until` first, so silently keeping both would enforce the end the editor did
    not choose and give no sign of it.
    """
    for w in waves:
        if w.get("access_until") and w.get("access_from"):
            raise HTTPException(
                400,
                f"\"{w.get('name') or 'A tier'}\" has both an access-until and an "
                "access-from. Choose one end of the window.",
            )


def _ticket_type_label(ticket: dict, wave: dict) -> str:
    """What a ticket's type is called in an export.

    Three readings, oldest first: what the ticket recorded at issue, then the wave's
    `tier`, then the wave's name. The name is the new last resort — the tier dropdown is
    gone from the editor, so waves created from now on carry no tier, and without this
    their column in a fiscal export would simply be blank.
    """
    return ticket.get("tier") or wave.get("tier") or wave.get("name", "")


def _sorted_waves(waves: List[dict]) -> List[dict]:
    """Tiers in the order a buyer is offered them: lowest `tier_id` first.

    Sorted once here, on the way into the database, rather than by each of the several
    places that hand waves out — the event page, the admin form, the exports and the
    order emails would otherwise each have to remember, and the first one to forget
    shows a different running order than the rest.

    A wave with no id sorts last rather than first. An unnumbered tier is one nobody has
    placed yet, and dropping it at the top of the list would push a numbered one down.
    """
    return sorted(
        waves,
        key=lambda w: (w.get("tier_id") is None, w.get("tier_id") or 0),
    )


def wave_type_code(wave: dict) -> str:
    """The code standing for one ticket type. The tier decides it when the tier is one
    we know; otherwise the wave's own name does."""
    tier = (wave or {}).get("tier")
    if tier in TIER_CODES:
        return TIER_CODES[tier]
    return _code_from_words((wave or {}).get("name", ""), 3) or "T"


async def ensure_event_code(event: dict) -> str:
    """The event's code, assigned once and then never recomputed.

    Stability is the whole point: serials are printed, emailed and filed, so renaming an
    event in the CMS six months later must not change what a ticket issued today says it
    is. Collisions are broken with a numeric suffix rather than shared, because two events
    sharing a code makes every serial in both ambiguous.
    """
    existing = event.get("event_code")
    if existing:
        return existing

    base = event_code_for(event.get("title", ""))
    code = base
    n = 1
    while await db.events.find_one({"event_code": code, "event_id": {"$ne": event.get("event_id")}}, {"_id": 1}):
        n += 1
        code = f"{base}{n}"

    await db.events.update_one({"event_id": event["event_id"]}, {"$set": {"event_code": code}})
    return code


async def next_serial(event_id: str, event_code: str, type_code: str) -> str:
    """Allocate the next number in one (event, type) sequence.

    `find_one_and_update` with `$inc` and an upsert is the whole concurrency story: the
    increment happens inside the database, so two checkouts completing in the same
    millisecond take two different numbers. Doing this by counting existing tickets would
    hand both the same one — and a duplicated fiscal serial is not a bug you can fix
    afterwards, because the tickets are already out.
    """
    key = f"{event_id}:{type_code}"
    doc = await db.serial_counters.find_one_and_update(
        {"_id": key},
        {"$inc": {"seq": 1}},
        upsert=True,
        return_document=ReturnDocument.AFTER,
    )
    seq = doc["seq"]
    # Four digits is room for 9999 per tier per event; beyond that it simply grows rather
    # than wrapping, because a wrapped serial would repeat a number already issued.
    return f"{SERIAL_PREFIX}-{event_code}-{type_code}-{seq:04d}"


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
# Computed once at import, on the main thread, before any request exists.
_DUMMY_HASH = hash_password("timing-equalizer-not-a-real-password")


# bcrypt at cost 12 is ~250-300ms of CPU, and the two functions above are blocking. Called
# straight from an async handler they stall the whole event loop for that long — not just
# the caller's request, but every other request the worker is serving, ticket purchases
# included. Under Vercel this never showed: one request per function instance, and the
# platform added instances. On a long-lived uvicorn worker it is the difference between a
# login costing one person 300ms and costing everyone 300ms.
#
# The threadpool is the right home for it: bcrypt releases the GIL while hashing, so
# several run genuinely in parallel across cores while the loop keeps accepting requests.
# Route handlers must use these; the sync versions above remain for import-time use.
async def hash_password_async(pw: str) -> str:
    return await asyncio.to_thread(hash_password, pw)


async def verify_password_async(pw: str, hashed: Optional[str]) -> bool:
    return await asyncio.to_thread(verify_password, pw, hashed)


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


# Anything below 0x20, plus DEL. CR and LF are the ones that matter — an address is a
# mail header value, and a newline inside one starts a new header — but a tab or a NUL in
# an address is equally meaningless, so the whole class goes.
_EMAIL_FORBIDDEN = frozenset(chr(c) for c in range(0x20)) | {"\x7f"}


def _password_fingerprint(password_hash: str) -> str:
    """A value that changes when the password does, and discloses nothing (audit L1).

    The reset token carries this so it can be single-use: the token is bound to the
    password it was issued against, and any change invalidates it without storing a list
    of spent tokens.

    It used to carry `password_hash[-12:]` — twelve characters of the bcrypt hash itself.
    A JWT payload is base64, not encrypted, so anyone who saw the reset URL (a proxy log,
    a browser history, a forwarded email) could read a fragment of the stored hash. Not
    practically crackable without the salt, but there was never a reason to publish it: a
    digest of the hash invalidates identically and reveals nothing about the input.
    """
    return hashlib.sha256(password_hash.encode("utf-8")).hexdigest()[:32]


def _valid_email(email: str) -> bool:
    """Deliberately loose on shape, strict on control characters (audit M12).

    The audit noted this did not reject CR/LF and called it "safe only because the mailer
    talks JSON to Resend". That premise expired when the SMTP backend landed: `_build_mime`
    now builds real headers from this value. Python's `EmailMessage` does refuse a header
    containing CR/LF — so injection was still blocked — but `send_mail` swallows provider
    exceptions on purpose (an email failure must never fail a paid-ticket finalization), so
    the outcome was a *silent non-delivery* traceable only through a logged exception.

    Rejecting here turns that into a 400 at the point of entry, which is where the person
    who typed it can see it.

    `strip()` alone was never enough: it only removes leading and trailing whitespace, and
    the payload is interior. Worse, the domain check reads `split("@")[-1]`, so
    "a@b.com\r\nBcc: attacker@evil.example" was validated against `evil.example` — a
    well-formed domain — and passed.
    """
    email = (email or "").strip()
    if _EMAIL_FORBIDDEN & set(email):
        return False
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


def _email_rate_check(bucket: str, identity: str, max_calls: int, window: int):
    """Identity-keyed sibling of rate_limit() (which keys on IP). Named for its first
    caller; `identity` is any stable string — an email on the auth routes, a user_id on
    the admin ones. Guards password login against distributed brute force of one account
    from many IPs.

    Called from inside the handler rather than as a route dependency, and that placement
    is the point on authenticated routes: FastAPI resolves `dependencies=[...]` *before*
    the handler's own parameter dependencies, so an IP-keyed limiter there runs before
    require_admin and lets anonymous traffic spend a real admin's budget. See
    SECURITY.md → "Rate limiting — which of the two to reach for".

    Shares _rate_check so this table is bounded too — it is keyed on attacker-supplied
    email addresses, so it was the easier half of the H2 memory-exhaustion problem.
    """
    with _rate_lock:
        # Case-folded so an email is canonical; user_ids are already lowercase.
        retry_after = _rate_check(bucket, (identity or "").strip().lower(), max_calls, window)
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

class RegisterIn(ApiModel):
    email: str
    password: str
    first_name: str = ""
    last_name: str = ""
    phone: str = ""
    tos_accepted: bool = False
    email_opt_in: bool = False
    news_opt_in: bool = False
    promo_opt_in: bool = False


class LoginIn(ApiModel):
    email: str
    password: str


class ConsentsIn(ApiModel):
    email_opt_in: Optional[bool] = None
    news_opt_in: Optional[bool] = None
    promo_opt_in: Optional[bool] = None


class ForgotPasswordIn(ApiModel):
    email: str


class ResetPasswordIn(ApiModel):
    token: str
    new_password: str


class ProfileUpdate(ApiModel):
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    phone: Optional[str] = None


class ResendVerifyIn(ApiModel):
    email: str


# Ceilings for the list fields on an artist. Not editorial limits — the point is the
# same one models_base.py makes for strings: "arbitrarily many" should be impossible,
# without telling an editor how to do their job.
MAX_DISCIPLINES = 24
MAX_ARTIST_ALBUMS = 60
# Posters on one event. A sanity bound, not a rule about promotion: a handful of pieces of
# artwork is the case, and a four-figure list is a paste that went wrong.
MAX_EVENT_POSTERS = 24


class ArtistIn(ApiModel):
    name: str
    slug: str
    bio: str = Field(default="", max_length=LONG_TEXT)
    image_url: str = ""
    links: dict = {}
    # Drawn from the managed vocabulary in site_settings (see get_disciplines), but
    # stored as plain strings rather than ids on purpose: retiring a discipline from the
    # list must not silently rewrite every artist who already carried it.
    disciplines: List[str] = Field(default_factory=list, max_length=MAX_DISCIPLINES)
    # Galleries chosen by hand rather than derived from the artist's events. An artist
    # can appear in the album for a night they did not headline, and one event may have
    # several albums, so the link is its own decision.
    album_ids: List[str] = Field(default_factory=list, max_length=MAX_ARTIST_ALBUMS)
    # Resident or guest. A vocabulary of exactly two, closed on purpose: it drives a
    # filter on the roster, and a third value nobody planned for would silently create a
    # tab-less group of artists reachable only from "All".
    collab: str = "resident"
    # One outside project of the artist's own — their band, their label, their studio.
    # This is NOT the retired `projects` collection: that was a Supersanity-side record
    # with its own page furniture, and this is a name and a link the artist gives us.
    other_project_name: str = ""
    other_project_url: str = ""


class DisciplinesIn(ApiModel):
    """The whole vocabulary, replaced wholesale — it is a short ordered list an admin
    edits as one thing, not a set of rows each with an id of its own."""
    disciplines: List[str] = Field(default_factory=list, max_length=MAX_DISCIPLINES)


class WaveIn(ApiModel):
    name: str
    price_ron: float
    capacity: int
    starts_at: str
    ends_at: str
    # What orders the tiers a buyer is offered: lowest first. An editor's handle on the
    # running order, which used to be whatever order the tiers happened to be added in.
    tier_id: Optional[int] = None
    # Kept, no longer editable. It fed the ticket serial's type code and the exports, and
    # existing waves still carry the value they were given; new ones leave it empty and
    # let the wave's own name stand for the type instead. See wave_type_code.
    tier: str = ""
    # The two ends of a tier's admission window. At most ONE is ever set: the editor
    # picks which end they mean, so a wave says either "not after this" or "not before
    # it", never both. Blank is no rule at all, which is how every event behaved before
    # either field existed.
    #
    # `access_from` was here once, stored the same thing, and was read by nothing — see
    # the note on retire_access_from below before assuming that history repeats. It is
    # enforced at the door now, exactly as `access_until` is.
    access_until: Optional[str] = None
    access_from: Optional[str] = None
    # Offered, listed-but-closed, or hidden. See WAVE_STATUSES for what each one does and
    # why archiving is the answer to deleting a tier that has already sold.
    status: str = "active"
    # Tickets issued per purchase. 1 is an ordinary tier; anything above it is a group
    # ticket, where `price_ron` is the price of the WHOLE pack and `capacity` still counts
    # individual tickets — so a 200-ticket tier selling in fours has fifty packs in it.
    pack_size: int = 1
    # The two selling rules, moved down from the event: one person's limit ON THIS TIER,
    # and what to say when THIS TIER runs out. Both are overrides — None and blank mean
    # the tier has no opinion and the event's own value stands, which is what every wave
    # written before these fields existed says. See wave_ticket_cap.
    #
    # ge=1 rather than ge=0: a tier nobody may buy from is a paused tier, and saying it
    # twice invites the two to disagree. It also keeps `is None` the only inherit signal,
    # so a deliberate cap can never be mistaken for an absent one.
    max_tickets_per_user: Optional[int] = Field(default=None, ge=1)
    sold_out_message: str = ""


class EventIn(ApiModel):
    title: str
    slug: str
    description: str = Field(default="", max_length=LONG_TEXT)
    venue: str = ""
    city: str = ""
    starts_at: str
    ends_at: Optional[str] = None
    doors_open_at: Optional[str] = None
    # The MAIN ARTWORK: the one poster that stands for the event everywhere it is named
    # from somewhere else — a card, a notice email, the top of its own page. It is one of
    # `images`, and stays its own field rather than an index into that list so that every
    # reader of it keeps working without knowing the collection exists.
    image_url: str = ""
    # The shape the cover is cropped to, everywhere the event appears. Chosen with the
    # image rather than by each page that shows it, so one event cannot be 4:3 on its own
    # page and 1:1 in a grid.
    image_aspect: str = "4:3"
    # The poster collection: artwork for THIS event, ordered, `image_url` among it. Kept
    # apart from the event's albums on purpose — an album is a record of a night that
    # happened, and these are the pictures that sell it beforehand.
    images: List[str] = Field(default_factory=list, max_length=MAX_EVENT_POSTERS)
    artist_ids: List[str] = []
    max_tickets_per_user: int = 4
    is_published: bool = False
    sold_out_message: str = ""
    waves: List[WaveIn] = []


class WavePatchIn(WaveIn):
    """A wave as it arrives on an event PATCH: the create shape, plus its id.

    `wave_id` is optional because the same list carries both edits to existing waves and
    brand-new ones; `admin_update_event` tells them apart by whether the id matches a wave
    already on the event.

    `available` is deliberately *not* a field here. Remaining stock is the server's
    number, derived from capacity minus what has sold, and a client that could name it
    could un-sell-out an event by hand.
    """
    wave_id: Optional[str] = None


class EventPatchIn(ApiModel):
    """Partial update for an event. Every field optional; unknown keys are dropped.

    This mirrors `EventIn` rather than reusing it because a PATCH means something
    different: absent is "leave it alone", not "reset it to the default".
    """
    title: Optional[str] = None
    slug: Optional[str] = None
    description: Optional[str] = Field(default=None, max_length=LONG_TEXT)
    venue: Optional[str] = None
    city: Optional[str] = None
    starts_at: Optional[str] = None
    ends_at: Optional[str] = None
    doors_open_at: Optional[str] = None
    image_url: Optional[str] = None
    image_aspect: Optional[str] = None
    images: Optional[List[str]] = Field(default=None, max_length=MAX_EVENT_POSTERS)
    artist_ids: Optional[List[str]] = None
    max_tickets_per_user: Optional[int] = None
    is_published: Optional[bool] = None
    sold_out_message: Optional[str] = None
    waves: Optional[List[WavePatchIn]] = None


class ArtistPatchIn(ApiModel):
    """Partial update for an artist. Same bargain as `EventPatchIn`.

    `links` stays a free-form dict on purpose — it is a bag of social URLs keyed by
    platform — but it is now a *value* being replaced wholesale rather than a set of
    top-level field names, so nothing in it can reach out into the document.
    """
    name: Optional[str] = None
    slug: Optional[str] = None
    bio: Optional[str] = Field(default=None, max_length=LONG_TEXT)
    image_url: Optional[str] = None
    links: Optional[dict] = None
    disciplines: Optional[List[str]] = Field(default=None, max_length=MAX_DISCIPLINES)
    album_ids: Optional[List[str]] = Field(default=None, max_length=MAX_ARTIST_ALBUMS)
    collab: Optional[str] = None
    other_project_name: Optional[str] = None
    other_project_url: Optional[str] = None


class EventNoticeIn(ApiModel):
    """A change announcement an admin sends to an event's ticket holders.

    Typed on purpose, like the patch models above: this endpoint fans a body out to real
    inboxes, so its input is pinned down.
    """
    kind: Literal["venue", "time", "lineup", "cancelled"]
    message: str = Field(min_length=1, max_length=4000)


class DiscountIn(ApiModel):
    code: str
    percent_off: int
    expires_at: Optional[str] = None
    max_uses: int = 0  # 0 = unlimited
    event_id: Optional[str] = None


class SpecialLinkIn(ApiModel):
    event_id: str
    label: str
    price_ron: float
    capacity: int


class ReserveIn(ApiModel):
    event_id: str
    wave_id: str
    quantity: int
    discount_code: Optional[str] = None
    special_link_token: Optional[str] = None


class CheckoutIn(ApiModel):
    """Audit M7: `origin_url` used to live here and was handed to Stripe as the
    success/cancel redirect. The client was telling the server something the server
    already knows — the only caller sent `window.location.origin`, which is
    `PUBLIC_APP_URL`. Removed rather than validated: a field nobody needs is not worth an
    allowlist, and the shop checkout has always derived its own paths server-side."""
    reservation_id: str


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
    # One shared policy with the reset path. Two copies of `len(pw) < 8` is how the two
    # ends of the same rule drift apart, and the drift nobody notices is the one where
    # signup accepts what reset would refuse.
    bad = await password_policy.validate(
        body.password, email=email, name=f"{first_name} {last_name}")
    if bad:
        raise HTTPException(400, bad)
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
        "password_hash": await hash_password_async(body.password),
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
    if not u or not await verify_password_async(body.password, u.get("password_hash")):
        if not u:
            await verify_password_async(body.password, _DUMMY_HASH)
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
    # Per-address as well as per-IP. The IP bucket alone stops one host hammering the
    # endpoint; it does nothing about many hosts hammering one *victim*, and every request
    # that gets through sends a real email from our domain to an address the caller chose.
    # That is a mail-bomb with our sending reputation behind it — the same impact H1
    # described, reached by having many keys rather than faking them.
    #
    # Keyed on the address whether or not an account exists, so it stays silent about that:
    # a 429 means "this address has been asked for recently", never "this address is real".
    _email_rate_check("auth_forgot_email", email, 3, 900)
    u = await db.users.find_one({"email": email}, {"_id": 0})
    # Only send when a password account actually exists, but ALWAYS return ok
    # (no account enumeration).
    if u and u.get("password_hash"):
        token = make_token("pwd-reset", u["user_id"], {"ph": _password_fingerprint(u["password_hash"])})
        await send_mail("password_reset", email, {"reset_url": f"{PUBLIC_APP_URL}/reset-password?token={token}"})
    return {"ok": True}


@api.post("/auth/reset-password", dependencies=[Depends(rate_limit("auth_reset", 5, 900))])
async def reset_password(body: ResetPasswordIn, response: Response):
    # The rules that need neither the token nor the database run first: a password that
    # cannot be accepted under any circumstances should not cost a token read.
    problems = password_policy.local_problems(body.new_password)
    if problems:
        raise HTTPException(400, password_policy.message(problems))
    try:
        claims = read_token("pwd-reset", body.token)
    except jwt.PyJWTError:
        raise HTTPException(400, "This reset link is invalid or has expired")
    u = await db.users.find_one({"user_id": claims["sub"]}, {"_id": 0})
    # Single-use: the token is bound to the password hash it was minted against, so
    # any password change (or reuse of a spent token) invalidates it.
    if not u or not u.get("password_hash") or \
            not secrets.compare_digest(_password_fingerprint(u["password_hash"]), claims.get("ph") or ""):
        raise HTTPException(400, "This reset link is invalid or has expired")
    # The account is known now, so the rules that depend on it can run — the name/email
    # similarity check, and the breach lookup. Still BEFORE the update, which is what
    # actually burns the token: a refusal here leaves the link usable, which is the
    # difference between "try again" and "request another email and hope it arrives".
    bad = await password_policy.validate(
        body.new_password, email=u.get("email", ""),
        name=" ".join(filter(None, [u.get("first_name"), u.get("last_name")])))
    if bad:
        raise HTTPException(400, bad)
    await db.users.update_one(
        {"user_id": u["user_id"]},
        {"$set": {"password_hash": await hash_password_async(body.new_password)}},
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
    # Bounded individually: FastAPI builds the body model for a Form() signature itself,
    # and that generated class does not inherit ApiModel, so the config-level ceiling does
    # not apply here (audit M9). Sizes are Apple's shapes with headroom — an id_token is a
    # JWT of roughly a kilobyte, `user` a small JSON object sent once.
    id_token: str = Form("", max_length=8_000),
    state: str = Form("", max_length=500),
    user: str = Form("", max_length=4_000),  # JSON {name:{firstName,lastName}, email} — first authorization ONLY
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

# The starting vocabulary an artist's disciplines are drawn from. A SEED, not a fixed
# set: the live list is a single editable setting, so adding "Aerial" is an edit in the
# admin rather than a redeploy — the same bargain get_vat_rate makes for the VAT rate.
DISCIPLINES_DEFAULT = [
    "Choreographer", "Curator", "Dancer", "DJ", "Installation", "Light Design",
    "Live Act", "Performance Art", "Photographer", "Producer", "Sound Design",
    "Visual Artist", "VJ", "Vocalist",
]


def _alpha(value: str) -> tuple:
    """Sort key for a vocabulary a person reads: case-insensitive, with the original as a
    tiebreak so "DJ" and "dj" have a stable order rather than an arbitrary one."""
    return (value.casefold(), value)


async def get_disciplines() -> List[str]:
    """The discipline vocabulary as it stands right now.

    Read per request rather than cached at import, for the same reason the VAT rate is:
    an edit has to take effect on the next form without restarting every serverless
    instance.
    """
    doc = await db.site_settings.find_one({"_id": "artists"}, {"_id": 0, "disciplines": 1})
    if doc and isinstance(doc.get("disciplines"), list):
        # Sorted on read as well as on write: a value stored before this was the rule, or
        # edited into the database directly, still comes back in order.
        return sorted((str(d) for d in doc["disciplines"]), key=_alpha)
    return list(DISCIPLINES_DEFAULT)


async def set_disciplines(values: List[str]) -> List[str]:
    """Replace the vocabulary. Blanks and duplicates are dropped and the result is A-Z.

    Sorted rather than kept in the order typed: this is a list to FIND a discipline in,
    not a ranking, and it is read in three places — the manager, the artist form's
    multiselect, and the artist page. An order that depends on the sequence someone
    added them in is an order none of those three can explain.

    Deliberately does NOT touch `artists.disciplines`. Retiring a discipline stops it
    being offered on new edits; it does not reach into every artist who already had it
    and delete it. A settings edit that silently rewrites content is the kind of thing
    nobody notices until the content is wrong.
    """
    cleaned: List[str] = []
    for v in values:
        v = (v or "").strip()
        if v and v not in cleaned:
            cleaned.append(v)
    cleaned.sort(key=_alpha)
    await db.site_settings.update_one(
        {"_id": "artists"}, {"$set": {"disciplines": cleaned}}, upsert=True
    )
    return cleaned


def _valid_external_url(url: str) -> bool:
    """An outside link an editor typed. http(s) only — unlike `_valid_media_url` this
    does not accept our own root-relative paths, because "other projects" means
    elsewhere, and it must never carry `javascript:` or a protocol-relative `//host`.
    """
    u = (url or "").strip()
    if u.startswith("//"):
        return False
    return u.startswith(("http://", "https://"))


@api.get("/artists")
async def list_artists():
    """The roster, A-Z.

    Sorted here rather than by Mongo, whose default collation is bytewise: it files every
    lowercase name after every uppercase one, so a roster of shouty stage names looks
    sorted right up until somebody types "dj rosa". The list is capped at 200, so folding
    the case in Python costs nothing.
    """
    items = await db.artists.find({}, {"_id": 0}).to_list(200)
    items.sort(key=lambda a: (a.get("name") or "").casefold())
    return items


@api.get("/artists/{slug}")
async def get_artist(slug: str):
    """One artist, with everything their page renders already attached.

    Albums are resolved here rather than fetched separately by the client: the page
    draws them in one pass, and two round trips to paint one screen is two chances to
    paint half of it.
    """
    a = await db.artists.find_one({"slug": slug}, {"_id": 0})
    if not a:
        raise HTTPException(404, "Not found")

    # Only albums a visitor is allowed to see. An admin can link an album belonging to a
    # draft event, and this page must not be the way that leaks — so the hand-picked ids
    # are intersected with the same visibility rule the Gallery page runs on.
    album_ids = a.get("album_ids") or []
    a["albums"] = [
        al for al in await _albums_with_items(
            {"$and": [{"album_id": {"$in": album_ids}}, await _public_album_query()]}
        ) if al["count"]
    ] if album_ids else []
    return a


@api.get("/events")
async def list_events(upcoming: Optional[bool] = None):
    """Published events. `upcoming` is a tri-state, not a boolean.

    Omitted means EVERY published event, newest first — the "All" tab. It used to default
    to True, so there was no way to ask for the whole programme in one request and the
    page had to choose a half. Every caller in this repo passes the parameter explicitly,
    so nothing changes shape underneath them; an outside consumer calling bare /events
    now gets past events too, which is the point of the parameter being three-valued.
    """
    now_iso = now_utc().isoformat()
    query = {"is_published": True}
    # An event stays "upcoming" for its whole duration, not just until it starts —
    # judged by ends_at, falling back to starts_at only when no end time is set.
    if upcoming is True:
        query["$or"] = [
            {"ends_at": {"$gte": now_iso}},
            {"ends_at": None, "starts_at": {"$gte": now_iso}},
            {"ends_at": {"$exists": False}, "starts_at": {"$gte": now_iso}},
        ]
    elif upcoming is False:
        query["$or"] = [
            {"ends_at": {"$lt": now_iso}},
            {"ends_at": None, "starts_at": {"$lt": now_iso}},
            {"ends_at": {"$exists": False}, "starts_at": {"$lt": now_iso}},
        ]
    # upcoming is None: no time filter at all.
    # All and Past both read newest-first; only Upcoming counts forwards from now.
    items = await db.events.find(query, {"_id": 0}).sort("starts_at", 1 if upcoming else -1).to_list(200)
    # Batch-fetch albums for every listed event at once instead of N+1, so cards can
    # show a cover photo without a per-event round trip.
    albums = await _albums_with_items({"event_id": {"$in": [e["event_id"] for e in items]}})
    albums_by_event = {}
    for a in albums:
        albums_by_event.setdefault(a["event_id"], []).append(a)
    for e in items:
        # Archived tiers are not stock. Their remaining capacity is deliberately withheld
        # from sale, so counting it would tell a card there are tickets left on an event
        # whose every buyable tier is gone.
        e["total_available"] = sum(
            max(0, w.get("available", w.get("capacity", 0)))
            for w in e.get("waves", []) if wave_status(w) != "archived")
        e["albums"] = albums_by_event.get(e["event_id"], [])
        # An event can hold several albums now, but a card still wants one flat run of
        # media for its cover and its count, so both shapes are served.
        e["gallery"] = [g for a in e["albums"] for g in a["items"]]
    return items


@api.get("/events/{slug}")
async def get_event(slug: str):
    e = await db.events.find_one({"slug": slug, "is_published": True}, {"_id": 0})
    if not e:
        raise HTTPException(404, "Not found")
    now_iso = now_utc().isoformat()
    active_waves = []
    for w in e.get("waves", []):
        status = wave_status(w)
        # Archived is withheld from the page rather than shown greyed out. A paused tier
        # is one an editor still wants a buyer to see — "VIP, back shortly" — and an
        # archived one is a tier they have taken down; showing it would advertise
        # something nobody can ever buy, including the tier they archived by mistake and
        # are about to bring back.
        if status == "archived":
            continue
        w["status"] = status
        w["pack_size"] = wave_pack_size(w)
        # Selling is a state AND a window. Paused fails the first, which is what keeps the
        # tier on the page and out of the checkout at the same time.
        w["is_active"] = status == "active" and w["starts_at"] <= now_iso <= w["ends_at"]
        w["available"] = max(0, w.get("available", w.get("capacity", 0)))
        # The ANSWER to the inheritance, not the override that asks the question. The
        # buyer's quantity dropdown is built from this and the checkout is refused against
        # wave_ticket_cap, so the two have to be the same number; sending it resolved is
        # what stops the browser from owning a second copy of the rule that decides it.
        #
        # `max_tickets_per_user` stays untouched beside it, still null where a tier
        # inherits. The admin form reads that one, and a resolved value there would freeze
        # today's event cap onto every tier that was happily following it.
        w["ticket_cap"] = wave_ticket_cap(e, w)
        active_waves.append(w)
    e["waves"] = active_waves
    # Albums the event carries, in album order, each with its own title and items —
    # plus the same flat run of media the event page used to get as `gallery`.
    e["albums"] = await _albums_with_items({"event_id": e["event_id"]})
    e["gallery"] = [g for a in e["albums"] for g in a["items"]]
    return e


@api.get("/gallery")
async def gallery():
    """Flat feed of recent media — what the `gallery_grid` CMS block renders. Albums are
    how the Gallery page organises itself, not how this endpoint does: a block asking for
    six photos wants the six most recent ones, whichever album they live in.

    Visibility still follows the album, though. This used to read the sitewide bucket
    alone, so media attached to a draft event could never surface here; drawing from
    every album without the same check would put an unpublished event's photos on the
    homepage.
    """
    visible = await db.albums.find(await _public_album_query(), {"_id": 0, "album_id": 1}).to_list(500)
    return await db.gallery.find(
        {"album_id": {"$in": [a["album_id"] for a in visible]}}, {"_id": 0}
    ).sort([("created_at", -1)]).to_list(200)


# ----- Albums -----
#
# An album is a record of its own in `db.albums`, with its own title, slug, description
# and cover. It MAY name an event, and one event may have several albums — but an album
# needs no event at all, which is the entire reason the collection exists: a gallery can
# be created on its own and linked (or unlinked) later, from either side.
#
# Gallery items belong to an album via `album_id`. They used to be bucketed by `event_id`
# directly, with `None` meaning one hard-coded sitewide gallery whose title and slug lived
# in a `site_settings` singleton; migrate_gallery_albums converts both of those shapes.

_SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def _slugify(value: str) -> str:
    """Lowercase, ASCII-ish, hyphen-separated. Accepts what an editor types
    ("Live Documentation") and returns what a URL needs ("live-documentation")."""
    s = re.sub(r"[^a-z0-9]+", "-", (value or "").strip().lower())
    return s.strip("-")


async def _unique_album_slug(base: str, exclude_id: Optional[str] = None) -> str:
    """`base`, or `base-2`, `base-3`… — an album's slug is the address it lives at, so
    two albums cannot share one. Renaming an album passes its own id as `exclude_id`,
    or every save would push the slug one number further along.

    Event albums used to borrow the event's slug, which stopped being available the
    moment an event could have more than one album.
    """
    slug = _slugify(base) or "album"
    candidate, n = slug, 1
    while await db.albums.find_one({"slug": candidate, "album_id": {"$ne": exclude_id}}, {"_id": 1}):
        n += 1
        candidate = f"{slug}-{n}"
    return candidate


def _album_cover(items: List[dict]) -> Optional[dict]:
    """The explicitly chosen cover, else the first item in the album's order, else
    nothing at all — an album with no media has no tile to show."""
    if not items:
        return None
    return next((g for g in items if g.get("is_cover")), items[0])


def _album_sort_key(album: dict) -> str:
    """The day an album is filed under: its own date, or failing that the day it was
    created.

    The fallback is what keeps a dateless album in a sensible place. Sorting on `date`
    alone would collapse every album that has never been given one into a single tie at
    the end of the grid, which is worse than the creation order they had before.

    Both readings are YYYY-MM-DD, so a string compare is a date compare — `created_at`
    is a full ISO timestamp and gets cut down to its day so the two are the same shape.
    """
    return (album.get("date") or (album.get("created_at") or "")[:10]) or ""


async def _albums_with_items(query: dict) -> List[dict]:
    """Albums matching `query`, each carrying its items, cover and count, newest first.

    Two queries regardless of how many albums come back, rather than one per album:
    the Gallery page and the admin both need every album's cover at once.

    Ordering is by date, and it is done here rather than in the query because the key is
    a fallback the database cannot express in a plain sort. The list is capped at 500,
    so this is a sort of hundreds of dicts, not a scan.
    """
    albums = await db.albums.find(query, {"_id": 0}).sort("created_at", 1).to_list(500)
    # Stable, so albums sharing a date stay in the creation order the query returned
    # them in rather than shuffling between requests.
    albums.sort(key=_album_sort_key, reverse=True)
    items = await db.gallery.find(
        {"album_id": {"$in": [a["album_id"] for a in albums]}}, {"_id": 0}
    ).sort([("sort_order", 1), ("created_at", 1)]).to_list(5000)

    by_album = {}
    for g in items:
        by_album.setdefault(g["album_id"], []).append(g)
    for a in albums:
        a["items"] = by_album.get(a["album_id"], [])
        a["count"] = len(a["items"])
        a["cover"] = _album_cover(a["items"])
    return albums


async def _public_album_query() -> dict:
    """Which albums a visitor may see: every unlinked one, plus those whose event is
    published. An album attached to a draft event stays out of sight along with it,
    which is what event albums did before they were records of their own."""
    live = await db.events.find({"is_published": True}, {"_id": 0, "event_id": 1}).to_list(1000)
    return {"$or": [{"event_id": None}, {"event_id": {"$in": [e["event_id"] for e in live]}}]}


@api.get("/gallery/clusters")
async def gallery_clusters():
    """Powers the public Gallery page: one cover tile per album — linked to an event or
    not, they are the same kind of thing now — so hundreds of photos don't flood the
    grid. Empty albums are left out: a tile with no cover has nothing to show."""
    albums = await _albums_with_items(await _public_album_query())
    return {"albums": [a for a in albums if a["count"]]}


@api.get("/gallery/albums/{slug}")
async def gallery_album(slug: str):
    """One album and everything in it — the album's own page at /gallery/<slug>."""
    album = await db.albums.find_one({"slug": slug}, {"_id": 0})
    if not album:
        raise HTTPException(404, "Not found")

    event = None
    if album.get("event_id"):
        event = await db.events.find_one(
            {"event_id": album["event_id"], "is_published": True},
            {"_id": 0, "event_id": 1, "title": 1, "slug": 1},
        )
        # Linked to an event that is unpublished or gone: the album is not public either.
        if not event:
            raise HTTPException(404, "Not found")

    full = (await _albums_with_items({"album_id": album["album_id"]}))[0]
    full["event"] = event
    return full


class ContactMsg(ApiModel):
    name: str
    email: str
    message: str = Field(max_length=LONG_TEXT)


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

class NewsletterIn(ApiModel):
    email: str
    source: Optional[str] = None  # optional label ("home hero", "footer", …)


class NewsletterUnsubIn(ApiModel):
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
    # Same reasoning as /auth/forgot-password: double opt-in means every call mails a
    # confirmation to an address the caller names, so an IP-only limit is a per-attacker
    # limit rather than a per-victim one. Checked after validation so a malformed address
    # cannot spend a real address's budget.
    _email_rate_check("newsletter_email", email, 3, 3600)
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


async def _release_reservation_holds(r: dict):
    """Give back whatever a reservation was holding — the mirror of the holds taken in
    create_reservation. Special-link reservations hold link capacity; every other one
    holds wave stock. Keeping both in one place is what stops the two from drifting."""
    if r.get("special_link_token"):
        # Floored at zero. A bare $inc credits the link whether or not this reservation
        # was still holding anything, and a link whose `used` goes negative hands out
        # invite capacity that was never bought back.
        await db.special_links.update_one(
            {"token": r["special_link_token"]},
            [{"$set": {"used": {"$max": [0, {"$subtract": ["$used", r["quantity"]]}]}}}],
        )
    else:
        # Capped at the wave's own capacity, for the mirror reason: `available` above
        # `capacity` is inventory that was never sold and cannot be honoured at the door.
        # A pipeline update rather than $inc because the ceiling is another field's value,
        # which a plain update expression cannot read. $map rebuilds the array because the
        # positional operator is not available inside a pipeline.
        await db.events.update_one(
            {"event_id": r["event_id"], "waves.wave_id": r["wave_id"]},
            [{"$set": {"waves": {"$map": {
                "input": "$waves",
                "as": "w",
                "in": {"$cond": [
                    {"$eq": ["$$w.wave_id", r["wave_id"]]},
                    {"$mergeObjects": ["$$w", {"available": {"$min": [
                        {"$add": [{"$ifNull": ["$$w.available", "$$w.capacity"]}, r["quantity"]]},
                        "$$w.capacity",
                    ]}}]},
                    "$$w",
                ]},
            }}}}],
        )


async def _cleanup_expired_reservations(event_id: Optional[str] = None):
    """Return held stock from expired unpaid reservations, across every event.

    Audit L4: this used to filter on `event_id`, and it only runs when somebody reserves.
    So an abandoned checkout on a quiet event held its seats until the next person tried
    to buy for *that same event* — which, on a show that is not selling, may be never. The
    stock was withheld precisely where it was least affordable.

    Sweeping globally costs nothing extra: the query is already indexed on status and
    bounded to 500, and the reservation that triggers it pays the same round trip either
    way. `event_id` survives as an optional narrowing for callers that want it.
    """
    now_iso = now_utc().isoformat()
    query = {"status": "pending", "expires_at": {"$lt": now_iso}}
    if event_id is not None:
        query["event_id"] = event_id
    expired = await db.reservations.find(query).to_list(500)
    for r in expired:
        # Flip the status first: the release is idempotent only as long as exactly one
        # sweep claims each reservation. A concurrent sweep that loses this race sees
        # nothing pending and returns the stock zero times rather than twice.
        claimed = await db.reservations.update_one(
            {"reservation_id": r["reservation_id"], "status": "pending"},
            {"$set": {"status": "expired"}},
        )
        if claimed.modified_count == 1:
            await _release_reservation_holds(r)


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

    await _cleanup_expired_reservations()   # every event, not just this one (audit L4)
    event = await db.events.find_one({"event_id": body.event_id}, {"_id": 0})

    wave = _find_wave(event, body.wave_id)
    unit_price, pack_size, special = await _resolve_pricing_source(body, event, wave)

    # `body.quantity` is what the buyer picked — tickets on an ordinary tier, PACKS on a
    # group one. From here on the two are kept apart by name, because every rule below
    # counts one or the other and never both: stock, the per-user cap and the issue loop
    # count tickets; the price counts units.
    pack_count = body.quantity
    ticket_count = pack_count * pack_size

    # Cheap rejection for the obvious case. Not the guarantee — _confirm_user_ticket_cap
    # after the insert is, because only then does this request have a position other
    # concurrent requests can see.
    await _precheck_user_ticket_cap(event, wave, user["user_id"], ticket_count)
    discount_percent, discount_code_used = await _apply_discount(body, using_special=bool(special))

    subtotal = unit_price * pack_count
    discount_amount = subtotal * (discount_percent / 100.0)
    total = round(subtotal - discount_amount, 2)

    # Take the hold. A special link draws down its own capacity; everything else draws
    # down wave stock. Both are conditional single-document writes, so the check and the
    # decrement cannot be separated by a concurrent request.
    if special:
        await _atomic_hold_special_link(body.special_link_token, body.event_id, ticket_count)
    else:
        await _atomic_hold_wave_stock(body.event_id, body.wave_id, ticket_count)

    doc = {
        "reservation_id": new_id("res"),
        "user_id": user["user_id"],
        "event_id": body.event_id,
        "wave_id": body.wave_id,
        # Still tickets, unchanged in meaning. Everything that already read this field —
        # the holds, their release, the cap, the issue loop, the invoice — goes on
        # counting the same things it always counted, which is why packs did not have to
        # be threaded through any of them.
        "quantity": ticket_count,
        "pack_size": pack_size,
        "pack_count": pack_count,
        # The price of one unit: one ticket, or one whole pack. `subtotal_ron` is this
        # times `pack_count`, NOT times `quantity` — for a pack those differ, and the
        # subtotal is the one that was charged.
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

    if not await _confirm_user_ticket_cap(event, wave, user["user_id"], doc):
        # Delete before releasing. A crash between the two leaves stock held by nothing,
        # which the expiry sweep and an admin can both recover. The other order would
        # leave a live reservation holding stock already given back — an oversell, and
        # the failure this whole function exists to prevent.
        await db.reservations.delete_one({"reservation_id": doc["reservation_id"]})
        await _release_reservation_holds(doc)
        cap = wave_ticket_cap(event, wave)
        raise HTTPException(400, f"Ticket limit reached ({cap} per user)")

    return {**{k: v for k, v in doc.items() if k != "_id"}, "hold_minutes": HOLD_MINUTES}


async def _user_ticket_count(event_id: str, user_id: str, wave_id: str) -> int:
    """Tickets this person already holds ON ONE TIER.

    Scoped to the wave because the cap is: holding six on general admission says nothing
    about how many four-packs the same person may take.
    """
    return await db.tickets.count_documents(
        {"event_id": event_id, "user_id": user_id, "wave_id": wave_id})


async def _precheck_user_ticket_cap(event, wave, user_id: str, quantity: int):
    """Fast path only — rejects a request already over the cap before doing any work.

    Racy by nature, and deliberately so: it reads a pre-state that a concurrent request
    can invalidate. _confirm_user_ticket_cap is what actually enforces the cap.
    """
    max_per_user = wave_ticket_cap(event, wave)
    wave_id = wave["wave_id"]
    existing = await _user_ticket_count(event["event_id"], user_id, wave_id)
    pending_docs = await db.reservations.find(
        {"event_id": event["event_id"], "user_id": user_id, "wave_id": wave_id, "status": "pending"},
        {"_id": 0, "quantity": 1},
    ).to_list(50)
    pending_qty = sum(r["quantity"] for r in pending_docs)
    if existing + pending_qty + quantity > max_per_user:
        raise HTTPException(400, f"Ticket limit reached ({max_per_user} per user)")


async def _confirm_user_ticket_cap(event, wave, user_id: str, doc: dict) -> bool:
    """SECURITY [M5 — fixed]: enforce the per-user cap *after* the reservation exists.

    Counting before inserting is unfixable without a transaction: every concurrent
    request reads the same pre-state and every one of them passes. Counting afterwards
    is, because by then each request has a row the others can see.

    The rule is a total order — (created_at, reservation_id) — evaluated identically by
    every racer, so they agree on which of them fit without needing to coordinate. Each
    keeps only what the reservations ahead of it leave room for; the rest roll back. No
    lock, no transaction, and no arrangement of concurrent callers oversells.

    A racer that queries before a rolled-back sibling is deleted counts a reservation
    that no longer exists and gives up its own place. That direction is safe — it
    under-sells by one, and the caller can retry.

    Every count here is scoped to ONE TIER, because the cap is. The peers that can crowd
    this reservation out are the ones on the same wave; a reservation the same buyer holds
    on another tier is counted against that tier's own cap, not this one.
    """
    cap = wave_ticket_cap(event, wave)
    wave_id = wave["wave_id"]
    issued = await _user_ticket_count(event["event_id"], user_id, wave_id)
    peers = await db.reservations.find(
        {"event_id": event["event_id"], "user_id": user_id, "wave_id": wave_id, "status": "pending"},
        {"_id": 0, "reservation_id": 1, "quantity": 1, "created_at": 1},
    ).to_list(200)

    mine = (doc["created_at"], doc["reservation_id"])
    ahead = sum(
        p["quantity"] for p in peers
        if (p.get("created_at", ""), p["reservation_id"]) < mine
    )
    return issued + ahead + doc["quantity"] <= cap


def _find_wave(event, wave_id: str):
    for w in event.get("waves", []):
        if w["wave_id"] == wave_id:
            return w
    raise HTTPException(404, "Wave not found")


async def _resolve_pricing_source(body: "ReserveIn", event, wave):
    """Return (unit_price, pack_size, special_doc_or_None).

    `unit_price` is the price of ONE THING THE BUYER PICKED — a ticket on an ordinary
    tier, a whole pack on a group one — and `pack_size` is how many tickets that thing
    turns into. Everything downstream multiplies with those two: stock and the per-user
    cap count tickets, the money counts units.

    Special links always sell singles. A link is a hand-made price for a named guest, and
    a pack size on top of it would be two overrides of the same tier fighting each other.
    """
    now_iso = now_utc().isoformat()
    if body.special_link_token:
        special = await db.special_links.find_one(
            {"token": body.special_link_token, "event_id": body.event_id}, {"_id": 0}
        )
        if not special:
            raise HTTPException(400, "Invalid special link")
        # Capacity hint only, exactly like the wave branch below — the binding check is
        # the conditional $inc in _atomic_hold_special_link.
        if special.get("used", 0) + body.quantity > special["capacity"]:
            raise HTTPException(400, "Special link capacity exceeded")
        return float(special["price_ron"]), 1, special
    # A tier has to be sellable before it has to be in its window: "no longer on sale"
    # and "not on sale yet" are different things to be told, and an archived tier is the
    # first even when its dates say the second.
    status = wave_status(wave)
    if status == "archived":
        raise HTTPException(400, "This tier is no longer on sale")
    if status == "paused":
        raise HTTPException(400, "This tier is not on sale right now")
    # Regular wave path: enforce sale window + inventory hint (atomic decrement will re-check)
    if not (wave["starts_at"] <= now_iso <= wave["ends_at"]):
        raise HTTPException(400, "Wave not active")
    pack_size = wave_pack_size(wave)
    if wave.get("available", wave["capacity"]) < body.quantity * pack_size:
        raise HTTPException(400, "Not enough tickets available")
    return float(wave["price_ron"]), pack_size, None


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


async def _atomic_hold_special_link(token: str, event_id: str, quantity: int):
    """SECURITY [M4 — fixed]: hold special-link capacity at reserve time, atomically.

    `used` used to be incremented only once a reservation was paid, so nothing held
    capacity across the reserve→pay window and N concurrent reservations against one
    invite link all passed the check and could all be paid. It now draws down on the
    same conditional-write pattern as wave stock, and the expiry sweep gives it back.

    `$expr` compares against the document's own `capacity` rather than a value read
    earlier, so an admin editing capacity mid-flight cannot widen the window either.
    """
    upd = await db.special_links.update_one(
        {
            "token": token,
            "event_id": event_id,
            "$expr": {"$lte": [
                {"$add": [{"$ifNull": ["$used", 0]}, quantity]},
                "$capacity",
            ]},
        },
        {"$inc": {"used": quantity}},
    )
    if upd.modified_count != 1:
        raise HTTPException(400, "Special link capacity exceeded")


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

    # Server-side, from configuration — never from the request (audit M7). Matches what
    # `shop_checkout` has always done with its own success_path/cancel_path.
    origin = PUBLIC_APP_URL.rstrip("/")
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

    Redirect targets are built from PUBLIC_APP_URL rather than anything the client sent.
    This helper always did; the ticket path took an `origin_url` from the request body
    until audit M7 was closed, and now derives it the same way.
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

    # Create tickets. Two identifiers each: the unguessable `qr_code` the door trusts,
    # and the sequential `serial` a fiscal report is written against. See the serial
    # helpers near the top of this module for why those cannot be the same string.
    event_doc = await db.events.find_one({"event_id": r["event_id"]}, {"_id": 0}) or {}
    wave = next((w for w in event_doc.get("waves", []) if w.get("wave_id") == r["wave_id"]), {})
    event_code = await ensure_event_code(event_doc) if event_doc.get("event_id") else "EVT"
    type_code = wave_type_code(wave)

    # What each ticket is individually worth, and which pack it came in.
    #
    # A group tier is bought as one line — four for the price of three, 300 RON — and
    # issued as four separate tickets. Each one carries 75, its real share of the 300,
    # because a ticket is refunded on its own: a guest turned away at the door is owed
    # what they paid for their seat, and neither 100 nor 0 is that number. The shares are
    # split in whole cents and add back up to the pack price exactly, so the fiscal
    # summary still multiplies out.
    #
    # `pack_size` defaults to 1 for every reservation written before packs existed, which
    # makes the general case here identical to what it was: one ticket, the unit price.
    pack_size = max(1, int(r.get("pack_size") or 1))
    pack_count = int(r.get("pack_count") or 0) or (r["quantity"] // pack_size)
    per_pack_prices = _pack_ticket_prices(r["unit_price_ron"], pack_size)
    pack_ids = [new_id("pack") for _ in range(pack_count)]
    prices = per_pack_prices * pack_count
    if len(prices) != r["quantity"]:
        # A legacy or hand-edited reservation whose parts do not multiply out. Falling
        # back to a flat unit price is wrong for a pack but right for everything that
        # predates them, and it beats issuing the wrong NUMBER of tickets.
        prices = [r["unit_price_ron"]] * r["quantity"]
        pack_ids = []

    tickets = []
    for i in range(r["quantity"]):
        qr = f"SNTY-{uuid.uuid4().hex[:20].upper()}"
        t = {
            "ticket_id": new_id("tkt"),
            "qr_code": qr,
            # Allocated one at a time rather than as a block: the counter is the only
            # thing standing between two simultaneous checkouts and a duplicated serial.
            "serial": await next_serial(r["event_id"], event_code, type_code),
            "event_code": event_code,
            "type_code": type_code,
            "reservation_id": reservation_id,
            "user_id": r["user_id"],
            "event_id": r["event_id"],
            "wave_id": r["wave_id"],
            "wave_name": wave.get("name", ""),
            "tier": wave.get("tier", ""),
            "price_ron": prices[i],
            "status": "issued",
            "scanned_at": None,
            "scanned_by": None,
            "created_at": now_utc().isoformat(),
        }
        if pack_size > 1 and pack_ids:
            # Which pack this ticket belongs to and where it sits in it. The id is what
            # lets an admin see the four tickets of one group together; without it they
            # are four unrelated rows that happen to share a reservation with everything
            # else on that order.
            t["pack_id"] = pack_ids[i // pack_size]
            t["pack_size"] = pack_size
            t["pack_index"] = (i % pack_size) + 1
            t["pack_price_ron"] = round(float(r["unit_price_ron"]), 2)
        tickets.append(t)
    if tickets:
        await db.tickets.insert_many(tickets)

    # Increment discount uses
    if r.get("discount_code"):
        await db.discounts.update_one({"code": r["discount_code"]}, {"$inc": {"uses": 1}})
    # Special-link usage is NOT incremented here. It was drawn down when the reservation
    # was created (_atomic_hold_special_link), which is what makes the capacity a real
    # hold rather than a count of completed payments. Incrementing again would charge the
    # link twice for one reservation.

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


def _public_payment_status(tx: dict) -> dict:
    """The three fields the success pages read, and nothing else (audit L2)."""
    out = {"payment_status": tx.get("payment_status"), "status": tx.get("status")}
    if tx.get("order_id"):
        out["order_id"] = tx["order_id"]
    return out


@api.get("/payments/status/{session_id}")
async def payment_status(session_id: str, request: Request):
    """Poll a Checkout Session's outcome. Deliberately unauthenticated (audit L2).

    The post-Stripe success page has to poll this before its session cookie is
    re-established, so requiring auth would break the one flow it exists for.

    What it *returns* is now narrow. It used to hand back the whole transaction row —
    `user_id`, the amount, everything — to anyone holding a session id. Unguessable is not
    the same as authorised, and the page only ever read three fields. `order_id` is a
    pointer rather than data: `GET /shop/orders/{id}` is ownership-checked, so knowing the
    id buys nothing on its own.

    The fake branch below MARKS THE ORDER PAID and issues real tickets. That is reachable
    only under an explicit LOCAL_FAKE_PAYMENTS=1, which the startup guard refuses under
    APP_ENV=production, so it cannot exist on a production host (audit C1).
    """
    tx = await db.payment_transactions.find_one({"session_id": session_id}, {"_id": 0})
    if not tx:
        raise HTTPException(404, "Transaction not found")
    if tx["payment_status"] == "paid":
        return _public_payment_status(tx)

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
    fresh = await db.payment_transactions.find_one({"session_id": session_id}, {"_id": 0})
    return _public_payment_status(fresh)


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

class ScanIn(ApiModel):
    qr_code: str
    # Set by the door when a human has looked at an expired-access verdict and decided to
    # let the guest in anyway. Never defaulted true: the point is that somebody chose.
    override: bool = False
    override_reason: str = Field(default="", max_length=200)


class ScanDenyIn(ApiModel):
    qr_code: str
    # Why someone was turned away is most of the value of the record — an unexplained
    # denial is hard to defend later. Optional because the door is not the place to
    # force typing, and a blank reason is better than a wrong one.
    reason: str = Field(default="", max_length=200)


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

    # Outside this tier's admission window. Deliberately NOT an automatic refusal: the
    # guest is standing there holding a ticket they paid for, and arriving early or late
    # is a judgement call, not a rule. The door is shown the situation and decides;
    # either outcome is recorded against the person who made it.
    #
    # Which end was crossed is carried separately from the fact that one was, because
    # "you are early" and "you are late" send the guest to different places — one waits,
    # the other has missed it.
    wave = next((w for w in ev.get("waves", []) if w.get("wave_id") == t.get("wave_id")), {})
    access_until = wave.get("access_until")
    access_from = wave.get("access_from")
    outside = None
    if access_until and now_iso > access_until:
        outside = {"reason": "ACCESS EXPIRED", "edge": "late", "access_until": access_until}
    elif access_from and now_iso < access_from:
        outside = {"reason": "ACCESS NOT YET OPEN", "edge": "early", "access_from": access_from}
    if outside and not body.override:
        return {
            "valid": False,
            "needs_override": True,
            "wave_name": wave.get("name", ""),
            "ticket": t,
            "event": ev,
            **outside,
        }

    # first-scan-wins
    admit = {"status": "used", "scanned_at": now_iso, "scanned_by": user["user_id"]}
    if body.override:
        # Kept on the ticket, not only in the audit log, so the record travels with the
        # thing it describes when tickets are exported for a fiscal return.
        admit["override_by"] = user["user_id"]
        admit["override_at"] = now_iso
        admit["override_reason"] = (body.override_reason.strip()
                                    or "admitted outside this tier's access window")
    upd = await db.tickets.update_one(
        {"qr_code": body.qr_code, "status": "issued"},
        {"$set": admit},
    )
    if upd.modified_count != 1:
        t2 = await db.tickets.find_one({"qr_code": body.qr_code}, {"_id": 0})
        return {"valid": False, "reason": "ALREADY SCANNED", "ticket": t2, "event": ev}

    ticket = await db.tickets.find_one({"qr_code": body.qr_code}, {"_id": 0})
    if body.override:
        await _audit(user["user_id"], "door_override_admit", "ticket", ticket["ticket_id"],
                     {"event_id": ticket["event_id"], "access_until": access_until,
                      "access_from": access_from,
                      "reason": ticket.get("override_reason", "")})
    return {"valid": True, "ticket": ticket, "event": ev, "overridden": bool(body.override)}


@api.post("/scan/deny")
async def deny_ticket(body: ScanDenyIn, user=Depends(require_admin_or_door)):
    """Turn a guest away whose ticket was otherwise good.

    The opposite outcome to /scan, and until now unrecordable: someone refused at the
    door for no ID, intoxication or a refused search was left marked `used`, identical in
    the data to someone who walked in. `denied` is terminal — scan_ticket only admits
    `issued`, so a denied guest cannot rescan their way back in.

    `used` -> `denied` covers the original case: the button appears on a valid verdict,
    and a valid verdict has just marked the ticket used.

    `issued` -> `denied` covers the other one. A ticket past its tier's access cut-off is
    handed back to the door as a decision rather than admitted, so at the moment it is
    rejected it has never been marked used — and without this it could not be recorded as
    refused either, which is the gap that made the whole expired-access flow pointless.

    Same conditional-write shape as the scan itself, so two doors pressing at once
    resolve to one decision.
    """
    t = await db.tickets.find_one({"qr_code": body.qr_code}, {"_id": 0})
    if not t:
        return {"ok": False, "reason": "TICKET NOT FOUND"}

    # Idempotent on purpose. Door staff work on a phone at the edge of the wifi; a lost
    # response followed by a retry must not report failure for a decision that landed.
    if t["status"] == "denied":
        return {"ok": True, "reason": "ALREADY DENIED", "ticket": t}

    now_iso = now_utc().isoformat()
    upd = await db.tickets.update_one(
        {"qr_code": body.qr_code, "status": {"$in": ["used", "issued"]}},
        {"$set": {
            "status": "denied",
            "denied_at": now_iso,
            "denied_by": user["user_id"],
            "deny_reason": body.reason.strip(),
        }},
    )
    if upd.modified_count != 1:
        current = await db.tickets.find_one({"qr_code": body.qr_code}, {"_id": 0})
        return {"ok": False, "reason": f"CANNOT DENY — TICKET {current['status'].upper()}",
                "ticket": current}

    ticket = await db.tickets.find_one({"qr_code": body.qr_code}, {"_id": 0})
    await _audit(user["user_id"], "door_deny", "ticket", ticket["ticket_id"],
                 {"event_id": ticket["event_id"], "reason": ticket.get("deny_reason", "")})
    return {"ok": True, "ticket": ticket}


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


def _csv_param(value: Optional[str]) -> List[str]:
    """A repeatable filter arrives as one comma-separated value.

    Chosen over repeated `?status=a&status=b` because these query strings are also built
    by hand when someone reproduces a figure, and one readable parameter beats four.
    A single value still parses to a list of one, so every caller that predates
    multi-select keeps working unchanged.
    """
    if not value:
        return []
    return [v.strip() for v in value.split(",") if v.strip()]


def _ticket_status_filter(status: Optional[str]) -> dict:
    """Turn one or more ticket statuses into a query fragment.

    `denied` and `cancelled` match on their timestamps rather than the status field, for
    the same reason /admin/tickets does it: both end at `refunded` once the money goes
    back, so matching the current status would hide every settled case. Shared here so
    the stats cards, the CSV and the fiscal summary all mean the same thing by a word.

    Several statuses are an OR, which is the only reading that makes sense of a filter
    row: ticking `issued` and `used` asks for tickets that are either, not tickets that
    are somehow both.
    """
    wanted = _csv_param(status)
    if not wanted:
        return {}

    unknown = [s for s in wanted if s not in TICKET_STATUSES]
    if unknown:
        raise HTTPException(400, f"Unknown status. Expected one of: {', '.join(TICKET_STATUSES)}")

    clauses = []
    plain = []
    for s in wanted:
        field = _TICKET_HISTORY_FIELDS.get(s)
        if field:
            clauses.append({field: {"$exists": True}})
        else:
            plain.append(s)
    if plain:
        clauses.append({"status": {"$in": plain}})

    if len(clauses) == 1:
        return clauses[0]
    # $or rather than merging keys: a timestamp clause and a status clause on the same
    # document would otherwise AND together and match nothing.
    return {"$or": clauses}


def _event_filter(event_id: Optional[str]) -> dict:
    ids = _csv_param(event_id)
    if not ids:
        return {}
    return {"event_id": ids[0] if len(ids) == 1 else {"$in": ids}}


@api.get("/admin/stats")
async def admin_stats(
    event_id: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    status: Optional[str] = None,
    user=Depends(require_admin),
):
    # Same scope applied to every metric so the cards stay mutually consistent.
    scope = {**_created_range(date_from, date_to), **_event_filter(event_id)}
    # Ticket-only: an order has its own statuses, and narrowing orders by a TICKET status
    # would silently answer a different question than the one on screen.
    ticket_scope = {**scope, **_ticket_status_filter(status)}

    total_orders = await db.reservations.count_documents({**scope, "status": "paid"})
    total_tickets = await db.tickets.count_documents(ticket_scope)
    scanned = await db.tickets.count_documents({**ticket_scope, "status": "used"})
    revenue_docs = await db.reservations.find({**scope, "status": "paid"}, {"_id": 0, "total_ron": 1}).to_list(5000)
    revenue = sum(r["total_ron"] for r in revenue_docs)
    # Unfiltered this is the catalogue size. Once any filter is on, counting the
    # whole catalogue (or events *scheduled* in the window, which reads as 0 for a
    # backward-looking range) would be the odd one out among four sales metrics —
    # so it becomes "how many events actually sold in this slice".
    if event_id or date_from or date_to or status:
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
    """Every event, each tier carrying what has actually been issued from it.

    `sold` and `held` are what the editor's delete button is gated on. They are counted
    here, in one aggregation across every listed event, rather than derived client-side
    from capacity minus available — that difference is sales AND live holds AND any
    manual capacity edit, which is a fine thing to show a promoter and a terrible thing to
    decide a deletion on.
    """
    events = await db.events.find({}, {"_id": 0}).sort("starts_at", -1).to_list(500)
    ids = [e["event_id"] for e in events]
    sold = {r["_id"]: r["n"] for r in await db.tickets.aggregate([
        {"$match": {"event_id": {"$in": ids}}},
        {"$group": {"_id": "$wave_id", "n": {"$sum": 1}}},
    ]).to_list(20000)}
    held = {r["_id"]: r["n"] for r in await db.reservations.aggregate([
        {"$match": {"event_id": {"$in": ids}, "status": "pending"}},
        {"$group": {"_id": "$wave_id", "n": {"$sum": "$quantity"}}},
    ]).to_list(20000)}
    for e in events:
        for w in e.get("waves", []):
            wid = w.get("wave_id")
            w["sold"] = sold.get(wid, 0)
            w["held"] = held.get(wid, 0)
            # Sent explicitly rather than left to the client to default, so an event
            # saved before either field existed reads the same as one saved after.
            w["status"] = wave_status(w)
            w["pack_size"] = wave_pack_size(w)
    return events


@api.post("/admin/events")
async def admin_create_event(body: EventIn, user=Depends(require_admin)):
    e = body.model_dump()
    _check_image_aspect(e)
    _check_event_images(e)
    e["event_id"] = new_id("evt")
    waves = []
    for w in e.get("waves", []):
        w["wave_id"] = new_id("wave")
        w["available"] = w["capacity"]
        waves.append(w)
    _check_access_window(waves)
    _check_wave_states(waves)
    e["waves"] = _sorted_waves(waves)
    e["created_at"] = now_utc().isoformat()
    await db.events.insert_one(e)
    # Assigned here rather than at first sale so the code is visible in the admin before
    # anything is sold, and stays put if the title is edited afterwards.
    e["event_code"] = await ensure_event_code(e)
    return {**{k: v for k, v in e.items() if k != "_id"}}


async def _wave_sales(event_id: str, wave_ids: Optional[List[str]] = None) -> dict:
    """Tickets issued per tier, and stock currently held by unpaid reservations.

    `sold` counts EVERY ticket row, refunded and cancelled ones included. That is
    deliberate: a refunded ticket still carries a fiscal serial allocated against this
    tier, and the tier has to stay resolvable for the export that serial appears in. The
    number answers "may this tier be deleted", and the answer is no the moment one ticket
    has ever been issued from it — refunding it afterwards does not unissue it.

    `held` is separate because a live checkout is not a sale yet but is still a reason not
    to pull the tier out from under it.
    """
    match = {"event_id": event_id}
    if wave_ids is not None:
        match["wave_id"] = {"$in": list(wave_ids)}
    sold = {r["_id"]: r["n"] for r in await db.tickets.aggregate([
        {"$match": match},
        {"$group": {"_id": "$wave_id", "n": {"$sum": 1}}},
    ]).to_list(1000)}
    held = {r["_id"]: r["n"] for r in await db.reservations.aggregate([
        {"$match": {**match, "status": "pending"}},
        {"$group": {"_id": "$wave_id", "n": {"$sum": "$quantity"}}},
    ]).to_list(1000)}
    return {wid: {"sold": sold.get(wid, 0), "held": held.get(wid, 0)}
            for wid in set(sold) | set(held) | set(wave_ids or ())}


async def _guard_dropped_waves(event_id: str, before: dict, kept: set) -> None:
    """Refuse to delete a tier that has sold, or that a live checkout is holding.

    A PATCH says what the tier list IS, so a tier left out of it is a tier deleted — which
    until now happened silently, taking with it the row the door reads an access window
    from and the row an export reads a tier name from. A tier with nothing against it is
    still free to go; one with tickets behind it has to be archived instead, which hides
    it from buyers while leaving every one of those tickets valid and indexed.
    """
    dropped = [wid for wid in before if wid not in kept]
    if not dropped:
        return
    sales = await _wave_sales(event_id, dropped)
    blocked = [wid for wid in dropped
               if sales.get(wid, {}).get("sold") or sales.get(wid, {}).get("held")]
    if not blocked:
        return
    names = ", ".join(f"\"{before[wid].get('name') or wid}\"" for wid in blocked)
    counts = sum(sales[wid]["sold"] for wid in blocked)
    raise HTTPException(
        400,
        f"{names} cannot be deleted — {counts} ticket(s) have been issued against it and "
        "those sales stay valid. Archive the tier instead: it disappears from the event "
        "page and stops selling, and you can bring it back at any time."
        if counts else
        f"{names} cannot be deleted — a checkout is holding tickets from it right now. "
        "Archive the tier instead, or try again once the hold expires.",
    )


@api.patch("/admin/events/{event_id}")
async def admin_update_event(event_id: str, body: EventPatchIn, user=Depends(require_admin)):
    """Write only the fields the caller actually sent.

    This used to take a bare `dict` and `$set` it wholesale (audit M6). Two things came
    with that. Every `EventIn` validator was skipped — but worse, the *key names* were the
    caller's to choose, so a dotted path like `waves.0.available` went straight into
    `$set` and rewrote wave stock Mongo-side without ever passing through the
    reconciliation below. `EventPatchIn` closes both ends: unknown keys are dropped rather
    than written, and `available` is not a name a client can reach.

    `exclude_unset` is what keeps this a PATCH rather than a replace. Without it every
    omitted field would be written back as its model default, so a request as small as
    `{"is_published": true}` would blank the title along the way.
    """
    patch = body.model_dump(exclude_unset=True)
    _check_image_aspect(patch)
    _check_event_images(patch)

    # An explicit `"waves": null` means "leave the lineup alone", not "delete every wave" —
    # the destructive reading of a field a client may well send as empty.
    if patch.get("waves") is None:
        patch.pop("waves", None)
    else:
        # Dumped from the models rather than taken from `patch`, so wave defaults (`tier`,
        # `access_until`) materialise instead of vanishing under `exclude_unset`.
        existing = await db.events.find_one({"event_id": event_id}, {"_id": 0})
        by_id = {w["wave_id"]: w for w in (existing.get("waves", []) if existing else [])}
        new_waves = []
        for w in (wave.model_dump() for wave in body.waves):
            if w.get("wave_id") and w["wave_id"] in by_id:
                prev = by_id[w["wave_id"]]
                # Floored at zero. A wave already carrying more `available` than
                # `capacity` yields a NEGATIVE `sold`, which the line below would then
                # add back on — so the surplus survived every edit, and shrinking the
                # capacity carried it down with it (250/251 became 200/201). Clamping
                # `sold` is what lets an edit heal the row instead of preserving it.
                sold = max(0, prev["capacity"] - prev.get("available", prev["capacity"]))
                w["available"] = max(0, w["capacity"] - sold)
            else:
                w["wave_id"] = new_id("wave")
                w["available"] = w["capacity"]
            new_waves.append(w)
        _check_access_window(new_waves)
        _check_wave_states(new_waves)
        await _guard_dropped_waves(event_id, by_id, {w["wave_id"] for w in new_waves})
        patch["waves"] = _sorted_waves(new_waves)

    # Reachable now in a way it was not before: a body of nothing but unknown keys used to
    # write those keys, and now dumps to {}. Mongo rejects an empty `$set`.
    if patch:
        await db.events.update_one({"event_id": event_id}, {"$set": patch})
    return await db.events.find_one({"event_id": event_id}, {"_id": 0})


@api.delete("/admin/events/{event_id}")
async def admin_delete_event(event_id: str, user=Depends(require_admin)):
    await db.events.delete_one({"event_id": event_id})
    # Its albums outlive it as unlinked galleries rather than pointing at a row that is
    # no longer there. Deleting an event has never deleted its photos, and an album is
    # no longer something the event owns.
    await db.albums.update_many({"event_id": event_id}, {"$set": {"event_id": None}})
    await _audit(user["user_id"], "event_delete", "event", event_id, None)
    return {"ok": True}


@api.post("/admin/events/{event_id}/cancel")
async def admin_cancel_event(event_id: str, user=Depends(require_admin)):
    """Call the event off. Holders keep a `cancelled` ticket until they are refunded.

    These used to be marked `refunded` outright, which said something untrue — the money
    has not moved, and every refund here is settled by hand in the Stripe dashboard. It
    also made "we cancelled the show" indistinguishable from "this buyer was refunded",
    so the one question worth asking afterwards — who is still owed money? — had no
    answer in the data.

    `cancelled` is not terminal: it is the state between calling the show off and paying
    people back, and `admin_refund_ticket` moves it on. `cancelled_at` is what survives
    that move, the way `denied_at` does for a denial, so a refunded cancellation can still
    be told apart from an ordinary one.
    """
    now_iso = now_utc().isoformat()
    await db.events.update_one(
        {"event_id": event_id},
        {"$set": {"is_published": False, "cancelled": True, "cancelled_at": now_iso}},
    )
    # Only `issued`. A `used` ticket belongs to someone already inside, a `denied` one to
    # a decision staff made at the door, and a `refunded` one is already settled — none of
    # those are undone by calling off what remains.
    result = await db.tickets.update_many(
        {"event_id": event_id, "status": "issued"},
        {"$set": {"status": "cancelled", "cancelled_at": now_iso}},
    )
    await _audit(user["user_id"], "event_cancel", "event", event_id,
                 {"tickets_cancelled": result.modified_count})
    return {"ok": True, "tickets_cancelled": result.modified_count}


# ---------- Event change notices ----------
#
# When an event moves, shifts its hour, changes lineup or is called off, the people
# holding tickets have to be told. These are transactional messages about a purchase the
# recipient already made — they carry no List-Unsubscribe header and do not consult the
# newsletter opt-in, unlike /newsletter above.
#
# Nothing here fires on its own: PATCH /admin/events/{id} still saves silently, so a typo
# fix never mails anyone. An admin writes the message and sends it deliberately.

# Labels for the admin UI. The wording used in the email itself lives in
# mailer._NOTICE_HEADLINES, keyed by the same strings as EventNoticeIn.kind.
NOTICE_KINDS = {
    "venue": "Venue / location change",
    "time": "Time or admission change",
    "lineup": "Lineup change",
    "cancelled": "Event cancelled",
}

# Resend takes one HTTP call per recipient, so a sold-out show would otherwise open a
# few hundred connections at once. Small enough to be polite, large enough that a big
# list still drains quickly.
NOTICE_SEND_CONCURRENCY = 5


def _fmt_when(iso: Optional[str]) -> str:
    """ISO timestamp -> something readable in an email; unparseable input passes through."""
    if not iso:
        return ""
    try:
        dt = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return str(iso)
    return dt.strftime("%a %d %b %Y, %H:%M")


# Who still has a stake in what happens to an event. `cancelled` is in here for the case
# that matters most: calling a show off moves every ticket to `cancelled` *before* the
# admin writes the notice, so filtering on `issued` alone would send the cancellation
# announcement to nobody at all. `used` holders are already inside, and `denied` and
# `refunded` have no stake left.
_NOTIFIABLE_TICKET_STATUSES = ("issued", "cancelled")


async def _event_notice_recipients(event_id: str) -> List[dict]:
    """The buyers a notice may reach: anyone still holding a live ticket for this event.

    Deduped on the address, so a buyer holding four tickets is one recipient rather than
    four copies of the same email.
    """
    user_ids = await db.tickets.distinct(
        "user_id", {"event_id": event_id, "status": {"$in": list(_NOTIFIABLE_TICKET_STATUSES)}})
    if not user_ids:
        return []
    recipients, seen = [], set()
    async for u in db.users.find(
        {"user_id": {"$in": user_ids}}, {"_id": 0, "user_id": 1, "email": 1}
    ):
        email = (u.get("email") or "").strip()
        if not email or email.lower() in seen:
            continue
        seen.add(email.lower())
        recipients.append({"user_id": u["user_id"], "email": email})
    return recipients


async def _event_notice_facts(event: dict) -> dict:
    """The event's current state, as the notice template renders it."""
    names = []
    if event.get("artist_ids"):
        artists = await db.artists.find(
            {"artist_id": {"$in": event["artist_ids"]}}, {"_id": 0, "artist_id": 1, "name": 1}
        ).to_list(200)
        by_id = {a["artist_id"]: a.get("name", "") for a in artists}
        names = [by_id[a] for a in event["artist_ids"] if by_id.get(a)]

    # Only absolute URLs go in the banner. Uploads are root-relative under the local
    # storage backend ("/uploads/x.jpg"), and that path resolves to the frontend service
    # on the public origin — a broken image in someone's mail client. Production uses the
    # Blob backend, which returns absolute CDN URLs, so the banner is there where it counts.
    image = event.get("image_url") or ""
    if not re.match(r"^https?://", image):
        image = ""

    return {
        "title": event.get("title", ""),
        "image_url": image,
        "when": _fmt_when(event.get("starts_at")),
        "doors": _fmt_when(event.get("doors_open_at")),
        "where": ", ".join(filter(None, [event.get("venue"), event.get("city")])),
        "lineup": names,
    }


@api.get("/admin/events/{event_id}/notice-preview")
async def admin_event_notice_preview(event_id: str, user=Depends(require_admin)):
    """How far a notice would reach, before one is written. Lets the composer say
    'this goes to 47 people' rather than making the admin guess."""
    event = await db.events.find_one({"event_id": event_id}, {"_id": 0})
    if not event:
        raise HTTPException(404, "Event not found")
    recipients = await _event_notice_recipients(event_id)
    return {
        "event_id": event_id,
        "title": event.get("title", ""),
        "recipient_count": len(recipients),
        "kinds": NOTICE_KINDS,
        "facts": await _event_notice_facts(event),
    }


@api.get("/admin/events/{event_id}/notices")
async def admin_event_notices(event_id: str, user=Depends(require_admin)):
    """What has already gone out for this event, newest first — so the same change
    doesn't get announced twice by two different people."""
    return await db.event_notices.find(
        {"event_id": event_id}, {"_id": 0}
    ).sort("at", -1).to_list(50)


@api.post("/admin/events/{event_id}/notify")
async def admin_event_notify(event_id: str, body: EventNoticeIn, user=Depends(require_admin)):
    # Keyed on the admin, not the IP, and checked *after* require_admin. An IP-keyed
    # `dependencies=[...]` limiter runs before authentication, which would let anonymous
    # traffic spend a real admin's budget and lock them out of announcing a cancellation
    # — the one moment this endpoint matters most. The cap is per-admin-per-hour and
    # generous enough for a festival day's worth of genuine notices.
    _email_rate_check("event_notify", user["user_id"], 30, 3600)

    event = await db.events.find_one({"event_id": event_id}, {"_id": 0})
    if not event:
        raise HTTPException(404, "Event not found")

    recipients = await _event_notice_recipients(event_id)
    facts = await _event_notice_facts(event)
    payload = {
        "kind": body.kind,
        "message": body.message,
        "event": facts,
        "tickets_url": f"{PUBLIC_APP_URL}/my-tickets",
    }

    sem = asyncio.Semaphore(NOTICE_SEND_CONCURRENCY)

    async def _one(r):
        async with sem:
            try:
                res = await send_mail("event_notice", r["email"], dict(payload))
                return bool(res.get("ok"))
            except Exception:
                # send_mail swallows its own failures; this is belt-and-braces so one
                # bad address can never abort the rest of the fan-out.
                logger.exception("event notice send failed for %s", r["user_id"])
                return False

    results = await asyncio.gather(*(_one(r) for r in recipients))
    sent = sum(1 for ok in results if ok)
    failed = len(results) - sent

    notice = {
        "notice_id": new_id("ntc"),
        "event_id": event_id,
        "kind": body.kind,
        "message": body.message,
        "sent_by": user["user_id"],
        "recipient_count": len(recipients),
        "sent": sent,
        "failed": failed,
        "at": now_utc().isoformat(),
    }
    await db.event_notices.insert_one(dict(notice))
    await _audit(user["user_id"], "event_notice", "event", event_id,
                 {"kind": body.kind, "recipients": len(recipients), "sent": sent, "failed": failed})

    return {"ok": True, **{k: v for k, v in notice.items() if k != "_id"}}


@api.get("/admin/orders")
async def admin_orders(user=Depends(require_admin)):
    return await db.reservations.find({}, {"_id": 0}).sort("created_at", -1).limit(500).to_list(500)


@api.post("/admin/orders/{reservation_id}/refund")
async def admin_refund(reservation_id: str, user=Depends(require_admin)):
    """Refund a whole reservation, and put its seats back on sale if they can still sell.

    Audit L3: this marked rows refunded and returned nothing to the wave, so refunded
    inventory was permanently lost — a customer refunded a week before the show left a
    seat nobody could ever buy.

    **Stock comes back only while it is still sellable.** Before the doors, a returned
    seat is a seat someone else can have. After the event has started there is nothing to
    sell it into, and incrementing `available` on a finished show would only corrupt the
    numbers an admin reads afterwards. That is the same rule the door-denial refund
    follows, and it is why `admin_refund_ticket` never returns stock at all: a denial
    happens at the door, which is always after the start.

    The status flip is conditional, so a double-click cannot credit the stock twice —
    the S1 lesson, applied here rather than re-learned.
    """
    reservation = await db.reservations.find_one({"reservation_id": reservation_id}, {"_id": 0})
    if not reservation:
        raise HTTPException(404, "Reservation not found")

    # `paid`, not "anything but refunded". A reservation only ever holds stock while it is
    # `pending`, and the expiry sweep already gave that stock back when it flipped the row
    # to `expired` — so refunding a row in any other state credited the wave for seats it
    # was not holding, and `available` climbed past `capacity`. The statuses are exactly
    # pending -> expired and pending -> paid -> refunded; only the last of those is money
    # that can come back.
    claimed = await db.reservations.update_one(
        {"reservation_id": reservation_id, "status": "paid"},
        {"$set": {"status": "refunded"}},
    )
    if claimed.modified_count != 1:
        already = reservation.get("status") == "refunded"
        return {"ok": True, "already_refunded": already, "not_paid": not already,
                "status": reservation.get("status"), "stock_returned": False}

    await db.tickets.update_many({"reservation_id": reservation_id}, {"$set": {"status": "refunded"}})

    returned = False
    event = await db.events.find_one({"event_id": reservation.get("event_id")},
                                     {"_id": 0, "starts_at": 1})
    if event and parse_dt(event["starts_at"]) > now_utc():
        await _release_reservation_holds(reservation)
        returned = True

    amount = round(float(reservation.get("total_ron") or 0), 2)
    await _audit(user["user_id"], "order_refund", "reservation", reservation_id,
                 {"stock_returned": returned, "refund_amount_ron": amount})
    # The charge itself, not a sum of ticket values: a whole order refunds what was
    # actually taken, discount and all. Per-ticket shares only matter when one seat is
    # being unpicked from an order the rest of which stands.
    return {"ok": True, "stock_returned": returned, "refund_amount_ron": amount}


# Every status a ticket can hold, and who writes it:
#   issued    — _finalize_paid_reservation, when payment lands
#   used      — /scan, first scan wins
#   denied    — /scan/deny, terminal; scan_ticket only admits `issued`
#   cancelled — admin_cancel_event; the show is off and this holder is owed a refund
#   refunded  — whole-order refund, or single-ticket refund
# Kept here rather than inline so the admin filter and the API cannot drift apart.
TICKET_STATUSES = ("issued", "used", "denied", "cancelled", "refunded")

# Two of those are *events that happened* rather than states a ticket rests in: a denial
# and a cancellation both end at `refunded` once the money is returned. Filtering them on
# the current status would hide every settled case — exactly the rows worth auditing — so
# they match on their timestamp instead and a refunded ticket appears under both.
_TICKET_HISTORY_FIELDS = {"denied": "denied_at", "cancelled": "cancelled_at"}


@api.get("/admin/tickets")
async def admin_list_tickets(
    status: Optional[str] = None,
    event_id: Optional[str] = None,
    user=Depends(require_admin),
):
    """Every ticket and where it stands, newest first, optionally filtered.

    `denied` and `cancelled` match on their timestamps rather than the status field — see
    _TICKET_HISTORY_FIELDS. Both end at `refunded` once the money goes back, so filtering
    them on the current status would hide every case that has been settled, which is the
    opposite of what someone auditing them wants.
    """
    if status and status not in TICKET_STATUSES:
        raise HTTPException(400, f"Unknown status. Expected one of: {', '.join(TICKET_STATUSES)}")

    q = {}
    if status:
        history_field = _TICKET_HISTORY_FIELDS.get(status)
        q.update({history_field: {"$exists": True}} if history_field else {"status": status})
    if event_id:
        q["event_id"] = event_id

    tickets = await db.tickets.find(q, {"_id": 0}).sort("created_at", -1).to_list(1000)

    # Counts are computed over the same event scope but ignore the status filter, so the
    # tab labels stay stable as you click between them rather than collapsing to the
    # filter you already chose.
    scope = {"event_id": event_id} if event_id else {}
    counts = {}
    for s in TICKET_STATUSES:
        field = _TICKET_HISTORY_FIELDS.get(s)
        counts[s] = await db.tickets.count_documents(
            {**scope, **({field: {"$exists": True}} if field else {"status": s})})
    counts["all"] = await db.tickets.count_documents(scope)

    if not tickets:
        return {"tickets": [], "counts": counts}

    # Two lookups rather than one per row — N+1 against Mongo for a screen that can list
    # a whole event's tickets is waste the admin pays for on every filter click.
    events = {e["event_id"]: e for e in await db.events.find(
        {"event_id": {"$in": list({t["event_id"] for t in tickets})}},
        {"_id": 0, "event_id": 1, "title": 1, "starts_at": 1, "ends_at": 1}).to_list(500)}
    users = {u["user_id"]: u for u in await db.users.find(
        {"user_id": {"$in": list({t["user_id"] for t in tickets})}},
        {"_id": 0, "user_id": 1, "email": 1, "name": 1}).to_list(1000)}

    return {
        "counts": counts,
        "tickets": [{
            **t,
            "event": events.get(t["event_id"], {}),
            "buyer": users.get(t["user_id"], {}),
        } for t in tickets],
    }


# ---------- Transactions: what gets declared ----------
#
# Two views of the same rows, both filtered exactly like the stats screen so a number
# checked there can be found here.
#
#   the CSV      — one line per ticket, for handing over or importing.
#   the summary  — tickets x price per tier, and the serial range each tier occupies.
#
# The serial range is the reason serials are allocated per event and per type: a tier
# whose numbers run 0001-0150 unbroken is a claim an auditor can verify by counting.


async def _fiscal_tickets(event_id, date_from, date_to, status):
    """The ticket rows a fiscal view is built from, plus the events they belong to."""
    q = {**_created_range(date_from, date_to), **_ticket_status_filter(status),
         **_event_filter(event_id)}
    tickets = await db.tickets.find(q, {"_id": 0}).sort("created_at", 1).to_list(50000)
    events = {e["event_id"]: e for e in await db.events.find(
        {"event_id": {"$in": list({t["event_id"] for t in tickets})}},
        {"_id": 0, "event_id": 1, "title": 1, "event_code": 1, "starts_at": 1, "waves": 1},
    ).to_list(500)}
    return tickets, events


def _wave_of(event: dict, wave_id: str) -> dict:
    return next((w for w in (event or {}).get("waves", []) if w.get("wave_id") == wave_id), {})


def _csv_safe(value) -> str:
    """Neutralize spreadsheet formula injection. A cell opening with =, +, - or @ is
    executed on open by Excel and Sheets, and these rows carry authored text."""
    s = "" if value is None else str(value)
    return "'" + s if s[:1] in ("=", "+", "-", "@") else s


@api.get("/admin/transactions.csv")
async def admin_transactions_csv(
    event_id: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    status: Optional[str] = None,
    user=Depends(require_admin),
):
    """One row per ticket, for declaring sold tickets."""
    from fastapi.responses import PlainTextResponse

    tickets, events = await _fiscal_tickets(event_id, date_from, date_to, status)
    buyers = {u["user_id"]: u for u in await db.users.find(
        {"user_id": {"$in": list({t["user_id"] for t in tickets})}},
        {"_id": 0, "user_id": 1, "email": 1}).to_list(20000)}

    buf = io.StringIO()
    w = csv.writer(buf, quoting=csv.QUOTE_MINIMAL)
    # `price_ron` is this ticket's OWN value — a quarter of a four-for-three pack, not the
    # pack price — so the column still sums to what was charged. `pack_size` and `pack_id`
    # are appended (never inserted) so a reader keyed on column position still works:
    # they say why four rows at 75 belong to one 300 RON sale.
    w.writerow(["serial", "event_code", "event", "event_starts_at", "ticket_type",
                "tier", "price_ron", "status", "issued_at", "scanned_at", "buyer_email",
                "reservation_id", "pack_size", "pack_id"])
    for t in tickets:
        ev = events.get(t["event_id"], {})
        wave = _wave_of(ev, t.get("wave_id"))
        w.writerow([
            _csv_safe(t.get("serial", "")),
            _csv_safe(t.get("event_code") or ev.get("event_code", "")),
            _csv_safe(ev.get("title", "")),
            ev.get("starts_at", ""),
            _csv_safe(t.get("wave_name") or wave.get("name", "")),
            _csv_safe(_ticket_type_label(t, wave)),
            f"{float(t.get('price_ron') or 0):.2f}",
            t.get("status", ""),
            t.get("created_at", ""),
            t.get("scanned_at") or "",
            _csv_safe(buyers.get(t["user_id"], {}).get("email", "")),
            _csv_safe(t.get("reservation_id", "")),
            t.get("pack_size", "") or "",
            _csv_safe(t.get("pack_id", "")),
        ])
    return PlainTextResponse(
        buf.getvalue(),
        headers={"Content-Disposition": "attachment; filename=transactions.csv"},
    )


@api.get("/admin/transactions/summary")
async def admin_transactions_summary(
    event_id: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    status: Optional[str] = None,
    user=Depends(require_admin),
):
    """Tickets x price per tier, and the serial range each tier occupies.

    Grouped by (event, ticket type, PRICE) rather than by tier alone. A tier whose price
    changed mid-sale would otherwise report one line whose count times whose price equals
    nothing that was ever charged — and a total nobody can reconcile is worse than no
    total. Each line multiplies out exactly.
    """
    tickets, events = await _fiscal_tickets(event_id, date_from, date_to, status)

    groups = {}
    for t in tickets:
        ev = events.get(t["event_id"], {})
        wave = _wave_of(ev, t.get("wave_id"))
        price = round(float(t.get("price_ron") or 0), 2)
        key = (t["event_id"], t.get("type_code") or "", price)
        g = groups.setdefault(key, {
            "event_id": t["event_id"],
            "event": ev.get("title", ""),
            "event_code": t.get("event_code") or ev.get("event_code", ""),
            "type_code": t.get("type_code") or "",
            "ticket_type": t.get("wave_name") or wave.get("name", ""),
            "tier": _ticket_type_label(t, wave),
            "unit_price_ron": price,
            "tickets_sold": 0,
            "serials": [],
        })
        g["tickets_sold"] += 1
        if t.get("serial"):
            g["serials"].append(t["serial"])

    lines = []
    for g in groups.values():
        serials = sorted(g.pop("serials"))
        g["serial_first"] = serials[0] if serials else ""
        g["serial_last"] = serials[-1] if serials else ""
        # Tickets issued before serials existed have none, and saying so is better than
        # printing a range that silently covers fewer tickets than the count beside it.
        g["serials_present"] = len(serials)
        g["total_ron"] = round(g["tickets_sold"] * g["unit_price_ron"], 2)
        lines.append(g)

    lines.sort(key=lambda l: (l["event"], l["type_code"], l["unit_price_ron"]))
    return {
        "filters": {"event_id": event_id, "date_from": date_from, "date_to": date_to, "status": status},
        "generated_at": now_utc().isoformat(),
        "lines": lines,
        "tickets_sold": sum(l["tickets_sold"] for l in lines),
        "total_ron": round(sum(l["total_ron"] for l in lines), 2),
        "serials_missing": sum(l["tickets_sold"] - l["serials_present"] for l in lines),
    }


async def _ticket_refund_amount(t: dict) -> float:
    """What one ticket is worth back, to the cent.

    This is the number the admin hands to Stripe, so it has to be the money that ticket
    actually brought in — not the tier's headline price.

    Two things move it off that headline. A group ticket carries its own share of the
    pack: one seat out of a four-for-three pack sold at 300 refunds 75, because 75 is what
    was paid for it. And an order bought with a discount code paid less than list for
    every ticket on it, so the same percentage comes off here — otherwise refunding one
    ticket of a 20%-off order hands back more than the buyer was ever charged.

    Whole-order refunds do not come through here: they return `total_ron`, which is the
    charge itself and needs no reconstruction.
    """
    price = float(t.get("price_ron") or 0)
    r = await db.reservations.find_one(
        {"reservation_id": t.get("reservation_id")}, {"_id": 0, "discount_percent": 1})
    pct = float((r or {}).get("discount_percent") or 0)
    return round(price * (1 - pct / 100.0), 2)


@api.post("/admin/tickets/{ticket_id}/refund")
async def admin_refund_ticket(ticket_id: str, user=Depends(require_admin)):
    """Refund one ticket, not the order it came on.

    admin_refund above refunds a whole reservation, which is right for a cancellation and
    wrong for a denial: turning one guest away must not refund the three friends who got
    in on the same purchase.

    Like that endpoint this only marks the status — the money is returned out-of-band in
    the Stripe dashboard. And like it, wave stock is not returned: a seat at a finished
    event has nothing to sell back into.

    `denied_at` and `deny_reason` are left untouched, so after the status moves on to
    `refunded` the record still says why.
    """
    t = await db.tickets.find_one({"ticket_id": ticket_id}, {"_id": 0})
    if not t:
        raise HTTPException(404, "Ticket not found")
    amount = await _ticket_refund_amount(t)
    if t["status"] == "refunded":
        return {"ok": True, "already": True, "ticket": t, "refund_amount_ron": amount}

    await db.tickets.update_one(
        {"ticket_id": ticket_id},
        {"$set": {"status": "refunded", "refunded_at": now_utc().isoformat(),
                  "refund_amount_ron": amount}},
    )
    await _audit(user["user_id"], "ticket_refund", "ticket", ticket_id,
                 {"event_id": t["event_id"], "was": t["status"],
                  "price_ron": t.get("price_ron"), "refund_amount_ron": amount,
                  **({"pack_id": t["pack_id"], "pack_size": t.get("pack_size"),
                      "pack_price_ron": t.get("pack_price_ron")} if t.get("pack_id") else {})})
    return {"ok": True, "refund_amount_ron": amount,
            "ticket": await db.tickets.find_one({"ticket_id": ticket_id}, {"_id": 0})}


def _sort_artist_disciplines(payload: dict) -> None:
    """A-Z, in place. The multiselect stores them in the order they were clicked, which
    is nobody's idea of an order by the time it reaches the artist's page. Canonicalised
    on write so every reader gets the same list without each one having to sort it."""
    if isinstance(payload.get("disciplines"), list):
        payload["disciplines"] = sorted(
            (str(d) for d in payload["disciplines"]), key=_alpha)


COLLAB_VALUES = ("resident", "guest")
# Mirrors ASPECTS in frontend/src/components/blocks/index.jsx. A value not in that map
# renders as no aspect class at all, which silently collapses the image to nothing.
IMAGE_ASPECTS = ("1:1", "4:3", "3:4", "16:9", "21:9", "3:2", "16:10")


def _check_collab(payload: dict) -> None:
    """Refuse a collab outside the two the filter knows about.

    The roster's tabs are built from this vocabulary, so a third value would put an
    artist in a group with no tab to reach it — visible under "All" and nowhere else,
    with nothing to say why.
    """
    if "collab" not in payload or payload["collab"] is None:
        return
    if payload["collab"] not in COLLAB_VALUES:
        raise HTTPException(400, f"Collab must be one of: {', '.join(COLLAB_VALUES)}")


def _check_image_aspect(payload: dict) -> None:
    if "image_aspect" not in payload or payload["image_aspect"] is None:
        return
    if payload["image_aspect"] not in IMAGE_ASPECTS:
        raise HTTPException(400, f"Image format must be one of: {', '.join(IMAGE_ASPECTS)}")


def _check_event_images(payload: dict) -> None:
    """Every poster has to be something an <img> may be pointed at.

    The same bargain the gallery strikes on its items, for the same reason: these end up in
    a src attribute, so `javascript:`, `data:` and a protocol-relative `//host` are refused
    rather than rendered. Absent means "leave the collection alone" on a PATCH, which is
    why a missing key returns rather than clearing it.

    `image_url` is deliberately NOT required to be a member here. A PATCH may carry either
    field without the other, so the pair can only be checked against a stored event, and
    the page does not need them to agree: eventPosters() puts the main artwork first and
    de-duplicates, so a mismatch renders sensibly instead of 400-ing an editor.
    """
    images = payload.get("images")
    if images is None:
        return
    for url in images:
        if not _valid_media_url(url):
            raise HTTPException(400, f"Not a usable image address: {url!r}")


def _check_artist_payload(patch: dict) -> None:
    """Reject an outside link that is not one. Everything else on an artist is prose an
    admin is trusted with; a URL ends up in an href, which is a different bargain."""
    url = (patch.get("other_project_url") or "").strip()
    if url and not _valid_external_url(url):
        raise HTTPException(400, "Other project link must be a full http(s) URL")


# Declared BEFORE /admin/artists/{artist_id} — FastAPI matches in declaration order, and
# "disciplines" would otherwise be read as an artist id by any same-method route below.
@api.get("/admin/artists/disciplines")
async def admin_get_disciplines(user=Depends(require_admin)):
    return {"disciplines": await get_disciplines()}


@api.put("/admin/artists/disciplines")
async def admin_set_disciplines(body: DisciplinesIn, user=Depends(require_admin)):
    return {"disciplines": await set_disciplines(body.disciplines)}


@api.get("/admin/artists")
async def admin_list_artists(user=Depends(require_admin)):
    """Every artist."""
    return await db.artists.find({}, {"_id": 0}).to_list(500)


@api.post("/admin/artists")
async def admin_create_artist(body: ArtistIn, user=Depends(require_admin)):
    a = body.model_dump()
    _check_artist_payload(a)
    _check_collab(a)
    _sort_artist_disciplines(a)
    a["artist_id"] = new_id("art")
    a["created_at"] = now_utc().isoformat()
    await db.artists.insert_one(a)
    return {k: v for k, v in a.items() if k != "_id"}


@api.patch("/admin/artists/{artist_id}")
async def admin_update_artist(artist_id: str, body: ArtistPatchIn, user=Depends(require_admin)):
    """The other half of M6 — same untyped `$set`, and this one did not even drop
    `artist_id`, so a rename of the primary key was one request away."""
    patch = body.model_dump(exclude_unset=True)
    _check_artist_payload(patch)
    _check_collab(patch)
    _sort_artist_disciplines(patch)
    if patch:
        await db.artists.update_one({"artist_id": artist_id}, {"$set": patch})
    return await db.artists.find_one({"artist_id": artist_id}, {"_id": 0})


@api.delete("/admin/artists/{artist_id}")
async def admin_delete_artist(artist_id: str, user=Depends(require_admin)):
    await db.artists.delete_one({"artist_id": artist_id})
    await db.events.update_many(
        {"artist_ids": artist_id}, {"$pull": {"artist_ids": artist_id}}
    )
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


# ----- Albums (admin) -----


class AlbumIn(ApiModel):
    title: str
    slug: Optional[str] = None
    description: str = ""
    event_id: Optional[str] = None
    # A day, not an instant. An album documents something that happened on a date; the
    # hour it happened at is the event's business, not the gallery's.
    date: Optional[str] = None


class AlbumPatchIn(ApiModel):
    title: Optional[str] = None
    slug: Optional[str] = None
    description: Optional[str] = None
    event_id: Optional[str] = None
    date: Optional[str] = None


_ALBUM_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _album_date(value: Optional[str]) -> Optional[str]:
    """Validate an album's date as a plain YYYY-MM-DD day.

    Blank is a real answer — an album with no date falls back to when it was created —
    so only a value that is present and malformed is an error. The calendar day is
    parsed, not just pattern-matched: "2026-02-31" satisfies the shape and is not a day.
    """
    if value is None:
        return None
    v = value.strip()
    if not v:
        return None
    if not _ALBUM_DATE_RE.match(v):
        raise HTTPException(400, "The date must look like 2026-08-15")
    try:
        date.fromisoformat(v)
    except ValueError:
        raise HTTPException(400, "That is not a real date")
    return v


async def _linked_event_id(event_id: Optional[str]) -> Optional[str]:
    """Validate an album's event link. A blank or absent value is a real answer — an
    unlinked album — so only a named event that does not exist is an error."""
    if not event_id:
        return None
    if not await db.events.find_one({"event_id": event_id}, {"_id": 1}):
        raise HTTPException(400, "That event does not exist")
    return event_id


@api.get("/admin/albums")
async def admin_albums(event_id: Optional[str] = None, user=Depends(require_admin)):
    """Every album, or with `event_id`, only the ones linked to that event. Items ride
    along so the admin can render covers and counts from one request."""
    return await _albums_with_items({} if event_id is None else {"event_id": event_id})


@api.post("/admin/albums")
async def admin_create_album(body: AlbumIn, user=Depends(require_admin)):
    """Create an album. `event_id` is optional and usually absent: an album is made on
    its own, and linked to an event afterwards (from here or from the event form)."""
    title = body.title.strip()
    if not title:
        raise HTTPException(400, "The album needs a title")

    # An editor either types a slug or leaves it blank and means "derive it from the
    # title"; either way it is made unique before it becomes an address.
    slug = await _unique_album_slug(body.slug or title)
    if not _SLUG_RE.match(slug):
        raise HTTPException(400, "The slug must use letters, numbers and hyphens, e.g. live-documentation")

    album = {
        "album_id": new_id("alb"),
        "title": title,
        "slug": slug,
        "description": (body.description or "").strip(),
        "event_id": await _linked_event_id(body.event_id),
        # No sort_order. Albums are ordered by date now, so a position written here
        # would be a number nothing reads — see _album_sort_key.
        "date": _album_date(body.date),
        "created_at": now_utc().isoformat(),
    }
    await db.albums.insert_one(album)
    await _audit(user["user_id"], "album_created", "album", album["album_id"],
                 {"title": title, "event_id": album["event_id"]})
    return {k: v for k, v in album.items() if k != "_id"}


@api.patch("/admin/albums/{album_id}")
async def admin_update_album(album_id: str, body: AlbumPatchIn, user=Depends(require_admin)):
    album = await db.albums.find_one({"album_id": album_id}, {"_id": 0})
    if not album:
        raise HTTPException(404, "Not found")

    updates = {}
    if body.title is not None:
        title = body.title.strip()
        if not title:
            raise HTTPException(400, "The album needs a title")
        updates["title"] = title

    if body.slug is not None:
        slug = await _unique_album_slug(body.slug or updates.get("title", album["title"]), exclude_id=album_id)
        if not _SLUG_RE.match(slug):
            raise HTTPException(400, "The slug must use letters, numbers and hyphens, e.g. live-documentation")
        updates["slug"] = slug

    if body.description is not None:
        updates["description"] = body.description.strip()

    # Linking and unlinking are the same request, and `event_id: null` is the unlink —
    # so an ABSENT key has to mean "leave the link alone", which a plain `is not None`
    # check cannot tell apart from an explicit null. Pydantic records which keys the
    # client actually sent, so ask it.
    if "event_id" in body.model_fields_set:
        updates["event_id"] = await _linked_event_id(body.event_id)

    # Same absent-vs-null distinction: `date: null` clears the date and sends the album
    # back to ordering by its creation day.
    if "date" in body.model_fields_set:
        updates["date"] = _album_date(body.date)

    if updates:
        await db.albums.update_one({"album_id": album_id}, {"$set": updates})
        await _audit(user["user_id"], "album_updated", "album", album_id, updates)
    return await db.albums.find_one({"album_id": album_id}, {"_id": 0})


@api.delete("/admin/albums/{album_id}")
async def admin_delete_album(album_id: str, delete_items: bool = False, user=Depends(require_admin)):
    """Delete an album, and refuse to take media down with it unless asked.

    An album is a name and an ordering — cheap to recreate. The sixty uploads inside it
    are not, and they are unrecoverable once the blobs are gone, so `?delete_items=true`
    is the difference between "I meant this album" and "I meant these photos too".
    """
    album = await db.albums.find_one({"album_id": album_id}, {"_id": 0})
    if not album:
        return {"ok": True}

    items = await db.gallery.find({"album_id": album_id}, {"_id": 0}).to_list(5000)
    if items and not delete_items:
        raise HTTPException(400, f"This album still holds {len(items)} item(s). Move or delete them first.")

    for item in items:
        await _drop_gallery_item(item)
    await db.albums.delete_one({"album_id": album_id})
    await _audit(user["user_id"], "album_deleted", "album", album_id,
                 {"title": album.get("title"), "items": len(items)})
    return {"ok": True, "deleted_items": len(items)}


# ----- Album contents -----


@api.get("/admin/gallery")
async def admin_gallery(album_id: Optional[str] = None, user=Depends(require_admin)):
    """One album's contents, or every item across every album when no album is named."""
    query = {} if album_id is None else {"album_id": album_id}
    return await db.gallery.find(query, {"_id": 0}).sort([("sort_order", 1), ("created_at", 1)]).to_list(500)


class GalleryIn(ApiModel):
    album_id: str
    image_url: str
    thumbnail_url: str = ""
    caption: str = ""
    media_type: str = "image"


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
    # Every item belongs to an album — there is no unfiled bucket to fall back on, so a
    # missing or stale album_id is refused rather than silently orphaning the upload.
    if not await db.albums.find_one({"album_id": g["album_id"]}, {"_id": 1}):
        raise HTTPException(400, "That album does not exist")
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
    # New items land at the end of their own album.
    last = await db.gallery.find({"album_id": g["album_id"]}).sort("sort_order", -1).limit(1).to_list(1)
    g["sort_order"] = (last[0].get("sort_order", -1) + 1) if last else 0
    g["is_cover"] = False
    await db.gallery.insert_one(g)
    return {k: v for k, v in g.items() if k != "_id"}


class GalleryReorderIn(ApiModel):
    album_id: str
    ordered_ids: List[str]


@api.patch("/admin/gallery/reorder")
async def admin_reorder_gallery(body: GalleryReorderIn, user=Depends(require_admin)):
    """Rewrite sort_order to match ordered_ids. Every id must belong to the named
    album — otherwise a stale client could drag an item out of its own album."""
    owned = await db.gallery.find({"album_id": body.album_id}, {"_id": 0, "gallery_id": 1}).to_list(5000)
    owned_ids = {g["gallery_id"] for g in owned}
    unknown = [i for i in body.ordered_ids if i not in owned_ids]
    if unknown:
        raise HTTPException(400, f"{len(unknown)} item(s) do not belong to this album")

    for i, gid in enumerate(body.ordered_ids):
        await db.gallery.update_one({"gallery_id": gid}, {"$set": {"sort_order": i}})
    return {"ok": True, "count": len(body.ordered_ids)}


class GalleryPatchIn(ApiModel):
    caption: Optional[str] = None
    is_cover: Optional[bool] = None
    album_id: Optional[str] = None


@api.patch("/admin/gallery/{gallery_id}")
async def admin_update_gallery(gallery_id: str, body: GalleryPatchIn, user=Depends(require_admin)):
    item = await db.gallery.find_one({"gallery_id": gallery_id}, {"_id": 0})
    if not item:
        raise HTTPException(404, "Not found")

    updates = {}
    if body.caption is not None:
        updates["caption"] = body.caption

    if body.album_id is not None and body.album_id != item.get("album_id"):
        # Moving an item between albums. It lands at the end of the destination and
        # gives up any cover status, which belonged to the album it is leaving.
        if not await db.albums.find_one({"album_id": body.album_id}, {"_id": 1}):
            raise HTTPException(400, "That album does not exist")
        last = await db.gallery.find({"album_id": body.album_id}).sort("sort_order", -1).limit(1).to_list(1)
        updates["album_id"] = body.album_id
        updates["sort_order"] = (last[0].get("sort_order", -1) + 1) if last else 0
        updates["is_cover"] = False
        await _promote_next_cover(item)

    if body.is_cover is not None:
        if body.is_cover:
            # Exactly one cover per album.
            await db.gallery.update_many(
                {"album_id": updates.get("album_id", item.get("album_id"))}, {"$set": {"is_cover": False}}
            )
        updates["is_cover"] = body.is_cover

    if updates:
        await db.gallery.update_one({"gallery_id": gallery_id}, {"$set": updates})
    return await db.gallery.find_one({"gallery_id": gallery_id}, {"_id": 0})


async def _drop_gallery_item(item: dict):
    """Delete one item's row and its bytes. The thumbnail may be the same URL as the
    original (videos without a poster), so guard against deleting it twice."""
    await db.gallery.delete_one({"gallery_id": item["gallery_id"]})
    await storage.delete(item.get("image_url"))
    thumb = item.get("thumbnail_url")
    if thumb and thumb != item.get("image_url"):
        await storage.delete(thumb)


async def _promote_next_cover(item: dict):
    """Hand the cover to the next item in the album, so an album never loses its tile
    because the photo that happened to be the cover was deleted or moved away."""
    if not item.get("is_cover"):
        return
    nxt = await db.gallery.find(
        {"album_id": item.get("album_id"), "gallery_id": {"$ne": item["gallery_id"]}}
    ).sort([("sort_order", 1)]).limit(1).to_list(1)
    if nxt:
        await db.gallery.update_one({"gallery_id": nxt[0]["gallery_id"]}, {"$set": {"is_cover": True}})


@api.delete("/admin/gallery/{gallery_id}")
async def admin_delete_gallery(gallery_id: str, user=Depends(require_admin)):
    item = await db.gallery.find_one({"gallery_id": gallery_id}, {"_id": 0})
    if not item:
        return {"ok": True}
    await _drop_gallery_item(item)
    await _promote_next_cover(item)
    return {"ok": True}


@api.get("/uploads/config")
async def upload_config(user=Depends(require_admin_or_editor)):
    """What this deployment can actually accept, so the editor stops guessing.

    `max_bytes` is what the editor may actually offer, which is not always this process's
    ceiling. Three cases, and the difference between them is the whole point of the
    endpoint:

    * Local disk (a VPS, or a laptop): the request comes straight here, so the ceiling is
      ours — the full MAX_UPLOAD_BYTES.
    * Blob storage with the direct route working: the file never passes through this
      process at all, so again the full ceiling.
    * Blob storage without it: every byte has to fit in a serverless request body, and
      the platform refuses anything much over PLATFORM_BODY_LIMIT_BYTES before this
      function is even reached. Advertising 100 MB here would be a lie the editor only
      discovers by watching a long upload fail.

    So the third case reports the small number. A 90 MB video is then refused up front,
    with the size named, instead of being accepted and lost.
    """
    max_bytes, direct = _upload_limits(storage.is_local(), DIRECT_BLOB_UPLOAD)
    return {
        "max_bytes": max_bytes,
        "direct_upload": direct,
        "direct_upload_url": "/api/blob-upload",
    }


@api.post("/admin/uploads")
async def admin_upload_media(
    file: UploadFile = File(...),
    poster: Optional[UploadFile] = File(None),
    # Editors, not just admins: the CMS is an editor-role tool and its image blocks
    # upload through here, so admin-only made the feature 403 for the exact role it
    # exists for. Not an escalation — an editor can already publish a custom_html block.
    user=Depends(require_admin_or_editor),
):
    """Audit M8 and M9 (uploads). The Content-Type still selects which branch runs, but it
    is no longer *believed*: the bytes are checked against it, and for images the stored
    file is Pillow's output rather than the caller's input.

    Video cannot be re-encoded without ffmpeg, so it gets a container-header check and
    nothing more. That leaves it the weakest of the three defences here — the others being
    the extension allowlist (no HTML or SVG type exists in it) and `/uploads` being served
    with `nosniff` and a sandboxed CSP by both the app and nginx.
    """
    declared = file.content_type or ""
    if declared in IMAGE_CONTENT_TYPES:
        media_type = "image"
    elif declared in VIDEO_CONTENT_TYPES:
        media_type = "video"
    elif declared in AUDIO_CONTENT_TYPES:
        media_type = "audio"
    else:
        raise HTTPException(400, "Unsupported file type — images (JPEG/PNG/WebP/GIF), video "
                                 "(MP4/WebM/MOV) or audio (MP3/WAV/OGG/M4A) only")

    data = await _read_capped(file)

    if media_type == "image":
        # Reassigns all three: re-encoding can legitimately change the format, and the
        # stored extension and Content-Type have to follow the bytes rather than the claim.
        data, content_type, ext = _reencode_image(data, declared)
    elif media_type == "audio":
        _sniff_audio(data, declared)
        content_type, ext = declared, AUDIO_CONTENT_TYPES[declared]
    else:
        _sniff_video(data, declared)
        content_type, ext = declared, VIDEO_CONTENT_TYPES[declared]

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
    elif media_type == "video" and poster is not None:
        # ffmpeg isn't a dependency here, so video posters are captured in the
        # browser at upload time and sent alongside. Treated as untrusted image
        # bytes: re-encoded through Pillow rather than written through as-is.
        #
        # Named to video rather than left as "anything that arrived with a poster":
        # audio comes through here now too, and a sound file has no frame to capture.
        try:
            pdata = await _read_capped(poster)
            _reencode_image(pdata, poster.content_type or "image/jpeg")  # verify, then thumbnail
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
        # An image is its own poster and a video may have had one captured for it. Audio
        # has no picture at all, and saying otherwise would hand a caller the sound file
        # as an image URL.
        "has_poster": bool(thumbnail_url) if media_type in ("video", "audio") else True,
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

    # Gallery. Two albums, neither attached to an event — which is the ordinary case now,
    # and the one the seed should demonstrate. Linking one to an event is a later edit.
    alb1 = {"album_id": new_id("alb"), "title": "FIELD NOTES", "slug": "field-notes",
            "description": "Documentation from the room.", "event_id": None,
            "sort_order": 0, "created_at": now_utc().isoformat()}
    alb2 = {"album_id": new_id("alb"), "title": "CORPUS · RESIDENCY", "slug": "corpus-residency",
            "description": "Stills from the summer residency.", "event_id": None,
            "sort_order": 1, "created_at": now_utc().isoformat()}
    await db.albums.insert_many([alb1, alb2])

    await db.gallery.insert_many([
        {"gallery_id": new_id("gal"), "album_id": alb1["album_id"], "sort_order": 0, "media_type": "image", "is_cover": True, "image_url": "https://images.unsplash.com/photo-1545128485-c400e7702796?crop=entropy&cs=srgb&fm=jpg&q=85", "caption": "Black Room · Night 02", "created_at": now_utc().isoformat()},
        {"gallery_id": new_id("gal"), "album_id": alb1["album_id"], "sort_order": 1, "media_type": "image", "is_cover": False, "image_url": "https://images.unsplash.com/photo-1687511844598-165c1fc387cc?crop=entropy&cs=srgb&fm=jpg&q=85", "caption": "Crowd · Opening", "created_at": now_utc().isoformat()},
        {"gallery_id": new_id("gal"), "album_id": alb2["album_id"], "sort_order": 0, "media_type": "image", "is_cover": True, "image_url": "https://images.unsplash.com/photo-1593408995262-1d8933c37afc?crop=entropy&cs=srgb&fm=jpg&q=85", "caption": "Corpus · Residency", "created_at": now_utc().isoformat()},
        {"gallery_id": new_id("gal"), "album_id": alb2["album_id"], "sort_order": 1, "media_type": "image", "is_cover": False, "image_url": "https://images.unsplash.com/photo-1618601208267-baa5b780b70e?crop=entropy&cs=srgb&fm=jpg&q=85", "caption": "Light installation", "created_at": now_utc().isoformat()},
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

# SECURITY [M3 — fixed]: cross-site request forgery on state-changing routes.
#
# The cookie is SameSite=Lax by default, which already refuses to ride along on a
# cross-site POST. Two things that does not cover, and this middleware does:
#
#   * Subdomains are same-site. SameSite considers anything.example.com same-site with
#     example.com, so a hijacked or user-content subdomain still gets the cookie. An
#     Origin check does not — a different host is a different origin.
#   * The whole protection currently rests on one environment variable. COOKIE_SAMESITE
#     may legitimately be set to "none", and then nothing else stands in the way.
#
# What was actually reachable before this: JSON bodies are safe by accident, because
# application/json forces a CORS preflight the allowlist rejects. multipart/form-data is
# CORS-safelisted and needs no preflight, which left POST /admin/uploads and the CMS font
# upload writable cross-site by an authenticated admin's browser.
#
# A MISSING Origin header is allowed, deliberately. Browsers always send it on a
# cross-origin write, so its absence means the caller is not a browser — the Stripe
# webhook, curl, the test suite on Bearer tokens. Rejecting that would break those and buy
# nothing, since an attacker driving a browser cannot suppress the header.
_CSRF_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS", "TRACE"})

# Sign in with Apple POSTs the callback from Apple's own origin — a legitimate cross-site
# write that this check would otherwise kill. It carries its own `state` cookie for the
# same job. Everything else must come from us.
_CSRF_EXEMPT_PATHS = ("/api/auth/apple/callback",)

# PUBLIC_APP_URL is unioned in on purpose. CORS_ORIGINS only has to list origins that make
# *cross-origin* calls, so on a single-origin deployment it can legitimately omit the app's
# own address — and an Origin check built on that list alone would then reject the
# frontend's own requests. This is the failure that would only show up in production.
_ALLOWED_ORIGINS = frozenset(_cors_origins) | {PUBLIC_APP_URL}


@app.middleware("http")
async def csrf_origin_guard(request: Request, call_next):
    if request.method not in _CSRF_SAFE_METHODS and request.url.path not in _CSRF_EXEMPT_PATHS:
        origin = request.headers.get("origin", "")
        if origin and origin not in _ALLOWED_ORIGINS:
            logger.warning("CSRF: refused %s %s from origin %r",
                           request.method, request.url.path, origin)
            return JSONResponse(status_code=403, content={"detail": "Cross-origin request refused"})
    return await call_next(request)


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
# 6: custom_fonts gained its unique (family, weight, style) index — without the bump an
#    already-initialised database never runs init_indexes again and the upload route's
#    replace-on-conflict guarantee would rest on nothing.
# 9: pages carry `in_footer`, and the footer reads its links from them instead of having
#    three hrefs typed into Layout.jsx. Without the bump migrate_footer_pages never runs
#    on an already-initialised database, and the first deploy renders an EMPTY Legal
#    column — the pages are all still there, nothing marks them as belonging in it.
# 10: the header nav's type size moved from the theme document to the site settings, so
#     it sits with the header's other control instead of under Theme.
# 11: albums carry their own `date`, and the Gallery grid orders by it instead of by a
#     hand-written sort_order. Without the bump migrate_album_dates never runs on an
#     already-initialised database, every album falls back to its creation day, and the
#     grid silently keeps the old order while the CMS claims it is sorted by date.
# 12: tiers carry a `tier_id` and the buyer is offered them lowest-id first. Without the
#     bump migrate_wave_tier_ids never runs, every existing tier stays unnumbered, and
#     they all sort last together — which is the order they were already in, right up
#     until someone saves an event and one tier gets a number.
# 13: Archive is retired. Without the bump migrate_drop_archive_page never runs on an
#     already-seeded database, its cms_pages row survives, and the header goes on
#     offering a nav link to a route that no longer exists.
#
#     NEVER let two branches claim one number. This one and 12 were developed in
#     parallel and both wanted 12. The marker is compared for EQUALITY, not order, so
#     whichever deployed second would have found `current == marker`, skipped setup
#     entirely and run NONE of its migrations. That is not hypothetical — it happened on
#     the dev database while these were being written, and the symptom was an Archive
#     link that would not go away. They merged in order and took one number each.
# 14: artists carry a `collab` of resident or guest, and the roster filters on it.
#     Without the bump migrate_artist_collab never runs, every existing artist stays
#     untagged, and the Residents and Guests tabs come back empty on a site whose roster
#     is full.
# 15: tiers carry a `status` (active/paused/archived) and a `pack_size`. Without the bump
#     migrate_wave_states never runs on an already-initialised database, and every
#     existing tier reaches the admin editor with a blank state control and an empty pack
#     size — which the first save then writes back as the editor's own defaults, one event
#     at a time, for as long as nobody notices.
SCHEMA_VERSION = 15


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
        await db.gallery.create_index([("album_id", 1), ("sort_order", 1)])
        # Albums. The slug is the public address of an album page, so uniqueness is
        # enforced by the database and not only by _unique_album_slug.
        # A fiscal serial that repeats is unfixable after the fact — the tickets are out.
        # The unique index is the backstop behind the atomic counter in next_serial.
        await db.tickets.create_index("serial", unique=True, partialFilterExpression={"serial": {"$type": "string"}})
        await db.tickets.create_index([("event_id", 1), ("type_code", 1)])
        await db.events.create_index("event_code", unique=True, partialFilterExpression={"event_code": {"$type": "string"}})
        await db.albums.create_index("album_id", unique=True)
        await db.albums.create_index("slug", unique=True)
        await db.albums.create_index([("event_id", 1), ("date", -1)])
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
        # Uploaded webfonts. One file per (family, weight, style) — the upload route
        # replaces rather than accumulating, and the unique index is what makes that hold
        # when two uploads of the same face arrive together.
        await db.custom_fonts.create_index([("family", 1), ("weight", 1), ("style", 1)], unique=True)
        await db.custom_fonts.create_index("font_id", unique=True)
        logger.info("Indexes ensured")
    except Exception:
        logger.exception("init_indexes failed")

    try:
        await migrate_wave_tier_ids()
    except Exception:
        logger.exception("migrate_wave_tier_ids failed")

    try:
        await migrate_wave_states()
    except Exception:
        logger.exception("migrate_wave_states failed")

    try:
        # Order matters: ordering is assigned per album, so the albums have to exist and
        # every item has to know which one it is in before that runs.
        await migrate_gallery_albums()
    except Exception:
        logger.exception("migrate_gallery_albums failed")

    try:
        await migrate_gallery_ordering()
    except Exception:
        logger.exception("migrate_gallery_ordering failed")

    try:
        await migrate_artist_collab()
    except Exception:
        logger.exception("migrate_artist_collab failed")

    try:
        await migrate_drop_archive_page()
    except Exception:
        logger.exception("migrate_drop_archive_page failed")

    try:
        # After migrate_gallery_albums: an album has to exist, and know its event, before
        # it can borrow that event's date.
        await migrate_album_dates()
    except Exception:
        logger.exception("migrate_album_dates failed")

    try:
        await migrate_footer_pages()
    except Exception:
        logger.exception("migrate_footer_pages failed")

    try:
        await migrate_nav_size_to_site_settings()
    except Exception:
        logger.exception("migrate_nav_size_to_site_settings failed")

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


# RETIRED: migrate_access_until.
#
# It unset `waves.$[].access_from` on every schema bump. That was right while the field
# was a dead leftover — it stored when a tier's holders could START entering, nothing
# read it, and carrying the value into the enforced `access_until` would have inverted
# its meaning into "refused after 21:00".
#
# `access_from` is a real, enforced field again: the door refuses a scan before it, the
# same way it refuses one after `access_until`. Leaving that migration in place would
# have deleted every "from" cut-off an editor set, silently, on the next version bump —
# and the deletion would look like the setting had never saved.
#
# It has already run everywhere it needed to; the key it cleaned up has not been written
# by any version since. Do not reinstate it.


async def migrate_wave_states():
    """Give every tier written before states existed the state it has always had.

    `active` and a pack of 1 are what those tiers already behaved as, so this changes
    nothing about how the site sells — it only writes the defaults down. That matters
    because the admin editor round-trips whatever it is given: an absent `status` reads
    as a blank control, and saving the event would then write the editor's guess rather
    than the tier's own history.

    Only tiers actually missing a field are touched, and an event is written once.
    """
    fixed = 0
    async for e in db.events.find(
        {"$or": [{"waves.status": None}, {"waves.pack_size": None}]},
        {"_id": 0, "event_id": 1, "waves": 1},
    ):
        waves = e.get("waves") or []
        touched = False
        for w in waves:
            if w.get("status") not in WAVE_STATUSES:
                w["status"] = "active"
                touched = True
            if not isinstance(w.get("pack_size"), int) or w["pack_size"] < 1:
                w["pack_size"] = 1
                touched = True
        if touched:
            await db.events.update_one({"event_id": e["event_id"]}, {"$set": {"waves": waves}})
            fixed += 1
    if fixed:
        logger.info("Gave states to the tiers of %d event(s)", fixed)


async def migrate_wave_tier_ids():
    """Number the tiers of events that predate `tier_id`.

    Numbered from the order their waves are already stored in, so every existing event
    keeps the exact running order it displays today. Backfilling to a constant, or
    leaving them unnumbered, would reorder live events the first time anyone saved one.

    Only waves with no id of their own are touched, and an event is written once for the
    whole array rather than once per wave.
    """
    fixed = 0
    async for e in db.events.find({"waves.tier_id": None}, {"_id": 0, "event_id": 1, "waves": 1}):
        waves = e.get("waves") or []
        # The next number carries on past whatever is already numbered, so a
        # part-numbered event does not end up with two tiers sharing an id.
        used = {w.get("tier_id") for w in waves if isinstance(w.get("tier_id"), int)}
        nxt = (max(used) + 1) if used else 1
        changed = False
        for w in waves:
            if isinstance(w.get("tier_id"), int):
                continue
            w["tier_id"] = nxt
            nxt += 1
            changed = True
        if changed:
            await db.events.update_one({"event_id": e["event_id"]}, {"$set": {"waves": waves}})
            fixed += 1
    if fixed:
        logger.info("Numbered the tiers of %d event(s)", fixed)
    return fixed


async def migrate_gallery_albums():
    """Turn the old `event_id` buckets into real album records.

    Before this, an "album" was not a thing you could create — it was whatever gallery
    rows happened to share an `event_id`, plus one hard-coded sitewide bucket
    (`event_id: None`) whose title and slug lived in a `site_settings` singleton. That
    made "a gallery with no event" unrepresentable, which is exactly what this migration
    exists to fix.

    Each distinct bucket becomes one row in `db.albums`:

      * an event bucket -> an album titled after the event, still linked to it via
        `event_id`, so nothing disappears from an event page;
      * the sitewide bucket -> a single album carrying the old gallery settings' title,
        slug and description, now linked to nothing.

    Items are then stamped with `album_id` and their old `event_id` is dropped, so the
    bucket key lives in one place. Rows that already have an `album_id` are skipped
    outright, which is what makes this safe to re-run on every cold start.
    """
    legacy = await db.gallery.find(
        {"album_id": {"$exists": False}}, {"_id": 0, "gallery_id": 1, "event_id": 1, "created_at": 1}
    ).sort("created_at", 1).to_list(20000)
    if not legacy:
        return

    # Buckets in the order their first item was created, so album ordering follows the
    # order the albums were actually filled.
    buckets = []
    for g in legacy:
        bucket = g.get("event_id") or None
        if bucket not in buckets:
            buckets.append(bucket)

    # The retired singleton. Left in place rather than deleted: it is the only record of
    # what the sitewide gallery was called, and re-running this must find it again.
    settings = await db.site_settings.find_one({"_id": "gallery"}, {"_id": 0}) or {}

    last = await db.albums.find({}, {"_id": 0, "sort_order": 1}).sort("sort_order", -1).limit(1).to_list(1)
    next_order = (last[0].get("sort_order", -1) + 1) if last else 0
    now_iso = now_utc().isoformat()
    created = {}

    for bucket in buckets:
        if bucket:
            event = await db.events.find_one({"event_id": bucket}, {"_id": 0, "title": 1, "slug": 1})
            # An event that no longer exists still has its photos; they become an
            # unlinked album rather than vanishing into a dead reference.
            title = (event or {}).get("title") or "Untitled album"
            slug_seed = (event or {}).get("slug") or title
            event_id, description = (bucket if event else None), ""
        else:
            title = (settings.get("title") or "").strip() or "Gallery"
            slug_seed = (settings.get("slug") or "").strip() or title
            event_id, description = None, (settings.get("description") or "").strip()

        album = {
            "album_id": new_id("alb"),
            "title": title,
            "slug": await _unique_album_slug(slug_seed),
            "description": description,
            "event_id": event_id,
            "sort_order": next_order,
            "created_at": now_iso,
        }
        next_order += 1
        await db.albums.insert_one(album)
        created[bucket] = album["album_id"]

    for g in legacy:
        await db.gallery.update_one(
            {"gallery_id": g["gallery_id"]},
            {"$set": {"album_id": created[g.get("event_id") or None]}, "$unset": {"event_id": ""}},
        )

    logger.info("Gallery migrated into %d album(s): %d item(s) filed", len(created), len(legacy))


async def migrate_artist_collab():
    """Give every artist that predates the field a collab of "resident".

    The roster's tabs are built from this vocabulary, so an artist without one would be
    reachable from "All" and from neither of the other two — present on the site but
    absent from both halves of the filter, with nothing to say why.

    Resident is the right default rather than a neutral one: these are the artists the
    collective already had when the distinction was introduced, which is what resident
    means. Guests get retagged by hand, which is a smaller job than the reverse.
    """
    r = await db.artists.update_many(
        {"collab": {"$in": [None, ""]}}, {"$set": {"collab": "resident"}}
    )
    if r.modified_count:
        logger.info("Set %d artist(s) to resident", r.modified_count)
    return r.modified_count


async def migrate_drop_archive_page():
    """Remove the retired Archive page from the CMS.

    Archive was a core nav row seeded into cms_pages, so taking it out of CORE_NAV_ITEMS
    is not enough on its own: the row an already-seeded site holds would stay, and the
    header would keep offering a link to a route that no longer exists.

    Only the seeded core row is deleted, keyed on its slug and its `kind`. A page an
    editor has authored at that slug is theirs — "archive" is no longer a reserved word,
    so it is now a name they are allowed to use.
    """
    r = await db.cms_pages.delete_many({"slug": "core-archive", "kind": "core"})
    if r.deleted_count:
        logger.info("Removed the retired Archive page from the nav")
    return r.deleted_count


async def migrate_album_dates():
    """Give every existing album the date the Gallery grid now orders by.

    An album linked to an event takes that event's day — which is the date anyone
    looking at the tile means by it. One that is linked to nothing has only ever had its
    creation day, so it keeps that, and lands where it already sat.

    Albums that already carry a date are left alone: this runs on every version bump,
    not only the one that introduced the field, and a re-run must not undo an editor's
    correction by reimposing the linked event's date over it.
    """
    # One query, not two: a Mongo match against null also matches documents with no such
    # field, so this catches the albums that predate the field alongside those that have
    # it set to null or blank.
    albums = await db.albums.find(
        {"date": {"$in": [None, ""]}}, {"_id": 0, "album_id": 1, "event_id": 1, "created_at": 1}
    ).to_list(500)
    if not albums:
        return 0

    event_ids = [a["event_id"] for a in albums if a.get("event_id")]
    events = await db.events.find(
        {"event_id": {"$in": event_ids}}, {"_id": 0, "event_id": 1, "starts_at": 1}
    ).to_list(500) if event_ids else []
    starts = {e["event_id"]: e.get("starts_at") or "" for e in events}

    fixed = 0
    for a in albums:
        source = starts.get(a.get("event_id") or "") or a.get("created_at") or ""
        day = source[:10]
        if not _ALBUM_DATE_RE.match(day):
            continue
        await db.albums.update_one({"album_id": a["album_id"]}, {"$set": {"date": day}})
        fixed += 1
    if fixed:
        logger.info("Backfilled a date onto %d album(s)", fixed)
    return fixed


async def migrate_nav_size_to_site_settings():
    """Carry the header nav's type size out of the theme document.

    It was a theme value, which is where typography belongs in the abstract and the last
    place anyone looked for it — the header's other control sits in the Site pane. The
    value moves; the CSS variable it produces does not, because it has to arrive in the
    render-blocking stylesheet or the nav paints at the default and then jumps.

    Only runs when the site settings have no size of their own, so an operator who has
    already set one in the new place is never overwritten by the old one.
    """
    site = await db.site_settings.find_one({"_id": "site"}, {"_id": 0, "nav_size": 1}) or {}
    if site.get("nav_size") is not None:
        return 0
    theme = await db.cms_theme.find_one({"doc_id": "theme_current"}, {"_id": 0}) or {}
    existing = ((theme.get("published") or {}).get("nav_size")
                or (theme.get("draft") or {}).get("nav_size"))
    if existing is None:
        return 0
    await db.site_settings.update_one(
        {"_id": "site"}, {"$set": {"nav_size": int(existing)}}, upsert=True)
    logger.info("Moved nav_size %s from the theme to the site settings", existing)
    return 1


async def migrate_footer_pages():
    """Give the footer back the links it used to have hardcoded.

    The three legal pages were seeded with `in_nav=False` and a comment saying they live
    in the footer — but the footer typed their hrefs into the component instead, so the
    flag was documentation rather than data. Without this, the first deploy of the
    CMS-driven footer would render an empty Legal column: the pages exist, nothing marks
    them as belonging there.

    Only touches rows that have no `in_footer` at all, so an editor who has already
    decided is never overruled. Keyed on the slugs the seeder creates rather than on
    "not in the nav", because a page an editor deliberately hid from the nav is not
    thereby a legal page.
    """
    seeded = ("terms", "privacy", "cookie-policy")
    r = await db.cms_pages.update_many(
        {"slug": {"$in": list(seeded)}, "in_footer": {"$exists": False}},
        {"$set": {"in_footer": True, "footer_order": 100}},
    )
    # Everything else defaults to "not in the footer", stated rather than left absent so
    # the field means the same thing on every row.
    await db.cms_pages.update_many(
        {"in_footer": {"$exists": False}},
        {"$set": {"in_footer": False, "footer_order": 100}},
    )
    if r.modified_count:
        logger.info("Marked %d page(s) as footer links", r.modified_count)
    return r.modified_count


async def migrate_gallery_ordering():
    """Backfill the fields the album manager relies on.

    Pre-existing rows predate ordering entirely, and the earliest seeded ones also lack
    media_type. Ordering is assigned per album (each is an independent sequence)
    following the old created_at order, so existing albums keep exactly the order they
    already displayed in.
    """
    await db.gallery.update_many({"media_type": {"$exists": False}}, {"$set": {"media_type": "image"}})

    albums = await db.gallery.distinct("album_id")
    fixed = 0
    for album_id in albums:
        items = await db.gallery.find(
            {"album_id": album_id, "sort_order": {"$exists": False}}, {"_id": 0, "gallery_id": 1}
        ).sort("created_at", 1).to_list(5000)
        if not items:
            continue
        # Append after anything already ordered in this album.
        ordered = await db.gallery.find({"album_id": album_id, "sort_order": {"$exists": True}}).to_list(5000)
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


async def close_db_pool():
    # Only close the pool where "shutdown" means the process is going away for good.
    # Serverless instances are torn down with the pool still open — Vercel allows ~500ms
    # after SIGTERM and does not surface logs from it — so there is nothing to gain by
    # closing here, and a closed client on an instance the runtime turns out to reuse
    # fails the next request with an InvalidOperation that looks nothing like its cause.
    if not SERVERLESS:
        client.close()
