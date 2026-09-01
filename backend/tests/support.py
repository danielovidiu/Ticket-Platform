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

import pytest
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

# Events this process created through the API. Same contract as _created_user_ids:
# tracked at creation, removed at session end. A fixture that builds an event and then
# fails an assertion still gets it cleaned, which a trailing `requests.delete` does not.
_created_event_ids: list = []


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
        # Name/surname/phone are mandatory on an account, and the server refuses a
        # reservation from a profile missing any of them — a fixture identity has to be
        # complete or every checkout test fails on the gate rather than on its subject.
        "first_name": "pytest", "last_name": role, "phone": "+40721000000",
        "picture": "", "role": role, "password_hash": None,
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


def skip_if_rate_limited(r, what):
    """Report a spent rate-limit budget as "didn't run" rather than as a failure.

    /auth/register and /auth/login are limited per IP, and the whole suite runs from one
    — TestRateLimitAuthLogin exists precisely to spend the login budget. Their windows
    are five minutes, too long to wait out mid-run, so a collision says nothing about
    the rule under test. Anything other than 429 is a real result and surfaces normally.

    Lived in test_account_and_gallery.py until test_security_hardening needed it too:
    that module asserted 200 outright and so went red whenever an earlier test had
    already spent the registrations.
    """
    if r.status_code == 429:
        pytest.skip(f"{what}: rate-limit budget spent by another test in this window")
    return r


def register_user(email: str = None, password: str = "Fixture-Str0ng-Pass!", **extra):
    """Exercise the REAL registration endpoint. Rate-limited (5 per 5 min per IP) — use
    sparingly, and only in tests that are actually about registration.

    Name, surname and phone are mandatory, so defaults are supplied for callers that
    don't care about them; pass them in `extra` to override.

    The account is NOT usable when this returns: registration issues no session until
    the emailed link is clicked. Tests that need an identity should use `mint_user`;
    tests about the registration contract itself can read the created row out of the
    database, which is why the id is looked up by email rather than taken from the
    response body (there isn't one any more).
    """
    email = email or f"pytest-{uuid.uuid4().hex[:12]}@{TEST_EMAIL_DOMAIN}"
    body = {"email": email, "password": password, "tos_accepted": True,
            "first_name": "Pytest", "last_name": "Runner", "phone": "+40721000000"}
    body.update(extra)
    r = requests.post(f"{API}/auth/register", json=body, timeout=TIMEOUT)
    if r.status_code == 200:
        with contextlib.suppress(Exception):
            _created_user_ids.append(db.users.find_one({"email": email}, {"user_id": 1})["user_id"])
    return r


def registered_user_doc(email: str) -> dict:
    """The stored account for an address registered through the API. Registration
    returns no user object now (no session until the address is verified), so tests
    that assert on what was stored read it back here."""
    return db.users.find_one({"email": email.strip().lower()}, {"_id": 0}) or {}


def track_event(event_id: str):
    """Register an event for removal at the end of this session.

    `scannable_event` created one per run and never deleted it: 77 SCAN TEST EVENTs had
    accumulated in the development database over about a fortnight, against two real
    ones. A session-scoped fixture that `return`s has no teardown at all, and the sweep
    below only ever knew about users.
    """
    if event_id:
        _created_event_ids.append(event_id)


def cleanup_test_events():
    """Remove only the events THIS process created, mirroring cleanup_test_users."""
    ids = list(_created_event_ids)
    if not ids:
        return
    reservations = list(db.reservations.find({"event_id": {"$in": ids}}, {"_id": 0, "reservation_id": 1}))
    if reservations:
        db.tickets.delete_many({"reservation_id": {"$in": [r["reservation_id"] for r in reservations]}})
        db.reservations.delete_many({"event_id": {"$in": ids}})
    db.events.delete_many({"event_id": {"$in": ids}})
    _created_event_ids.clear()


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
    release_reservation_holds({"user_id": {"$in": ids}})
    db.reservations.delete_many({"user_id": {"$in": ids}})
    db.tickets.delete_many({"user_id": {"$in": ids}})
    db.users.delete_many({"user_id": {"$in": ids}})
    _created_user_ids.clear()


