"""
Security hardening regression tests.

 - Rate limiting on /api/newsletter, /api/contact, /api/auth/login, /api/reservations
 - Admin gating on /api/seed and /api/cms/seed
 - Admin bootstrap: registration order must confer nothing (audit H3)
 - Payment mode must fail closed rather than downgrade to the simulator (audit C1)
 - Known-unfixed findings are recorded as xfail so they surface without breaking the run

Rewritten from the Emergent-era original, which read /app/frontend/.env, shelled out to
mongosh with the database name hardcoded to 'test_database', asserted that one specific
personal Gmail address was an admin, and grepped /var/log/supervisor for a log line.
It also claimed to rate-limit /api/auth/session — an endpoint deleted in the auth
rewrite.
"""
import os
import time
import subprocess
import json
import pytest
import requests

from support import BASE_URL, API, db, mint_user, register_user, TEST_EMAIL_DOMAIN


def _mint_session(role: str):
    """(token, user_id) for a throwaway account with the given role."""
    headers, uid, _email = mint_user(role)
    return headers["Authorization"].split(" ", 1)[1], uid


@pytest.fixture(scope="module")
def admin_session():
    tok, uid = _mint_session("admin")
    yield tok, uid


@pytest.fixture(scope="module")
def user_session():
    tok, uid = _mint_session("user")
    yield tok, uid


# ---------- Bootstrap ----------

class TestAdminBootstrap:
    """Audit H3. Admin must come from configuration, never from registration order.

    The originals here asserted that one specific personal Gmail address held the admin
    role and that a matching line appeared in /var/log/supervisor — a snapshot of one
    machine's state, not a property of the code. These test the actual rule instead.
    """

    def test_registration_never_grants_admin(self):
        """A newly registered account is a plain user regardless of who got there first.

        Uses the real endpoint (register_user tracks the account for teardown), because
        the point is what /api/auth/register itself assigns.
        """
        r = register_user()
        assert r.status_code == 200, r.text
        assert r.json()["user"]["role"] == "user", "registration granted a privileged role"

    def test_no_count_based_admin_rule_remains(self):
        """Guard the regression directly: nothing may key a role off the user count."""
        src = (__import__("pathlib").Path(__file__).resolve().parent.parent / "server.py").read_text()
        assert 'is_first' not in src, "first-user-becomes-admin logic reintroduced (audit H3)"

    def test_admin_role_is_reachable(self, admin_session):
        """The fixture's promoted account really can use an admin route."""
        tok, _ = admin_session
        r = requests.get(f"{API}/admin/stats", headers={"Authorization": f"Bearer {tok}"}, timeout=15)
        assert r.status_code == 200, r.text


class TestPaymentModeFailsClosed:
    """Audit C1. A missing/malformed Stripe key must not silently select the simulator,
    in which unauthenticated endpoints finalize orders and issue real tickets."""

    @pytest.mark.parametrize("env,expect_start", [
        ({}, False),                                          # production, no key
        ({"LOCAL_FAKE_PAYMENTS": "1"}, False),                # explicit simulator in prod
        ({"STRIPE_API_KEY": "sk_test_x"}, False),             # key but no webhook secret
        ({"STRIPE_API_KEY": "sk_test_x",
          "STRIPE_WEBHOOK_SECRET": "whsec_x"}, True),         # correctly configured
    ])
    def test_production_startup_matrix(self, env, expect_start):
        import sys
        from support import BACKEND_DIR
        base = {
            **os.environ, "APP_ENV": "production", "SESSION_SECRET": "x" * 64,
            "CORS_ORIGINS": "https://example.test",
        }
        for k in ("STRIPE_API_KEY", "STRIPE_WEBHOOK_SECRET", "LOCAL_FAKE_PAYMENTS"):
            base.pop(k, None)
        base.update(env)
        p = subprocess.run(
            [sys.executable, "-c", "import server; print('MODE=' + server.PAYMENTS_MODE)"],
            capture_output=True, text=True, timeout=60, cwd=str(BACKEND_DIR), env=base,
        )
        started = p.returncode == 0
        assert started is expect_start, (
            f"env={env} expected {'start' if expect_start else 'refusal'}; "
            f"rc={p.returncode} out={p.stdout[-200:]} err={p.stderr[-300:]}"
        )
        if started:
            assert "MODE=stripe" in p.stdout, f"production started in fake mode: {p.stdout}"


class TestKnownUnfixedFindings:
    """Findings from SECURITY_AUDIT.md that are documented but NOT yet fixed. They are
    xfail(strict) so that fixing one turns the suite red until the marker is removed —
    the gap can't be quietly forgotten, and can't be quietly closed either."""

    @pytest.mark.xfail(strict=True, reason="Audit H1: X-Forwarded-For is trusted with no "
                                           "proxy allowlist, so rotating it bypasses every rate limit")
    def test_xff_spoofing_does_not_bypass_rate_limit(self):
        codes = []
        for i in range(14):
            r = requests.post(f"{API}/contact",
                              headers={"X-Forwarded-For": f"198.51.100.{i}"},
                              json={"name": f"TEST_rl_xff_{i}", "email": "xff@t.dev",
                                    "message": "xff bypass probe"}, timeout=15)
            codes.append(r.status_code)
        db.contact_messages.delete_many({"name": {"$regex": "^TEST_rl_xff_"}})
        assert 429 in codes, f"rate limit never engaged across spoofed IPs: {codes}"

    @pytest.mark.xfail(strict=True, reason="Audit M1: no security response headers are set")
    def test_security_headers_present(self):
        h = requests.get(f"{API}/auth/methods", timeout=15).headers
        missing = [k for k in ("X-Content-Type-Options", "Referrer-Policy",
                               "X-Frame-Options", "Strict-Transport-Security") if k not in h]
        assert not missing, f"missing security headers: {missing}"


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
        # Cleanup inserted rows (and the confirmation mails they queued).
        db.newsletter_subscriptions.delete_many({"email": {"$regex": "^TEST_rl_nl_"}})
        db.outbox.delete_many({"to": {"$regex": "^TEST_rl_nl_"}})


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
        db.contact_messages.delete_many({"name": {"$regex": "^TEST_rl_"}})


class TestRateLimitAuthLogin:
    """Login is limited to 10 per 5 min per IP. The 11th must return 429.
    Uses a bogus account so wrong-password 401s are cheap; the rate-limit dep is
    evaluated before the credential check either way."""
    def test_auth_login_11th_returns_429(self):
        codes = []
        for i in range(11):
            r = requests.post(f"{BASE_URL}/api/auth/login",
                              json={"email": "rl-test@invalid.local", "password": "wrong-password"})
            codes.append(r.status_code)
            if r.status_code == 429:
                break
        assert codes[-1] == 429, f"11th auth/login should be 429: {codes}"


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
