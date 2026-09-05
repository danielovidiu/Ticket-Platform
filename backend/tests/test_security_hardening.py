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
import pathlib
import re
import time
import uuid
import subprocess
import json
import pytest
import support
import requests

from support import (BASE_URL, API, db, mint_user, register_user, registered_user_doc,
                     hash_token, skip_if_rate_limited, TEST_EMAIL_DOMAIN)

# Runs on one worker, in order: the module's own xdist group. This is what
# `--dist loadgroup` needs in order to behave like the `loadscope` it replaced —
# see pytest.ini.
pytestmark = pytest.mark.xdist_group("test_security_hardening")


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
        the point is what /api/auth/register itself assigns. The role is read from the
        stored row: registration returns no user object, since it issues no session
        until the emailed verification link is clicked.
        """
        email = f"pytest-{uuid.uuid4().hex[:12]}@{TEST_EMAIL_DOMAIN}"
        # Registration is 5-per-5-minutes per IP and the whole suite shares one. A spent
        # budget says nothing about which role gets assigned, so skip rather than fail.
        r = skip_if_rate_limited(register_user(email), "registration")
        assert r.status_code == 200, r.text
        assert r.json().get("verification_required") is True, "registration handed out a session"
        assert registered_user_doc(email).get("role") == "user", "registration granted a privileged role"

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
            # Part of the production startup contract since H1 was fixed. Set here so a
            # payments test fails on payments: without it every row refuses to start for
            # the proxy reason and the matrix stops saying anything about C1.
            "FORWARDED_ALLOW_IPS": "",
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


class TestForwardedHeaderCannotChooseTheRateLimitBucket:
    """Audit H1, and the marker that used to sit here.

    This was `xfail(strict=True)` for months: the application half of the fix shipped
    (`TRUSTED_IP_HEADER` gates whether a forwarding header is believed) while the other
    half did not, and the other half defeated it. uvicorn's ProxyHeadersMiddleware
    rewrites `request.client.host` from `X-Forwarded-For` for any peer in
    `forwarded_allow_ips` — default `127.0.0.1` — so `_client_ip()`'s "use the socket
    peer" fallback was reading an attacker-supplied header.

    The strict marker did its job exactly as intended: it made the gap impossible to
    forget and impossible to close quietly, and removing it is now part of the fix.

    Passing this requires the server to run with `--forwarded-allow-ips ""` (nothing
    fronts it), which is what the README quickstart and the dev launch config now pass.
    In production the app refuses to boot unless `FORWARDED_ALLOW_IPS` is set explicitly.
    """

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

# Shares a worker with the one test outside this file that POSTs to /newsletter — see the
# note on it in test_input_hardening.py. The limiter is per IP, and every xdist worker is
# the same IP, so a bucket cannot be reserved by grouping alone; what grouping buys is
# that the two are not in flight at the same moment.
NEWSLETTER_LIMIT = 10
NEWSLETTER_WINDOW_SECONDS = 60


@pytest.mark.xdist_group("newsletter_budget")
class TestRateLimitNewsletter:
    """The newsletter endpoint is rate limited, and the limit is the one we think it is.

    TWO ASSERTIONS, DELIBERATELY SPLIT, because one of them cannot be made cheaply over
    HTTP. The limiter keys on client IP and every xdist worker is the same IP, so the
    bucket is one budget shared by the whole suite — `test_input_hardening.py` posts here
    too. Counting an EXACT capacity therefore needs exclusive access to a sliding window,
    and the only way to get that is to drain the bucket and sleep a whole window out. That
    version worked and cost the suite about 70 seconds on essentially every run, because
    the collision is the normal case rather than the rare one.

    So:

      * BEHAVIOUR, over HTTP and from whatever state the bucket is in — the endpoint
        accepts a subscription, then refuses within eleven requests, and says when to come
        back. None of that depends on how many slots a neighbour already spent.
      * THE NUMBER, read off the route declaration in server.py. This is what the exact
        count used to protect and what dropping it would otherwise lose: a limit quietly
        tightened to 3/min still refuses within eleven, so the behavioural half alone
        would not notice. Read as text rather than imported, the way the deploy and embed
        allowlist tests read their config — the value lives in a decorator argument and
        there is nothing to import.

    What is genuinely given up: proof that the DECLARED number is the number the running
    server enforces. The two are one `Depends(rate_limit(...))` apart, and no other test
    in the suite has to buy that connection at a minute a run.
    """

    SERVER_PY = pathlib.Path(__file__).resolve().parent.parent / "server.py"

    def _post(self, tag):
        return requests.post(f"{BASE_URL}/api/newsletter",
                             json={"email": f"TEST_rl_nl_{tag}@t.dev", "source": "rl-test"},
                             timeout=15)

    def test_the_endpoint_refuses_once_the_limit_is_reached(self):
        # One accepted request first, so a server that refused EVERYTHING could not pass
        # this by going straight to 429. past_rate_limit waits only if the bucket happens
        # to be full right now, which is the one case where that is unavoidable.
        first = support.past_rate_limit(lambda: self._post(f"probe_{int(time.time() * 1000)}"))
        assert first.status_code == 200, (
            f"the endpoint would not accept anything: {first.status_code} {first.text[:120]}")

        codes, retry_after = [first.status_code], None
        stamp = int(time.time() * 1000)
        for i in range(NEWSLETTER_LIMIT):
            r = self._post(f"{stamp}_{i}")
            codes.append(r.status_code)
            if r.status_code == 429:
                retry_after = r.headers.get("Retry-After")
                break

        try:
            assert 429 in codes, (
                f"no refusal within {len(codes)} requests — is the limiter still wired "
                f"to this endpoint? {codes}")
            assert codes.count(200) <= NEWSLETTER_LIMIT, (
                f"more than {NEWSLETTER_LIMIT} accepted in one window: {codes}")
            assert retry_after is not None, "Retry-After header missing on 429"
        finally:
            # Cleanup inserted rows (and the confirmation mails they queued). In a finally
            # so a failure does not leave them behind for the next run to trip over.
            db.newsletter_subscriptions.delete_many({"email": {"$regex": "^TEST_rl_nl_"}})
            db.outbox.delete_many({"to": {"$regex": "^TEST_rl_nl_"}})

    def test_the_declared_limit_is_still_ten_a_minute(self):
        """The half the behavioural test cannot see. Tightening this to 3/min would keep
        every assertion above passing, and would silently start refusing real people."""
        src = self.SERVER_PY.read_text()
        m = re.search(r'@api\.post\("/newsletter",[^)]*rate_limit\(\s*"newsletter",\s*'
                      r'(\d+),\s*(\d+)\s*\)', src)
        assert m, "the /newsletter route no longer declares a rate_limit dependency"
        assert (int(m.group(1)), int(m.group(2))) == (NEWSLETTER_LIMIT, NEWSLETTER_WINDOW_SECONDS), (
            f"/newsletter is now {m.group(1)} per {m.group(2)}s, not "
            f"{NEWSLETTER_LIMIT} per {NEWSLETTER_WINDOW_SECONDS}s"
        )


class TestRateLimitContact:
    """Limit is 5/min. 6th must return 429.

    Shares the /contact bucket with the H1 test above, which spends all of it — that test
    stopped being an `xfail` and now genuinely drives the limiter to 429. Rather than
    depend on which runs first, this one waits for a clean window: asserting "the 6th is
    refused" is meaningless if the 1st already was.
    """

    def test_contact_6th_returns_429(self):
        first = support.past_rate_limit(lambda: requests.post(
            f"{BASE_URL}/api/contact",
            json={"name": "TEST_rl_probe", "email": "rl@t.dev", "message": "window probe"},
            timeout=15))
        assert first.status_code == 200, (
            f"could not get a clean /contact window: {first.status_code} {first.text[:120]}")

        codes = [first.status_code]
        for i in range(1, 6):
            r = requests.post(
                f"{BASE_URL}/api/contact",
                json={"name": f"TEST_rl_{i}", "email": f"rl{i}@t.dev", "message": "rate-limit test"},
                timeout=15)
            codes.append(r.status_code)
            if r.status_code == 429:
                break
        assert codes[:5].count(200) == 5, f"first 5 should be 200: {codes}"
        assert codes[-1] == 429, f"6th should be 429: {codes}"
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


# INTENDED to override this module's own group so this shares a worker with the oversell
# races, which need a clean /reservations bucket that this class deliberately empties.
#
# IT DOES NOT. A mark here COMPOSES with the module's `pytestmark` rather than replacing
# it, so these tests land in a group of their own — `reservations_budget_
# test_security_hardening` — and not in `reservations_budget` with test_oversell_races.py
# and test_refactor_regression.py, which declare that name at module level. Confirmed by
# the group suffix xdist prints beside each test id in `-q --durations` output.
#
# Found while cutting the newsletter test's cost, where the identical mistake was made
# and measured: the two tests it was meant to co-locate raced anyway. Left as-is here
# rather than fixed in passing, because the only way to actually join the group is at
# module level, and this module cannot take `reservations_budget` wholesale — the class
# would have to move to a file that can. The docstring below describes the intent, which
# is still the right intent.
@pytest.mark.xdist_group("reservations_budget")
class TestRateLimitReservations:
    """Limit is 20/min per IP. 21st must return 429 even with a valid user.

    This empties a bucket another file needs: `test_oversell_races.py` fires six
    simultaneous reservations to prove M4 and M5 stay fixed, and cannot do that against a
    spent budget. It kept losing — this class ran on the *other* worker and refilled the
    bucket while the burst was waiting for it to drain.

    The first fix was a 61-second teardown sleep here: correct, and it cost a minute of
    every run. Sharing a worker is the better answer — the two can no longer overlap, so
    neither has to wait. That is the whole reason `pytest.ini` uses `--dist loadgroup`
    rather than `loadscope`, which cannot express "these two files, one worker".
    """

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
