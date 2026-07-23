"""
Shared test infrastructure.

Replaces the per-module bootstrap that every test file used to carry: a hardcoded
`/app/backend` on sys.path, `/app/frontend/.env`, `mongosh --eval "use('test_database')"`
subprocesses, and `UMB_*_TOKEN` environment variables that a runner was expected to
inject. None of that survived the move off the Emergent platform, which is why the suite
stopped running.

Everything is now derived from `backend/.env` (the same file the server reads) with env
overrides, and users are created through the real registration endpoint rather than
inserted behind the API's back — so the fixtures exercise the auth code instead of
faking its output.
"""
import os
import time
import uuid
import hashlib
import contextlib
from datetime import datetime, timezone, timedelta
from pathlib import Path

import requests
from pymongo import MongoClient

BACKEND_DIR = Path(__file__).resolve().parent.parent


def _dotenv() -> dict:
    """Parse backend/.env. Not a full parser — the file is a flat KEY=VALUE list."""
    values = {}
    env_path = BACKEND_DIR / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            values[k.strip()] = v.strip()
    return values


_ENV = _dotenv()


def _cfg(key: str, default: str = "") -> str:
    """Process env wins over backend/.env, so CI can point the suite anywhere."""
    return os.environ.get(key) or _ENV.get(key) or default


# Historically this was REACT_APP_BACKEND_URL read out of the frontend's .env. Keep
# accepting that name so existing runner scripts keep working.
BASE_URL = (os.environ.get("TICKET_PLATFORM_URL")
            or os.environ.get("REACT_APP_BACKEND_URL")
            or "http://localhost:8000").rstrip("/")
API = f"{BASE_URL}/api"

MONGO_URL = _cfg("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = _cfg("DB_NAME", "ticket_platform_local")

TIMEOUT = 15

_client = MongoClient(MONGO_URL, serverSelectionTimeoutMS=3000)
db = _client[DB_NAME]

# Every user these tests create, so the session teardown can remove them. Test users are
# also identifiable by their email domain (see TEST_EMAIL_DOMAIN) as a backstop.
TEST_EMAIL_DOMAIN = "pytest.invalid"
_created_user_ids: list = []


def server_is_up() -> tuple:
    """(reachable, reason). The suite is integration-style and needs a live server."""
    try:
        r = requests.get(f"{API}/auth/methods", timeout=5)
        if r.status_code != 200:
            return False, f"{API}/auth/methods returned {r.status_code}"
    except requests.RequestException as e:
        return False, f"cannot reach {BASE_URL}: {type(e).__name__}"
    try:
        _client.admin.command("ping")
    except Exception as e:
        return False, f"cannot reach MongoDB at {MONGO_URL}: {type(e).__name__}"
    return True, ""


def hash_token(token: str) -> str:
    """Mirror of server._hash_token. Duplicated rather than imported so the tests keep
    working if they're ever pointed at a remote server (TICKET_PLATFORM_URL) whose module
    isn't importable here — and so a change to the server's hashing is caught as a test
    failure instead of silently followed."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def bearer(token: str) -> dict:
    """`get_current_user` accepts the session token as a Bearer header as well as a
    cookie, which is what lets these tests hold several identities at once."""
    return {"Authorization": f"Bearer {token}"}


def mint_user(role: str = "user") -> tuple:
    """Create a test identity directly in the database. Returns (headers, user_id, email).

    Deliberately NOT via POST /api/auth/register. That endpoint is rate-limited to 5 per
    5 minutes per IP, and a suite that mints dozens of identities would spend the whole
    budget and then fail on 429s — fixtures must not consume a security control they
    aren't testing. Registration is covered on its own by
    test_security_hardening.py::TestAdminBootstrap and the rate limit by
    TestRateLimitAuthLogin.

    `expires_at` is written as a real datetime: that is what the session TTL index needs,
    and `parse_dt` in the server accepts either form.

    The session row stores sha256(token), matching what `_issue_session` writes since the
    M2 fix — the plaintext goes in the Authorization header and nowhere else.
    """
    email = f"pytest-{uuid.uuid4().hex[:12]}@{TEST_EMAIL_DOMAIN}"
    user_id = f"user_pytest_{uuid.uuid4().hex[:12]}"
    token = f"pytest_{role}_{uuid.uuid4().hex[:24]}"
    now = datetime.now(timezone.utc)

    db.users.insert_one({
        "user_id": user_id, "email": email, "name": f"pytest {role}",
        "picture": "", "phone": "", "role": role, "password_hash": None,
        "email_verified_at": now.isoformat(), "email_opt_in": False,
        "news_opt_in": False, "promo_opt_in": False, "consent_at": None,
        "tos_accepted_at": now.isoformat(), "created_at": now.isoformat(),
    })
    db.user_sessions.insert_one({
        "user_id": user_id, "session_token": hash_token(token),
        "expires_at": now + timedelta(days=7), "created_at": now.isoformat(),
    })

    _created_user_ids.append(user_id)
    return bearer(token), user_id, email


def register_user(email: str = None, password: str = "pytest-passw0rd", **extra):
    """Exercise the REAL registration endpoint. Rate-limited (5 per 5 min per IP) — use
    sparingly, and only in tests that are actually about registration.

    The resulting account is tracked for teardown, which `mint_user` does automatically
    but a bare requests.post would not.
    """
    email = email or f"pytest-{uuid.uuid4().hex[:12]}@{TEST_EMAIL_DOMAIN}"
    r = requests.post(
        f"{API}/auth/register",
        json={"email": email, "password": password, "tos_accepted": True, **extra},
        timeout=TIMEOUT,
    )
    if r.status_code == 200:
        with contextlib.suppress(Exception):
            _created_user_ids.append(r.json()["user"]["user_id"])
    return r


def cleanup_test_users():
    """Remove only the identities THIS process created.

    Scoped to tracked ids on purpose. pytest.ini runs `-n 2`, and a teardown that swept
    every account on the test domain would delete the other worker's still-in-use
    sessions the moment the first worker finished — which showed up as a scatter of
    401s in whichever worker happened to be slower. Leftovers from interrupted runs are
    handled by sweep_stale_test_users() at session start instead.
    """
    ids = list(_created_user_ids)
    if not ids:
        return
    db.user_sessions.delete_many({"user_id": {"$in": ids}})
    db.reservations.delete_many({"user_id": {"$in": ids}})
    db.tickets.delete_many({"user_id": {"$in": ids}})
    db.users.delete_many({"user_id": {"$in": ids}})
    _created_user_ids.clear()


def sweep_stale_test_users(older_than_hours: int = 1):
    """Remove test data left behind by an interrupted run.

    Age-gated so it can never touch a record a concurrently running worker just made.
    Per-test cleanup is best-effort — most of it is a trailing `requests.delete` that a
    failing assertion skips — so this sweep is what stops fixtures accumulating in a
    development database over time.
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=older_than_hours)).isoformat()
    stale = [u["user_id"] for u in db.users.find(
        {"email": {"$regex": f"@{TEST_EMAIL_DOMAIN}$"}, "created_at": {"$lt": cutoff}},
        {"user_id": 1})]
    if stale:
        db.user_sessions.delete_many({"user_id": {"$in": stale}})
        db.reservations.delete_many({"user_id": {"$in": stale}})
        db.tickets.delete_many({"user_id": {"$in": stale}})
        db.users.delete_many({"user_id": {"$in": stale}})
    db.outbox.delete_many({"to": {"$regex": f"@{TEST_EMAIL_DOMAIN}$"},
                           "created_at": {"$lt": cutoff}})
    # Fixture-created content uses a TEST_ title/name prefix by convention.
    db.events.delete_many({"title": {"$regex": "^TEST_"}, "created_at": {"$lt": cutoff}})
    db.contact_messages.delete_many({"name": {"$regex": "^TEST_"}, "created_at": {"$lt": cutoff}})
    db.newsletter_subscriptions.delete_many({"email": {"$regex": "^TEST_"}, "created_at": {"$lt": cutoff}})
    return len(stale)


