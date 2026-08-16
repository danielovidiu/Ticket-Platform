"""
CSRF: the Origin guard on state-changing routes (audit M3).

The session cookie is SameSite=Lax, which already refuses to ride along on a cross-site
POST. This guard covers the two things that does not: subdomains count as *same-site*, so
a hijacked one still gets the cookie; and the whole protection otherwise rests on one
environment variable that may legitimately be set to "none".

The route used throughout is `POST /api/admin/uploads` — multipart/form-data is a
CORS-safelisted content type, so it needs no preflight, which made it the one endpoint an
attacker's page could actually reach. JSON bodies were never reachable: they force a
preflight the allowlist rejects.
"""
import pytest
import requests

import support
from support import API, TIMEOUT


pytestmark = [pytest.mark.integration, pytest.mark.critical]  # pins audit M3

# Always allowed: the middleware unions PUBLIC_APP_URL into the allowlist regardless of
# CORS_ORIGINS, because a single-origin deployment has no reason to list itself there.
OURS = support._cfg("PUBLIC_APP_URL", "http://localhost:3000").rstrip("/")
FOREIGN = "https://evil.example"

REFUSAL = "Cross-origin request refused"
UPLOADS = f"{API}/admin/uploads"


def _post(url, origin=None, **kw):
    headers = dict(kw.pop("headers", {}))
    if origin is not None:
        headers["Origin"] = origin
    return requests.post(url, headers=headers, timeout=TIMEOUT, **kw)


class TestOriginGuard:
    def test_foreign_origin_write_is_refused(self):
        r = _post(UPLOADS, origin=FOREIGN)
        assert r.status_code == 403
        assert REFUSAL in r.text

    def test_our_own_origin_passes_the_guard(self):
        """Whatever happens next is the route's business — it must not be the guard's."""
        r = _post(UPLOADS, origin=OURS)
        assert REFUSAL not in r.text

    def test_missing_origin_passes(self):
        """Browsers always send Origin on a cross-origin write, so its absence means the
        caller is not a browser: the Stripe webhook, curl, this suite on Bearer tokens.
        Refusing that would break them and stop no attacker."""
        r = _post(UPLOADS)
        assert REFUSAL not in r.text

    def test_guard_runs_before_authentication(self, admin_headers):
        """Fails closed early: a valid admin session does not buy a foreign page a write."""
        r = _post(UPLOADS, origin=FOREIGN, headers=admin_headers)
        assert r.status_code == 403
        assert REFUSAL in r.text

    def test_subdomains_are_not_trusted(self):
        """The gap SameSite cannot close — a subdomain is same-site but not same-origin."""
        r = _post(UPLOADS, origin="https://evil.supersanity.ro")
        assert r.status_code == 403
        assert REFUSAL in r.text


class TestNotOverreaching:
    def test_reads_are_not_guarded(self):
        """CSRF is about writes. Guarding GET would break ordinary cross-origin reads
        and protect nothing."""
        r = requests.get(f"{API}/events", headers={"Origin": FOREIGN}, timeout=TIMEOUT)
        assert r.status_code == 200

    def test_apple_callback_is_exempt(self):
        """Sign in with Apple POSTs from Apple's origin — a legitimate cross-site write.
        Guarding it would break the login; it carries its own `state` cookie instead."""
        r = _post(f"{API}/auth/apple/callback",
                  origin="https://appleid.apple.com",
                  data={"id_token": "", "state": "", "user": ""})
        assert REFUSAL not in r.text

    def test_json_writes_still_work_from_our_origin(self):
        """The guard must not disturb the ordinary path the frontend uses.

        `/auth/login` is rate-limited, and this used to skip whenever another test had
        spent the budget — which meant the one test covering the *allow* half of M3 was
        the flakiest in the file. It never needed to: the guard is HTTP middleware, so it
        runs before routing and therefore before the route's rate-limit dependency. A 429
        is as good a proof as a 401 that the request got past the guard. What is asserted
        is what the test is actually about — the refusal did not happen.
        """
        r = _post(f"{API}/auth/login", origin=OURS,
                  json={"email": "nobody@pytest.invalid", "password": "wrong"})
        assert r.status_code in (401, 429), r.text
        assert REFUSAL not in r.text
