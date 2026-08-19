"""
Shared fixtures.

This file used to be a five-line stub whose only comment was "tokens will be set from
CLI env" — an assumption from the Emergent runner, which injected UMB_*_TOKEN variables.
Nothing injects them now, so every fixture that depended on them errored at setup. Roles
are minted here instead, through the real registration endpoint.

The suite drives a LIVE server over HTTP. If one isn't reachable the whole session is
skipped with a message saying how to start it, rather than producing a wall of
connection errors.
"""
import os
import sys
from pathlib import Path

import pytest

# The backend package (server.py, mailer.py) sits one level up. This replaces the old
# hardcoded sys.path.insert(0, "/app/backend").
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import support  # noqa: E402


def _truthy(value: str) -> bool:
    return (value or "").strip().lower() not in ("", "0", "false", "no", "off")


def strict_env() -> bool:
    """Whether a missing environment should FAIL the run rather than skip it.

    Skipping was the right call for a person at a terminal — one clear sentence beats 429
    connection errors — but it means `pytest` exits **0** having run nothing, which is the
    worse failure by far the moment this runs unattended. A pipeline that forgets to start
    uvicorn reports a green suite.

    So: strict under CI (every provider sets `CI`), lenient locally, and
    `TICKET_PLATFORM_REQUIRE_ENV=1/0` to force either way.
    """
    override = os.environ.get("TICKET_PLATFORM_REQUIRE_ENV")
    if override is not None:
        return _truthy(override)
    return _truthy(os.environ.get("CI", ""))


_ENV_HELP = ("This suite needs a running backend and MongoDB. Start them with: "
             "cd backend && venv/bin/uvicorn server:app --port 8000 "
             "(point elsewhere with TICKET_PLATFORM_URL).")


def pytest_configure(config):
    config.addinivalue_line("markers", "integration: needs a live server and MongoDB")
    config.addinivalue_line(
        "markers",
        "critical: pins a specific audit finding — a skip here is reported as a failure "
        "under strict env, because a silently absent regression test is indistinguishable "
        "from a passing one",
    )
    # Controller only (`workerinput` marks an xdist worker), and before workers spawn, so
    # the failure is one sentence rather than two crashed processes.
    if hasattr(config, "workerinput") or not strict_env():
        return
    up, reason = support.server_is_up()
    if not up:
        raise pytest.UsageError(
            f"{reason}. {_ENV_HELP} Refusing to report a green run against nothing "
            "(TICKET_PLATFORM_REQUIRE_ENV=0 to skip instead)."
        )


def pytest_collection_modifyitems(config, items):
    """Skip everything, with one clear reason, when the environment isn't up.

    Only reachable in lenient mode — `pytest_configure` has already aborted otherwise.
    """
    up, reason = support.server_is_up()
    if up:
        return
    for item in items:
        item.add_marker(pytest.mark.skip(reason=f"{reason}. {_ENV_HELP}"))


# --- A skipped `critical` test is a failure -----------------------------------------
# Nothing here changes what the tests assert; it changes whether their *absence* is
# visible. The suite shares one IP, so a test that spends a rate-limit budget can leave
# another one with none, and `skip_if_rate_limited` turns that into a skip — correct in
# itself (a 429 says nothing about the rule under test) but it lands hardest on exactly
# the tests that pin fixed audit findings. Two consecutive full runs skipped 2 then 5
# tests, different ones each time, and both reported green.

_skipped_critical: list = []


def pytest_runtest_logreport(report):
    """Runs on the xdist controller for every worker's result, so this sees them all."""
    if not (report.skipped and "critical" in report.keywords):
        return
    reason = ""
    if isinstance(report.longrepr, tuple) and len(report.longrepr) == 3:
        reason = report.longrepr[2]
    # A whole-session skip because nothing is running is already reported, once, by the
    # collection hook. Repeating it here per critical test would bury the one line that
    # matters under a list of tests that were never going to run.
    if _ENV_HELP in reason:
        return
    _skipped_critical.append((report.nodeid, reason))


def pytest_terminal_summary(terminalreporter, exitstatus, config):
    if not _skipped_critical:
        return
    terminalreporter.write_sep("=", "CRITICAL TESTS THAT DID NOT RUN", red=True, bold=True)
    for nodeid, reason in _skipped_critical:
        terminalreporter.write_line(f"  {nodeid}\n      {reason}")
    terminalreporter.write_line(
        "\nEach of these pins a fixed audit finding. Re-run the file on its own to get a "
        "real result:\n  venv/bin/pytest <file> -q"
    )


def pytest_sessionfinish(session, exitstatus):
    """Fail the run in strict mode. Locally the summary above is loud enough."""
    if _skipped_critical and strict_env() and exitstatus == 0:
        session.exitstatus = 1


@pytest.fixture(scope="session", autouse=True)
def _cleanup_created_users():
    """Clear old leftovers up front; remove this worker's own records at the end."""
    try:
        support.sweep_stale_test_users()
        support.sweep_stale_test_events()
    except Exception:
        pass
    yield
    try:
        support.cleanup_test_users()
    except Exception:  # teardown must never fail the run
        pass
    try:
        support.cleanup_test_events()
    except Exception:
        pass


# --- Role fixtures -----------------------------------------------------------------
# Session-scoped: creating an account costs a bcrypt hash at cost 12, so mint each role
# once. Tests that need a *fresh* identity (ticket caps, per-user limits) call
# support.mint_user() directly instead.

def _role_fixture(role):
    @pytest.fixture(scope="session")
    def _f():
        headers, _user_id, _email = support.mint_user(role)
        return headers
    return _f


admin_headers = _role_fixture("admin")
editor_headers = _role_fixture("editor")
door_headers = _role_fixture("door")
user_headers = _role_fixture("user")
user2_headers = _role_fixture("user")


@pytest.fixture(scope="session")
def admin_identity():
    """(headers, user_id) for tests that need to assert on the admin's own record."""
    headers, user_id, _email = support.mint_user("admin")
    return headers, user_id


@pytest.fixture(scope="session")
def user_identity():
    headers, user_id, _email = support.mint_user("user")
    return headers, user_id


@pytest.fixture(scope="session")
def seeded(admin_headers):
    """Demo events/CMS content present. Idempotent."""
    support.ensure_seeded(admin_headers)
    return True