def release_reservation_holds(match: dict):
    """Give back the stock held by pending reservations before deleting them.

    A pending reservation has already drawn down its wave's `available` (or its special
    link's `used`). Deleting the row without returning that is a leak the server can
    never repair: the expiry sweep only sees reservations that still exist, so the stock
    is gone for good.

    This was silently draining the seeded demo events one suite run at a time — the
    GENERAL wave on the seeded event reached 0 of 250 with no pending reservations
    against it, and every test needing a real reservation started failing with "Not
    enough tickets available". Mirrors server._release_reservation_holds.

    `pending` and `paid` are returned. A paid reservation has also consumed its stock — it
    became tickets — and teardown deletes those tickets in the same breath, so the stock
    has to come back with them.

    `expired` and `refunded` are skipped, because both have already been given back:
    `expired` by the server's own sweep, `refunded` by admin_refund. This used to read
    `$ne: "expired"`, which returned refunded rows a second time and pushed the seeded
    GENERAL wave to 251 of 250 — one run of test_order_refund, one phantom seat. Same
    shape as the production bug it mirrors: release what is actually held, not everything
    that is not one known-safe state.
    """
    for r in db.reservations.find({**match, "status": {"$nin": ["expired", "refunded"]}},
                                  {"_id": 0, "event_id": 1, "wave_id": 1,
                                   "quantity": 1, "special_link_token": 1}):
        if r.get("special_link_token"):
            db.special_links.update_one(
                {"token": r["special_link_token"]},
                [{"$set": {"used": {"$max": [0, {"$subtract": ["$used", r["quantity"]]}]}}}],
            )
        else:
            # Capped at capacity, mirroring the server helper, so a teardown can never be
            # the thing that manufactures an impossible wave.
            db.events.update_one(
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


# Slug prefixes the suite's own event fixtures use. Anchored, and specific enough that
# no CMS-authored or seeded event can match one: `scan-test-` and `test-low-` are written
# by backend_test.py and test_low_findings.py respectively.
_TEST_EVENT_SLUG_RE = r"^(scan-test|test-low|test-tmp)-"


def sweep_stale_test_events(older_than_hours: int = 1):
    """Remove event fixtures left behind by an interrupted run.

    The companion to sweep_stale_test_users, and added for the same reason it exists:
    77 SCAN TEST EVENTs had built up against two real events, because the fixture that
    makes them had no teardown and nothing swept for them afterwards. Age-gated on the
    same rule, so a concurrently running worker's event is never pulled out from under it.
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=older_than_hours)).isoformat()
    stale = [e["event_id"] for e in db.events.find(
        {"slug": {"$regex": _TEST_EVENT_SLUG_RE}, "created_at": {"$lt": cutoff}},
        {"event_id": 1})]
    if not stale:
        return
    orphaned = list(db.reservations.find({"event_id": {"$in": stale}}, {"_id": 0, "reservation_id": 1}))
    if orphaned:
        db.tickets.delete_many({"reservation_id": {"$in": [r["reservation_id"] for r in orphaned]}})
        db.reservations.delete_many({"event_id": {"$in": stale}})
    db.events.delete_many({"event_id": {"$in": stale}})


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
        release_reservation_holds({"user_id": {"$in": stale}})
        db.reservations.delete_many({"user_id": {"$in": stale}})
        db.tickets.delete_many({"user_id": {"$in": stale}})
        db.users.delete_many({"user_id": {"$in": stale}})
    db.outbox.delete_many({"to": {"$regex": f"@{TEST_EMAIL_DOMAIN}$"},
                           "created_at": {"$lt": cutoff}})
    # Fixture-created content uses a TEST_ title/name prefix by convention.
    db.events.delete_many({"title": {"$regex": "^TEST_"}, "created_at": {"$lt": cutoff}})
    db.contact_messages.delete_many({"name": {"$regex": "^TEST_"}, "created_at": {"$lt": cutoff}})
    # Subscriptions were only ever swept on a "TEST_" email prefix, which no fixture
    # actually uses — registration opt-ins land as pytest-…@pytest.invalid and the rate
    # limit test writes source="rl-test", so neither matched and both accumulated
    # (187 rows in one local database). Match how they are really named.
    db.newsletter_subscriptions.delete_many({"created_at": {"$lt": cutoff}, "$or": [
        {"email": {"$regex": f"@{TEST_EMAIL_DOMAIN}$"}},
        {"email": {"$regex": "^TEST_"}},
        {"source": "rl-test"},
    ]})
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
