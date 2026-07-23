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

from support import (BASE_URL, API, db, mint_user, register_user, hash_token,
                     TEST_EMAIL_DOMAIN)


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


class TestSecurityHeaders:
    """Audit M1 — fixed. Every response carries the baseline set."""

    def test_baseline_headers_on_api_responses(self):
        h = requests.get(f"{API}/auth/methods", timeout=15).headers
        assert h.get("X-Content-Type-Options") == "nosniff"
        assert h.get("X-Frame-Options") == "DENY"
        # Verification and reset tokens ride in query strings, so the referrer must not
        # carry them to third parties or into logs.
        assert h.get("Referrer-Policy") == "no-referrer"
        assert "Permissions-Policy" in h
        assert "frame-ancestors 'none'" in h.get("Content-Security-Policy", "")

    def test_headers_present_on_error_responses_too(self):
        """Middleware runs on the 401/404 paths, not just the happy one."""
        for url, expect in ((f"{API}/auth/me", 401), (f"{API}/nope", 404)):
            r = requests.get(url, timeout=15)
            assert r.status_code == expect
            assert r.headers.get("X-Content-Type-Options") == "nosniff", url

    def test_uploads_get_a_sandboxed_csp(self):
        """/uploads serves user-supplied bytes from the app origin: nosniff stops a
        polyglot being sniffed as HTML, the sandbox CSP neuters it if it ever is."""
        r = requests.get(f"{BASE_URL}/uploads/does-not-exist.jpg", timeout=15)
        csp = r.headers.get("Content-Security-Policy", "")
        assert r.headers.get("X-Content-Type-Options") == "nosniff"
        assert "sandbox" in csp, csp

    def test_hsts_only_when_serving_https(self):
        """The dev server is http, so HSTS must be absent — pinning localhost to a scheme
        it doesn't serve would be self-inflicted downtime."""
        h = requests.get(f"{API}/auth/methods", timeout=15).headers
        if BASE_URL.startswith("https://"):
            assert "Strict-Transport-Security" in h
        else:
            assert "Strict-Transport-Security" not in h


class TestSessionTokensHashedAtRest:
    """Audit M2 — fixed. The database must not hold anything replayable."""

    def test_stored_token_is_a_hash_not_the_bearer_value(self):
        headers, user_id, _email = mint_user("user")
        presented = headers["Authorization"].split(" ", 1)[1]
        row = db.user_sessions.find_one({"user_id": user_id})
        assert row is not None
        stored = row["session_token"]
        assert stored != presented, "session token stored in plaintext"
        assert stored == hash_token(presented)
        assert len(stored) == 64 and all(c in "0123456789abcdef" for c in stored)

    def test_hashed_session_still_authenticates(self):
        headers, _uid, _email = mint_user("user")
        r = requests.get(f"{API}/auth/me", headers=headers, timeout=15)
        assert r.status_code == 200, r.text

    def test_no_plaintext_tokens_remain_anywhere(self):
        """The startup migration must have converted every pre-existing row."""
        bad = [s["session_token"] for s in db.user_sessions.find({}, {"session_token": 1})
               if not (len(s.get("session_token") or "") == 64
                       and all(c in "0123456789abcdef" for c in s["session_token"]))]
        assert not bad, f"{len(bad)} session row(s) still hold a non-hashed token"

    def test_logout_revokes_the_hashed_row(self):
        headers, user_id, _email = mint_user("user")
        assert requests.post(f"{API}/auth/logout", headers=headers, timeout=15).status_code == 200
        assert db.user_sessions.count_documents({"user_id": user_id}) == 0
        assert requests.get(f"{API}/auth/me", headers=headers, timeout=15).status_code == 401


class TestRateLimiterIsBounded:
    """Audit H2 — fixed. The limiter's key table must not grow without bound."""

    def test_expired_keys_are_evicted(self):
        """Drive many distinct keys through a short-window bucket, then confirm the
        server's table isn't still holding them all. Uses the in-process limiter directly:
        it is process-local state, so an HTTP test could only infer it."""
        import sys
        from support import BACKEND_DIR
        code = (
            "import server, time\n"
            "server.RATE_LIMIT_SWEEP_SECONDS = 0\n"
            "now = time.time()\n"
            "for i in range(500):\n"
            "    with server._rate_lock:\n"
            "        server._rate_check('probe', f'k{i}', 100, 1)\n"
            "time.sleep(1.2)\n"
            "with server._rate_lock:\n"
            "    server._rate_check('probe', 'trigger-sweep', 100, 1)\n"
            "print('REMAINING=%d' % len(server._rate_buckets['probe']))\n"
        )
        p = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True,
                           timeout=90, cwd=str(BACKEND_DIR))
        assert p.returncode == 0, p.stderr[-500:]
        remaining = int(p.stdout.split("REMAINING=")[1].split()[0])
        assert remaining <= 2, f"sweep left {remaining} expired keys behind"

    def test_key_count_is_capped(self):
        """A burst faster than the sweep must still be bounded, by LRU eviction."""
        import sys
        from support import BACKEND_DIR
        code = (
            "import server\n"
            "server.RATE_LIMIT_MAX_KEYS = 50\n"
            "for i in range(500):\n"
            "    with server._rate_lock:\n"
            "        server._rate_check('burst', f'k{i}', 100, 3600)\n"
            "print('SIZE=%d' % len(server._rate_buckets['burst']))\n"
        )
        p = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True,
                           timeout=90, cwd=str(BACKEND_DIR))
        assert p.returncode == 0, p.stderr[-500:]
        size = int(p.stdout.split("SIZE=")[1].split()[0])
        assert size <= 50, f"key table grew to {size} despite a cap of 50"


class TestKnownUnfixedFindings:
    """Findings from SECURITY_AUDIT.md that are documented but NOT yet fixed. xfail(strict)
    so the gap can't be quietly forgotten, and can't be quietly closed either — fixing one
    turns the suite red until the marker is removed."""

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