class _RateLimitAwareRequests:
    """`requests` drop-in that waits out a 429 instead of failing the test.

    /api/reservations allows 20 per minute per IP, and TestRateLimitReservations
    deliberately exhausts that bucket to prove the limiter works. Every test runs from
    the same IP, and `-n 2 --dist loadscope` gives no ordering guarantee between
    modules, so any test that needs a genuine reservation has to be able to wait for the
    window to roll rather than inherit another test's spent budget.

    Only 429 is retried — a 400 or 401 is a real result and must surface immediately.
    """

    def __init__(self, attempts: int = 3, max_wait: int = 65):
        self._attempts, self._max_wait = attempts, max_wait

    def _send(self, method, url, **kw):
        kw.setdefault("timeout", TIMEOUT)
        for attempt in range(self._attempts):
            r = getattr(requests, method)(url, **kw)
            if r.status_code != 429 or attempt == self._attempts - 1:
                return r
            wait = min(int(r.headers.get("Retry-After", 5) or 5) + 1, self._max_wait)
            time.sleep(wait)
        return r

    def post(self, url, **kw):
        return self._send("post", url, **kw)

    def get(self, url, **kw):
        return self._send("get", url, **kw)


patient = _RateLimitAwareRequests()


@contextlib.contextmanager
def temp_discount(**fields):
    """Insert a discount code for the duration of a test, then remove it.

    Replaces the old `mongosh --eval "use('test_database'); db.discounts.insertOne(...)"`
    string-built JavaScript.
    """
    doc = {"discount_id": f"dsc_{uuid.uuid4().hex[:12]}", "uses": 0,
           "max_uses": 0, "event_id": None, **fields}
    db.discounts.insert_one(dict(doc))
    try:
        yield doc
    finally:
        db.discounts.delete_one({"code": doc["code"]})


def ensure_seeded(admin_headers: dict):
    """Seed demo content if the database is empty. /api/seed is admin-gated and a no-op
    once events exist."""
    requests.post(f"{API}/seed", headers=admin_headers, timeout=TIMEOUT)
    requests.post(f"{API}/cms/seed", headers=admin_headers, timeout=TIMEOUT)
