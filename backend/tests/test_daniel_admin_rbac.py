"""
Regression: daniel.ovidiu@gmail.com -> role=admin, must access /api/admin/*
Context: previously got 403 because he wasn't the first user; role was 'user'.
Fix: promoted to admin manually, test-users cleaned up.

Verifies:
  1. Daniel exists in DB with role='admin' and is the only non-test real user.
  2. GET /api/auth/me with Daniel's Bearer -> 200, role=admin.
  3. GET /api/admin/stats with Daniel's Bearer -> 200 with expected shape.
  4. GET /api/admin/events with Daniel's Bearer -> 200 (list).
  5. GET /api/admin/stats without auth -> 401.
  6. GET /api/admin/stats with role=user Bearer -> 403.

Does NOT modify daniel.ovidiu@gmail.com document. Cleans up test users it creates.
"""
import os
import time
import uuid
import subprocess

import pytest
import requests

BASE_URL = os.environ.get(
    "REACT_APP_BACKEND_URL",
    "https://collective-box.preview.emergentagent.com",
).rstrip("/")
API = f"{BASE_URL}/api"

DANIEL_EMAIL = "daniel.ovidiu@gmail.com"

# Track ephemeral test users we create so we can delete them at teardown
_created_test_users = []  # list of (user_id, session_token)


def _mongo_run(js: str) -> str:
    p = subprocess.run(
        ["mongosh", "--quiet", "--eval", js],
        capture_output=True, text=True, timeout=15,
    )
    assert p.returncode == 0, f"mongosh failed: {p.stderr}"
    return p.stdout


def _mint_session_for(user_id: str) -> str:
    tok = f"test_daniel_reg_{uuid.uuid4().hex[:12]}"
    js = (
        "use('test_database');"
        f"db.user_sessions.insertOne({{user_id:'{user_id}',session_token:'{tok}',"
        "expires_at:new Date(Date.now()+7*24*3600*1000).toISOString(),"
        "created_at:new Date().toISOString()});"
    )
    _mongo_run(js)
    _created_test_users.append((user_id, tok))
    return tok


def _mint_fresh_user(role: str = "user") -> str:
    """Insert a new @umbra.test user + session, return the session token."""
    tok = f"test_{role}_{uuid.uuid4().hex[:12]}"
    uid = f"test-{role}-{uuid.uuid4().hex[:12]}"
    email = f"{role}.{uuid.uuid4().hex[:8]}@umbra.test"
    js = (
        "use('test_database');"
        f"db.users.insertOne({{user_id:'{uid}',email:'{email}',name:'{role} tmp',"
        f"picture:'',phone:'',role:'{role}',created_at:new Date().toISOString()}});"
        f"db.user_sessions.insertOne({{user_id:'{uid}',session_token:'{tok}',"
        "expires_at:new Date(Date.now()+7*24*3600*1000).toISOString(),"
        "created_at:new Date().toISOString()});"
    )
    _mongo_run(js)
    _created_test_users.append((uid, tok))
    return tok


@pytest.fixture(scope="module")
def daniel_user_id():
    """Look up Daniel's user_id from DB. Do NOT modify the user document."""
    out = _mongo_run(
        "use('test_database');"
        f"var u=db.users.findOne({{email:'{DANIEL_EMAIL}'}});"
        "print('USER_ID='+(u?u.user_id:''));"
        "print('ROLE='+(u?u.role:''));"
    )
    uid = None
    role = None
    for line in out.splitlines():
        if line.startswith("USER_ID="):
            uid = line.split("=", 1)[1].strip()
        if line.startswith("ROLE="):
            role = line.split("=", 1)[1].strip()
    assert uid, f"{DANIEL_EMAIL} not found in DB"
    assert role == "admin", f"expected role=admin, got role={role!r}"
    return uid


@pytest.fixture(scope="module")
def daniel_token(daniel_user_id):
    return _mint_session_for(daniel_user_id)


@pytest.fixture(scope="module", autouse=True)
def _cleanup_at_end():
    yield
    # Delete every test session/user we created here. NEVER delete Daniel's user.
    for uid, tok in _created_test_users:
        js = (
            "use('test_database');"
            f"db.user_sessions.deleteOne({{session_token:'{tok}'}});"
        )
        # Only delete the user if it's a test-only user (@umbra.test/@u.t) — never Daniel.
        if uid != "user_fae07ade1e48":
            js += (
                f"db.users.deleteOne({{user_id:'{uid}',"
                "email:{$regex:'@umbra\\\\.test$|@u\\\\.t$'}});"
            )
        try:
            _mongo_run(js)
        except Exception:
            pass


