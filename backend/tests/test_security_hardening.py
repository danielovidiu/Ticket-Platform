"""
Iteration 7 — Security hardening tests
 - Rate limiting on /api/newsletter, /api/contact, /api/auth/session, /api/reservations
 - Admin gating on /api/seed and /api/cms/seed
 - INITIAL_ADMIN_EMAIL bootstrap on startup
"""
import os
import time
import subprocess
import json
import pytest
import requests

# Load REACT_APP_BACKEND_URL from frontend/.env
def _load_base():
    v = os.environ.get("REACT_APP_BACKEND_URL")
    if v:
        return v.rstrip("/")
    try:
        with open("/app/frontend/.env") as f:
            for line in f:
                if line.startswith("REACT_APP_BACKEND_URL="):
                    return line.split("=", 1)[1].strip().rstrip("/")
    except FileNotFoundError:
        pass
    raise RuntimeError("REACT_APP_BACKEND_URL not set")

BASE_URL = _load_base()


def _mint_session(role: str):
    """Insert a user + session for the given role using mongosh; returns token."""
    js = f"""
use('test_database');
var uid='test-{role}-'+Date.now();
var tok='test_{role}_'+Date.now();
db.users.insertOne({{user_id:uid,email:'{role}.'+Date.now()+'@umbra.test',name:'{role.title()} Test',picture:'',phone:'',role:'{role}',created_at:new Date().toISOString()}});
db.user_sessions.insertOne({{user_id:uid,session_token:tok,expires_at:new Date(Date.now()+7*24*3600*1000).toISOString(),created_at:new Date().toISOString()}});
print('TOKEN='+tok);
print('UID='+uid);
"""
    out = subprocess.check_output(["mongosh", "--quiet", "--eval", js], text=True)
    tok = None
    uid = None
    for line in out.splitlines():
        if line.startswith("TOKEN="):
            tok = line.split("=", 1)[1].strip()
        if line.startswith("UID="):
            uid = line.split("=", 1)[1].strip()
    assert tok, f"no token minted: {out}"
    return tok, uid


@pytest.fixture(scope="module")
def admin_session():
    tok, uid = _mint_session("admin")
    yield tok, uid


@pytest.fixture(scope="module")
def user_session():
    tok, uid = _mint_session("user")
    yield tok, uid


# ---------- Bootstrap ----------

class TestInitialAdminBootstrap:
    def test_daniel_is_admin(self):
        """daniel.ovidiu@gmail.com must have role='admin' after startup."""
        # Ensure the user exists (create if missing so the bootstrap can promote)
        js = """
use('test_database');
var u = db.users.findOne({email:'daniel.ovidiu@gmail.com'});
if (u) { print('ROLE='+u.role); } else { print('ROLE=missing'); }
"""
        out = subprocess.check_output(["mongosh", "--quiet", "--eval", js], text=True)
        assert "ROLE=admin" in out, f"daniel not admin in DB: {out}"

    def test_bootstrap_log_present(self):
        """Verify 'Bootstrapped daniel.ovidiu@gmail.com to admin' appears in supervisor logs."""
        found = False
        for path in ["/var/log/supervisor/backend.out.log", "/var/log/supervisor/backend.err.log"]:
            try:
                with open(path) as f:
                    if "Bootstrapped daniel.ovidiu@gmail.com to admin" in f.read():
                        found = True
                        break
            except FileNotFoundError:
                continue
        assert found, "bootstrap log line not found in backend supervisor logs"


# ---------- Admin gating for seed endpoints ----------

