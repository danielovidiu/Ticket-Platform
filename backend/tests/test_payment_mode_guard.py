"""
Startup guards that decide whether this instance may run without real payments.

These import server.py in a SUBPROCESS with a controlled environment. The decision is
made once, at module import, from environment variables — there is nothing to call and
nothing to monkeypatch after the fact, and mutating this process's env would leak into
every other test that shells out (which has bitten this suite before).

Run: venv/bin/python -m pytest tests/test_payment_mode_guard.py -q
"""
import os
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parent.parent

# Report the decision, or the refusal, without starting a server.
PROBE = (
    "import server; "
    "print('MODE=' + server.PAYMENTS_MODE); "
    "print('SAMESITE=' + server.COOKIE_SAMESITE)"
)


def run_import(**env):
    """Import server.py with `env` applied over a minimal, known-clean baseline."""
    base = dict(os.environ)
    # Wipe everything the guards read, so the host's own .env cannot decide the outcome.
    for k in ("APP_ENV", "VERCEL", "PUBLIC_APP_URL", "STRIPE_API_KEY", "STRIPE_WEBHOOK_SECRET",
              "LOCAL_FAKE_PAYMENTS", "I_ACCEPT_FREE_TICKETS_IN_PUBLIC", "COOKIE_SAMESITE",
              "SESSION_SECRET", "CORS_ORIGINS"):
        base.pop(k, None)
    base.update({k: v for k, v in env.items() if v is not None})
    # server.py load_dotenv()s backend/.env; run from a directory where that is absent so
    # the file cannot reintroduce a key the case under test is meant to be missing.
    return subprocess.run(
        [sys.executable, "-c", PROBE],
        cwd=BACKEND.parent, env={**base, "PYTHONPATH": str(BACKEND)},
        capture_output=True, text=True, timeout=90,
    )


def modes(res):
    out = dict(
        line.split("=", 1) for line in res.stdout.splitlines() if "=" in line and line.split("=")[0].isupper()
    )
    return out


class TestFakePaymentsRefusedInPublic:
    """The simulator finalizes orders through unauthenticated endpoints. Reaching it on a
    reachable host means giving tickets away, so every route to it must fail closed."""

    def test_serverless_without_a_key_refuses_to_start(self):
        """The hole this closes: APP_ENV unset on Vercel used to take the dev branch and
        select the simulator silently."""
        res = run_import(VERCEL="1", SESSION_SECRET="x" * 64,
                         PUBLIC_APP_URL="https://tickets.example")
        assert res.returncode != 0, f"booted anyway: {res.stdout}"
        assert "STRIPE_API_KEY" in res.stderr

    def test_https_public_url_without_a_key_refuses_to_start(self):
        """Not serverless and no APP_ENV — but an https non-loopback origin is still a
        site strangers can reach."""
        res = run_import(PUBLIC_APP_URL="https://tickets.example", SESSION_SECRET="x" * 64)
        assert res.returncode != 0, f"booted anyway: {res.stdout}"
        assert "STRIPE_API_KEY" in res.stderr

    def test_app_env_production_without_a_key_refuses_to_start(self):
        res = run_import(APP_ENV="production", SESSION_SECRET="x" * 64,
                         PUBLIC_APP_URL="https://tickets.example",
                         CORS_ORIGINS="https://tickets.example")
        assert res.returncode != 0, f"booted anyway: {res.stdout}"

    def test_explicit_simulator_is_refused_in_public(self):
        res = run_import(VERCEL="1", LOCAL_FAKE_PAYMENTS="1", SESSION_SECRET="x" * 64,
                         PUBLIC_APP_URL="https://tickets.example")
        assert res.returncode != 0, f"booted anyway: {res.stdout}"
        assert "simulator" in res.stderr.lower()

    def test_refusal_names_the_signals_that_triggered_it(self):
        """An operator has to be able to see WHY without reading the source."""
        res = run_import(VERCEL="1", SESSION_SECRET="x" * 64,
                         PUBLIC_APP_URL="https://tickets.example")
        for signal in ("APP_ENV", "serverless", "PUBLIC_APP_URL"):
            assert signal in res.stderr, f"refusal does not mention {signal}: {res.stderr[-400:]}"


class TestDevelopmentStillWorks:
    def test_localhost_without_a_key_still_boots_on_the_simulator(self):
        """A fresh checkout has to run with no credentials at all."""
        res = run_import(PUBLIC_APP_URL="http://localhost:3000")
        assert res.returncode == 0, res.stderr[-600:]
        assert modes(res)["MODE"] == "fake"

    def test_override_lets_a_demo_run_publicly(self):
        """A deployment that sells nothing can opt in — deliberately, and by a name
        nobody sets by accident."""
        res = run_import(VERCEL="1", I_ACCEPT_FREE_TICKETS_IN_PUBLIC="1",
                         SESSION_SECRET="x" * 64, PUBLIC_APP_URL="https://demo.example")
        assert res.returncode == 0, res.stderr[-600:]
        assert modes(res)["MODE"] == "fake"

    def test_a_real_key_selects_stripe(self):
        res = run_import(VERCEL="1", STRIPE_API_KEY="sk_test_notarealkey",
                         STRIPE_WEBHOOK_SECRET="whsec_x", SESSION_SECRET="x" * 64,
                         PUBLIC_APP_URL="https://tickets.example")
        assert res.returncode == 0, res.stderr[-600:]
        assert modes(res)["MODE"] == "stripe"


class TestCookieSameSiteDefault:
    def test_https_defaults_to_lax_not_none(self):
        """SameSite=None plus no CSRF token (M3) is a cross-site-forgeable session. The
        safe value is the one you get without asking."""
        res = run_import(VERCEL="1", STRIPE_API_KEY="sk_test_notarealkey",
                         STRIPE_WEBHOOK_SECRET="whsec_x", SESSION_SECRET="x" * 64,
                         PUBLIC_APP_URL="https://tickets.example")
        assert res.returncode == 0, res.stderr[-600:]
        assert modes(res)["SAMESITE"] == "lax"

    def test_none_is_still_available_when_asked_for(self):
        res = run_import(VERCEL="1", COOKIE_SAMESITE="none", STRIPE_API_KEY="sk_test_notarealkey",
                         STRIPE_WEBHOOK_SECRET="whsec_x", SESSION_SECRET="x" * 64,
                         PUBLIC_APP_URL="https://tickets.example")
        assert res.returncode == 0, res.stderr[-600:]
        assert modes(res)["SAMESITE"] == "none"

    def test_none_over_http_is_refused(self):
        """Browsers drop SameSite=None without Secure, so this would silently log
        everyone out rather than half-work."""
        res = run_import(COOKIE_SAMESITE="none", PUBLIC_APP_URL="http://localhost:3000")
        assert res.returncode != 0, f"booted anyway: {res.stdout}"
