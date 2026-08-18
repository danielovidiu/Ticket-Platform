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

# Runs on one worker, in order: the module's own xdist group. This is what
# `--dist loadgroup` needs in order to behave like the `loadscope` it replaced —
# see pytest.ini.
pytestmark = pytest.mark.xdist_group("test_payment_mode_guard")

BACKEND = Path(__file__).resolve().parent.parent

# Report the decision, or the refusal, without starting a server.
PROBE = (
    "import server; "
    "print('MODE=' + server.PAYMENTS_MODE); "
    "print('SAMESITE=' + server.COOKIE_SAMESITE)"
)


def run_import(_argv=(), **env):
    """Import server.py with `env` applied over a minimal, known-clean baseline.

    `_argv` is appended to the probe's command line, so the guards that read `sys.argv`
    (the uvicorn flags — see H1's second half) see exactly what a real start would.
    """
    base = dict(os.environ)
    # Wipe everything the guards read, so the host's own .env cannot decide the outcome.
    for k in ("APP_ENV", "VERCEL", "PUBLIC_APP_URL", "STRIPE_API_KEY", "STRIPE_WEBHOOK_SECRET",
              "LOCAL_FAKE_PAYMENTS", "I_ACCEPT_FREE_TICKETS_IN_PUBLIC", "COOKIE_SAMESITE",
              "SESSION_SECRET", "CORS_ORIGINS", "FORWARDED_ALLOW_IPS"):
        base.pop(k, None)
    # Satisfied by default so these cases fail on payments, which is what they are about.
    # Since H1 was fixed, a public deployment also refuses to start without
    # FORWARDED_ALLOW_IPS — and without this default every case below would refuse for
    # that reason instead, leaving the payment guard untested while still going green.
    # Pass FORWARDED_ALLOW_IPS=None to leave it genuinely unset and exercise that guard.
    if "FORWARDED_ALLOW_IPS" not in env:
        base["FORWARDED_ALLOW_IPS"] = ""
    base.update({k: v for k, v in env.items() if v is not None})
    # server.py load_dotenv()s backend/.env; run from a directory where that is absent so
    # the file cannot reintroduce a key the case under test is meant to be missing.
    return subprocess.run(
        [sys.executable, "-c", PROBE, *_argv],
        cwd=BACKEND.parent, env={**base, "PYTHONPATH": str(BACKEND)},
        capture_output=True, text=True, timeout=90,
    )


def modes(res):
    out = dict(
        line.split("=", 1) for line in res.stdout.splitlines() if "=" in line and line.split("=")[0].isupper()
    )
    return out


class TestForwardedAllowIpsIsRequiredInPublic:
    """Audit H1. uvicorn's default (`forwarded_allow_ips="127.0.0.1"`) rewrites
    `request.client.host` from `X-Forwarded-For`, so the socket-peer fallback in
    `_client_ip()` is attacker-controlled wherever something on the host can reach the
    app. The value depends on the topology and there is no safe default, so a public
    deployment must state it."""

    # Everything else is configured correctly, so the only reason to refuse is this one.
    CONFIGURED = dict(PUBLIC_APP_URL="https://tickets.example", SESSION_SECRET="x" * 64,
                      CORS_ORIGINS="https://tickets.example",
                      STRIPE_API_KEY="sk_test_x", STRIPE_WEBHOOK_SECRET="whsec_x")

    def test_a_public_deployment_refuses_to_start_without_it(self):
        res = run_import(FORWARDED_ALLOW_IPS=None, **self.CONFIGURED)
        assert res.returncode != 0, f"booted with an unset FORWARDED_ALLOW_IPS: {res.stdout}"
        assert "FORWARDED_ALLOW_IPS" in res.stderr, res.stderr[-400:]

    def test_it_starts_once_the_answer_is_stated(self):
        """Both answers are valid; what is refused is leaving it to the default."""
        for value in ("", "127.0.0.1"):
            res = run_import(FORWARDED_ALLOW_IPS=value, **self.CONFIGURED)
            assert res.returncode == 0, f"{value!r} rejected: {res.stderr[-300:]}"

    def test_serverless_is_exempt(self):
        """Vercel terminates the connection itself; uvicorn is not the server there, and
        TRUSTED_IP_HEADER=x-vercel-forwarded-for is the control that applies."""
        res = run_import(FORWARDED_ALLOW_IPS=None, VERCEL="1", **self.CONFIGURED)
        assert res.returncode == 0, res.stderr[-300:]

    def test_local_development_is_exempt(self):
        """A laptop gets a warning, not a refusal — the README quickstart must still work."""
        res = run_import(FORWARDED_ALLOW_IPS=None, SESSION_SECRET="x" * 64)
        assert res.returncode == 0, res.stderr[-300:]