class TestSeedAdminGating:
    def test_seed_anon_401(self):
        r = requests.post(f"{BASE_URL}/api/seed")
        assert r.status_code == 401, r.text

    def test_seed_user_403(self, user_session):
        tok, _ = user_session
        r = requests.post(f"{BASE_URL}/api/seed", headers={"Authorization": f"Bearer {tok}"})
        assert r.status_code == 403, r.text

    def test_seed_admin_200(self, admin_session):
        tok, _ = admin_session
        r = requests.post(f"{BASE_URL}/api/seed", headers={"Authorization": f"Bearer {tok}"})
        assert r.status_code == 200, r.text
        data = r.json()
        # events already exist from earlier iterations -> should say already seeded
        assert data.get("seeded") is False
        assert "already" in (data.get("reason") or "").lower()

    def test_cms_seed_anon_401(self):
        r = requests.post(f"{BASE_URL}/api/cms/seed")
        assert r.status_code == 401

    def test_cms_seed_user_403(self, user_session):
        tok, _ = user_session
        r = requests.post(f"{BASE_URL}/api/cms/seed", headers={"Authorization": f"Bearer {tok}"})
        assert r.status_code == 403

    def test_cms_seed_admin_200(self, admin_session):
        tok, _ = admin_session
        r = requests.post(f"{BASE_URL}/api/cms/seed", headers={"Authorization": f"Bearer {tok}"})
        assert r.status_code == 200


# ---------- Rate limiting ----------

class TestRateLimitNewsletter:
    """Limit is 10/min. 11th must return 429."""
    def test_newsletter_11th_returns_429(self):
        emails = [f"TEST_rl_nl_{int(time.time())}_{i}@t.dev" for i in range(11)]
        codes = []
        retry_after = None
        for i, e in enumerate(emails):
            r = requests.post(f"{BASE_URL}/api/newsletter", json={"email": e, "source": "rl-test"})
            codes.append(r.status_code)
            if r.status_code == 429:
                retry_after = r.headers.get("Retry-After")
                break
        # First 10 must succeed, 11th must be 429
        assert codes[:10].count(200) == 10, f"expected first 10 to be 200, got {codes}"
        assert codes[-1] == 429, f"expected 11th to be 429, got {codes}"
        assert retry_after is not None, "Retry-After header missing on 429"
        # Cleanup inserted rows
        js = f"""
use('test_database');
db.newsletter_subscriptions.deleteMany({{email:/^TEST_rl_nl_/}});
print('CLEANED');
"""
        subprocess.check_output(["mongosh", "--quiet", "--eval", js], text=True)


class TestRateLimitContact:
    """Limit is 5/min. 6th must return 429."""
    def test_contact_6th_returns_429(self):
        codes = []
        for i in range(6):
            r = requests.post(
                f"{BASE_URL}/api/contact",
                json={"name": f"TEST_rl_{i}", "email": f"rl{i}@t.dev", "message": "rate-limit test"},
            )
            codes.append(r.status_code)
            if r.status_code == 429:
                break
        assert codes[:5].count(200) == 5, f"first 5 should be 200: {codes}"
        assert codes[-1] == 429, f"6th should be 429: {codes}"
        # Cleanup contact messages
        js = """
use('test_database');
db.contact_messages.deleteMany({name:/^TEST_rl_/});
print('CLEANED');
"""
        subprocess.check_output(["mongosh", "--quiet", "--eval", js], text=True)


class TestRateLimitAuthSession:
    """Limit is 15/min. 16th must return 429. Uses invalid session_id to avoid emergent auth cost."""
    def test_auth_session_16th_returns_429(self):
        codes = []
        for i in range(16):
            # invalid session_id => backend returns 401 (or emergent 401) but rate limit dep is evaluated first
            r = requests.post(f"{BASE_URL}/api/auth/session", json={"session_id": "invalid-rl-test"})
            codes.append(r.status_code)
            if r.status_code == 429:
                break
        assert codes[-1] == 429, f"16th auth/session should be 429: {codes}"


class TestRateLimitReservations:
    """Limit is 20/min per IP. 21st must return 429 even with a valid user."""
    def test_reservations_21st_returns_429(self, user_session):
        tok, _ = user_session
        codes = []
        # Use nonsense event_id — the rate_limit dep runs before validation of body
        for i in range(21):
            r = requests.post(
                f"{BASE_URL}/api/reservations",
                json={"event_id": "no-such-evt", "wave_id": "no-such-wave", "quantity": 1},
                headers={"Authorization": f"Bearer {tok}"},
            )
            codes.append(r.status_code)
            if r.status_code == 429:
                break
        assert codes[-1] == 429, f"21st reservations should be 429: {codes}"
