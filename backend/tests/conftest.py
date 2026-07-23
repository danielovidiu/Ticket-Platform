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
import sys
from pathlib import Path

import pytest

# The backend package (server.py, mailer.py) sits one level up. This replaces the old
# hardcoded sys.path.insert(0, "/app/backend").
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import support  # noqa: E402


def pytest_configure(config):
    config.addinivalue_line("markers", "integration: needs a live server and MongoDB")


def pytest_collection_modifyitems(config, items):
    """Skip everything, with one clear reason, when the environment isn't up."""
    up, reason = support.server_is_up()
    if up:
        return
    skip = pytest.mark.skip(reason=(
        f"{reason}. This suite needs a running backend and MongoDB. Start them with: "
        f"cd backend && venv/bin/uvicorn server:app --port 8000 "
        f"(point elsewhere with TICKET_PLATFORM_URL)."
    ))
    for item in items:
        item.add_marker(skip)


@pytest.fixture(scope="session", autouse=True)
def _cleanup_created_users():
    """Clear old leftovers up front; remove this worker's own accounts at the end."""
    try:
        support.sweep_stale_test_users()
    except Exception:
        pass
    yield
    try:
        support.cleanup_test_users()
    except Exception:  # teardown must never fail the run
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
