"""
GET /api/health — the deployment identity check.

Its whole purpose is to be readable from outside with no session, so these drive it
over HTTP like any other client would. The leak test is the one worth keeping: the
endpoint is unauthenticated and public, and the temptation to add "just one more"
useful field to it is exactly how PAYMENTS_MODE ends up on the open internet.

Run: venv/bin/python -m pytest tests/test_health.py -q
"""
import requests

import pytest
import support

# Runs on one worker, in order: the module's own xdist group. This is what
# `--dist loadgroup` needs in order to behave like the `loadscope` it replaced —
# see pytest.ini.
pytestmark = pytest.mark.xdist_group("test_health")

TIMEOUT = 15


def get_health():
    r = requests.get(f"{support.API}/health", timeout=TIMEOUT)
    assert r.status_code == 200, f"health should answer without a session, got {r.status_code}"
    return r.json()


def test_reports_the_expected_shape():
    body = get_health()
    assert set(body) == {"ok", "commit", "schema_version", "schema_version_expected", "db"}


def test_schema_versions_agree_on_an_initialised_server():
    """A server that has completed init reports the version its code was built with."""
    import server

    body = get_health()
    assert body["schema_version_expected"] == server.SCHEMA_VERSION
    assert body["schema_version"] == server.SCHEMA_VERSION, (
        "the database records an older schema than the running code — init has not "
        "cold-started into its migrations yet"
    )
    assert body["db"] is True
    assert body["ok"] is True


def test_commit_is_a_string_and_hex_when_present():
    """Empty is legitimate: nothing injects a SHA into a local uvicorn."""
    commit = get_health()["commit"]
    assert isinstance(commit, str)
    if commit:
        assert all(c in "0123456789abcdef" for c in commit.lower()), commit


def test_does_not_leak_configuration():
    """Unauthenticated and public, so it must describe the build — never the setup.

    PAYMENTS_MODE is the one that matters: the fake-payment fallback issues real
    tickets for free (audit C1), so advertising which mode is live hands an attacker
    the only thing they need to know before looking.
    """
    body = get_health()
    flat = repr(body).lower()
    for forbidden in ("payment", "stripe", "mongo", "secret", "token", "key",
                      "app_env", "blob", "email", "smtp", "resend"):
        assert forbidden not in flat, f"health leaks {forbidden!r}: {body}"