class TestTheProxyFlagCannotOutrankTheCheck:
    """Audit H1, second half. `uvicorn` resolves the trust list from the flag first, the
    variable second, the default last — but the startup check can only read the variable.
    So the flag silently outranks the thing being validated, and a server can pass the
    check on `""` while running on whatever the flag said.

    The flag cannot be read back out of click, so what is refused is every configuration
    where the two might not agree.
    """

    CONFIGURED = dict(PUBLIC_APP_URL="https://tickets.example", SESSION_SECRET="x" * 64,
                      CORS_ORIGINS="https://tickets.example",
                      STRIPE_API_KEY="sk_test_x", STRIPE_WEBHOOK_SECRET="whsec_x")

    def test_the_bypass_it_closes(self):
        """Before this guard: the check saw "" and passed, uvicorn trusted everyone."""
        res = run_import(_argv=["--forwarded-allow-ips", "*"],
                         FORWARDED_ALLOW_IPS="", **self.CONFIGURED)
        assert res.returncode != 0, (
            "booted trusting every proxy while the startup check validated an empty "
            f"variable — H1 is open again: {res.stdout}"
        )
        assert "disagree" in res.stderr, res.stderr[-400:]

    def test_a_disagreement_is_refused_on_a_laptop_too(self):
        """No topology makes this deliberate, so dev gets no pass on it."""
        res = run_import(_argv=["--forwarded-allow-ips", "127.0.0.1"],
                         FORWARDED_ALLOW_IPS="", SESSION_SECRET="x" * 64)
        assert res.returncode != 0, res.stdout
        assert "disagree" in res.stderr, res.stderr[-400:]

    def test_the_equals_spelling_is_read_too(self):
        res = run_import(_argv=["--forwarded-allow-ips=*"],
                         FORWARDED_ALLOW_IPS="", **self.CONFIGURED)
        assert res.returncode != 0, res.stdout

    def test_agreeing_is_not_a_disagreement(self):
        """Belt and braces is allowed; uvicorn splits on commas, so spacing is not a
        difference and neither is order."""
        for flag, env in (("", ""), ("127.0.0.1", "127.0.0.1"),
                          ("127.0.0.1, ::1", "::1,127.0.0.1")):
            res = run_import(_argv=["--forwarded-allow-ips", flag],
                             FORWARDED_ALLOW_IPS=env, **self.CONFIGURED)
            assert res.returncode == 0, f"{flag!r} vs {env!r} refused: {res.stderr[-300:]}"

    def test_public_refuses_the_flag_alone(self):
        """Probably correct, but unverifiable from in here — and one edit from the case
        above."""
        res = run_import(_argv=["--forwarded-allow-ips", ""],
                         FORWARDED_ALLOW_IPS=None, **self.CONFIGURED)
        assert res.returncode != 0, res.stdout
        assert "FORWARDED_ALLOW_IPS is unset" in res.stderr, res.stderr[-400:]

    def test_development_warns_about_the_flag_instead_of_refusing(self):
        """The README quickstart passed the flag for months; a laptop keeps working and
        is told why the app cannot see it."""
        res = run_import(_argv=["--forwarded-allow-ips", ""],
                         FORWARDED_ALLOW_IPS=None, SESSION_SECRET="x" * 64)
        assert res.returncode == 0, res.stderr[-300:]
        assert "--forwarded-allow-ips was passed" in res.stderr, res.stderr[-400:]

    def test_no_proxy_headers_answers_the_question_by_itself(self):
        """With the middleware off, nothing rewrites request.client.host whatever the
        trust list says — so there is nothing left for the variable to decide."""
        res = run_import(_argv=["--no-proxy-headers"],
                         FORWARDED_ALLOW_IPS=None, **self.CONFIGURED)
        assert res.returncode == 0, res.stderr[-300:]


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
