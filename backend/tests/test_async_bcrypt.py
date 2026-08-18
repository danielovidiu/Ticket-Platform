"""
bcrypt must not block the event loop.

`hash_password`/`verify_password` are blocking and cost ~250-300ms at rounds=12. Called
directly from an async handler they stall the worker for that long — every request it is
serving, not just the one doing the hashing. Serverless hid this (one request per function
instance); a long-lived uvicorn worker does not.

The regression this guards is a quiet one: moving `await asyncio.to_thread(...)` back to a
plain call breaks no functional test, because every response is still correct. Only latency
under concurrency changes. So the assertion here is about latency.

Timing-based, and deliberately generous: it distinguishes "queued behind bcrypt" (~250ms)
from "served immediately" (~5ms), which is a 50x gap, not a photo finish.
"""
import time
import uuid
import threading

import pytest
import requests

import support
from support import API, TIMEOUT, TEST_EMAIL_DOMAIN


# `critical`: the only guard on the event-loop fix, and it depends on an unspent login
# budget, so it is one of the tests most likely to vanish quietly. conftest reports a
# skip here loudly and fails the run under strict env.
# Runs on one worker, in order: the module's own xdist group. This is what
# `--dist loadgroup` needs in order to behave like the `loadscope` it replaced —
# see pytest.ini.
pytestmark = [pytest.mark.integration, pytest.mark.critical, pytest.mark.xdist_group("test_async_bcrypt")]

# Comfortably below any real bcrypt cost, comfortably above local HTTP overhead. A probe
# slower than this fraction of a login means it waited for the hash.
STALL_RATIO = 0.5
MIN_MEASURABLE_LOGIN = 0.08


def _unique_email():
    return f"pytest-bcrypt-{uuid.uuid4().hex[:10]}@{TEST_EMAIL_DOMAIN}"


def _failed_login():
    """A login for an address that doesn't exist. Still runs bcrypt: the handler verifies
    against _DUMMY_HASH to keep 'no such user' and 'wrong password' indistinguishable by
    timing. Returns (seconds, response)."""
    t0 = time.perf_counter()
    r = requests.post(f"{API}/auth/login",
                      json={"email": _unique_email(), "password": "not-the-password"},
                      timeout=TIMEOUT)
    return time.perf_counter() - t0, r


class TestEventLoopNotBlocked:
    """One class so xdist's loadscope keeps these on a single worker — they share the
    per-IP login budget and must not race another worker for it."""

    def test_bcrypt_does_not_stall_unrelated_requests(self):
        baseline, r = _failed_login()
        support.skip_if_rate_limited(r, "login")
        assert r.status_code == 401, r.text

        if baseline < MIN_MEASURABLE_LOGIN:
            pytest.skip(
                f"login returned in {baseline * 1000:.0f}ms — too fast to tell a blocked "
                "loop from a free one (is bcrypt actually running?)"
            )

        # Hold one login in flight and probe a cheap endpoint throughout it. Sampling
        # repeatedly rather than once removes the race where a single probe lands before
        # the handler has reached the hash.
        held = {}

        def _hold():
            held["seconds"], held["response"] = _failed_login()

        worker = threading.Thread(target=_hold)
        worker.start()

        latencies = []
        while worker.is_alive():
            t0 = time.perf_counter()
            probe = requests.get(f"{API}/auth/methods", timeout=TIMEOUT)
            latencies.append(time.perf_counter() - t0)
            assert probe.status_code == 200
        worker.join()

        support.skip_if_rate_limited(held["response"], "login")
        assert latencies, "no probe completed while the login was in flight"

        worst = max(latencies)
        assert worst < baseline * STALL_RATIO, (
            f"an unrelated GET took {worst * 1000:.0f}ms while a login was hashing "
            f"({baseline * 1000:.0f}ms). bcrypt is running on the event loop — the route "
            f"should await hash_password_async / verify_password_async, not call the "
            f"blocking versions."
        )