# ---------------- 1. DB sanity ----------------

def test_daniel_is_admin_and_only_real_user():
    out = _mongo_run(
        "use('test_database');"
        f"var u=db.users.findOne({{email:'{DANIEL_EMAIL}'}});"
        "print('ROLE='+(u?u.role:'MISSING'));"
        "var others=db.users.countDocuments({email:{$not:/@umbra\\.test$|@u\\.t$/}});"
        "print('NON_TEST_USER_COUNT='+others);"
        "var tests=db.users.countDocuments({email:{$regex:'@umbra\\\\.test$|@u\\\\.t$'}});"
        "print('TEST_USER_COUNT='+tests);"
    )
    assert "ROLE=admin" in out, out
    assert "NON_TEST_USER_COUNT=1" in out, out
    # We may create fresh @umbra.test users during this run; at initial state
    # main agent claims 0 stale test users — but we don't strictly assert 0
    # here because other tests may run concurrently. Just log it.
    print(out)


# ---------------- 2. /api/auth/me ----------------

def test_auth_me_returns_admin_for_daniel(daniel_token):
    r = requests.get(
        f"{API}/auth/me",
        headers={"Authorization": f"Bearer {daniel_token}"},
        timeout=15,
    )
    assert r.status_code == 200, f"status={r.status_code} body={r.text}"
    body = r.json()
    assert body.get("email") == DANIEL_EMAIL, body
    assert body.get("role") == "admin", body


# ---------------- 3. /api/admin/stats ----------------

def test_admin_stats_returns_200_with_expected_shape(daniel_token):
    r = requests.get(
        f"{API}/admin/stats",
        headers={"Authorization": f"Bearer {daniel_token}"},
        timeout=15,
    )
    assert r.status_code == 200, f"status={r.status_code} body={r.text}"
    body = r.json()
    for k in ("revenue_ron", "total_orders", "total_tickets", "scanned", "events"):
        assert k in body, f"missing key {k!r} in {body}"
    assert isinstance(body["revenue_ron"], (int, float)), body
    assert isinstance(body["total_orders"], int), body
    assert isinstance(body["total_tickets"], int), body
    assert isinstance(body["scanned"], int), body
    assert isinstance(body["events"], int), body


# ---------------- 4. /api/admin/events ----------------

def test_admin_events_returns_list(daniel_token):
    r = requests.get(
        f"{API}/admin/events",
        headers={"Authorization": f"Bearer {daniel_token}"},
        timeout=15,
    )
    assert r.status_code == 200, f"status={r.status_code} body={r.text}"
    body = r.json()
    assert isinstance(body, list), f"expected list, got {type(body).__name__}: {body}"
    # Not strictly required to be non-empty, but the seed usually has 2 events
    # We just assert every element has the minimum event shape if present.
    for ev in body:
        assert "event_id" in ev
        assert "title" in ev


# ---------------- 5. Sanity: no auth -> 401 ----------------

def test_admin_stats_no_auth_returns_401():
    r = requests.get(f"{API}/admin/stats", timeout=15)
    assert r.status_code == 401, f"expected 401, got {r.status_code}: {r.text}"


# ---------------- 6. Sanity: role=user -> 403 ----------------

def test_admin_stats_role_user_returns_403():
    user_tok = _mint_fresh_user(role="user")
    r = requests.get(
        f"{API}/admin/stats",
        headers={"Authorization": f"Bearer {user_tok}"},
        timeout=15,
    )
    assert r.status_code == 403, f"expected 403, got {r.status_code}: {r.text}"


# Extra defensive: role=door -> 403 (require_admin denies door)
def test_admin_stats_role_door_returns_403():
    door_tok = _mint_fresh_user(role="door")
    r = requests.get(
        f"{API}/admin/stats",
        headers={"Authorization": f"Bearer {door_tok}"},
        timeout=15,
    )
    assert r.status_code == 403, f"expected 403, got {r.status_code}: {r.text}"
