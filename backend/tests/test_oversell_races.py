"""
Concurrency guards for the two oversell races — audit findings M4 and M5.

Both were unfixable by reading-then-writing: every concurrent request observed the same
pre-state and every one of them passed. Both are now closed by making the write itself
conditional (special-link capacity) or by deciding order after the write (per-user cap).

These tests fire genuinely simultaneous requests through a `threading.Barrier`, so the
threads are released into the handler at the same moment rather than trickling in. A
sequential version of this file would pass against the *broken* code, which is the whole
difficulty of testing a race — so the barrier is load-bearing, not decoration.
"""
import uuid
import threading
from datetime import datetime, timezone, timedelta

import pytest
import requests

import support
from support import API, TIMEOUT, db, mint_user


pytestmark = pytest.mark.integration


# --- fixtures ----------------------------------------------------------------------

def _iso(**delta):
    return (datetime.now(timezone.utc) + timedelta(**delta)).isoformat()


def _make_event(max_per_user: int = 4, wave_capacity: int = 100) -> dict:
    event_id = f"evt_pytest_race_{uuid.uuid4().hex[:10]}"
    wave_id = f"wave_pytest_{uuid.uuid4().hex[:10]}"
    doc = {
        "event_id": event_id,
        "title": f"pytest race {uuid.uuid4().hex[:6]}",
        "slug": f"pytest-race-{uuid.uuid4().hex[:8]}",
        "description": "", "venue": "Club Pytest", "city": "Bucharest",
        "starts_at": _iso(days=30), "ends_at": None, "doors_open_at": None,
        "image_url": "", "artist_ids": [],
        "max_tickets_per_user": max_per_user,
        "is_published": True, "sold_out_message": "",
        "waves": [{
            "wave_id": wave_id, "name": "GENERAL", "price_ron": 100.0,
            "capacity": wave_capacity, "available": wave_capacity,
            "starts_at": _iso(days=-1), "ends_at": _iso(days=30),
            "tier": "general", "access_from": None,
        }],
        "created_at": _iso(),
    }
    db.events.insert_one(dict(doc))
    return doc


def _make_special_link(event_id: str, capacity: int) -> str:
    token = uuid.uuid4().hex[:16]
    db.special_links.insert_one({
        "link_id": f"spc_pytest_{uuid.uuid4().hex[:10]}",
        "token": token, "event_id": event_id, "label": "pytest",
        "price_ron": 0.0, "capacity": capacity, "used": 0,
        "created_at": _iso(),
    })
    return token


def _cleanup(event_id: str):
    db.events.delete_many({"event_id": event_id})
    db.reservations.delete_many({"event_id": event_id})
    db.tickets.delete_many({"event_id": event_id})
    db.special_links.delete_many({"event_id": event_id})


@pytest.fixture
def event():
    e = _make_event()
    yield e
    _cleanup(e["event_id"])


def _reserve_simultaneously(calls):
    """Release every request into the handler at the same instant.

    Without the barrier the threads start staggered by however long it takes to spawn
    them, which is easily enough for one reservation to land before the next reads —
    and a staggered run passes even against the racy code.
    """
    barrier = threading.Barrier(len(calls))
    out = [None] * len(calls)

    def run(i, headers, payload):
        barrier.wait()
        out[i] = requests.post(f"{API}/reservations", json=payload,
                               headers=headers, timeout=TIMEOUT)

    threads = [threading.Thread(target=run, args=(i, h, p))
               for i, (h, p) in enumerate(calls)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    if any(r.status_code == 429 for r in out):
        pytest.skip("/reservations rate-limit budget spent by another test in this window")
    return out


# --- M4 ------------------------------------------------------------------------------

class TestSpecialLinkCapacity:
    """M4: `used` was incremented only on payment, so nothing held invite-link capacity
    across the reserve->pay window."""

    def test_concurrent_reservations_cannot_oversell_a_link(self, event):
        capacity = 2
        token = _make_special_link(event["event_id"], capacity)
        wave_id = event["waves"][0]["wave_id"]

        # Distinct buyers, so the per-user cap cannot be what limits this — the only
        # thing standing between six requests and six reservations is the link.
        calls = []
        for _ in range(6):
            headers, _uid, _email = mint_user()
            calls.append((headers, {"event_id": event["event_id"], "wave_id": wave_id,
                                    "quantity": 1, "special_link_token": token}))

        responses = _reserve_simultaneously(calls)
        accepted = [r for r in responses if r.status_code == 200]
        rejected = [r for r in responses if r.status_code == 400]

        assert len(accepted) == capacity, (
            f"{len(accepted)} of 6 concurrent reservations succeeded against a link with "
            f"capacity {capacity} — the link oversold by {len(accepted) - capacity}"
        )
        assert len(rejected) == len(responses) - capacity, \
            f"unexpected statuses: {sorted(r.status_code for r in responses)}"

        link = db.special_links.find_one({"token": token})
        assert link["used"] == capacity
        assert db.reservations.count_documents(
            {"special_link_token": token, "status": "pending"}) == capacity

    def test_capacity_returns_when_a_reservation_expires(self, event):
        """The hold is only correct if it is also released — otherwise an abandoned
        checkout burns a comp seat permanently."""
        token = _make_special_link(event["event_id"], 1)
        wave_id = event["waves"][0]["wave_id"]
        headers, _uid, _email = mint_user()
        payload = {"event_id": event["event_id"], "wave_id": wave_id,
                   "quantity": 1, "special_link_token": token}

        r = requests.post(f"{API}/reservations", json=payload, headers=headers, timeout=TIMEOUT)
        support.skip_if_rate_limited(r, "reservations")
        assert r.status_code == 200, r.text
        assert db.special_links.find_one({"token": token})["used"] == 1

        # Backdate it past the hold window; the next reservation triggers the sweep.
        db.reservations.update_one(
            {"reservation_id": r.json()["reservation_id"]},
            {"$set": {"expires_at": _iso(minutes=-30)}},
        )

        headers2, _uid2, _email2 = mint_user()
        r2 = requests.post(f"{API}/reservations", json=payload, headers=headers2, timeout=TIMEOUT)
        support.skip_if_rate_limited(r2, "reservations")
        assert r2.status_code == 200, (
            "the expired reservation's capacity was never returned — "
            f"link now reads used={db.special_links.find_one({'token': token})['used']}"
        )
        assert db.special_links.find_one({"token": token})["used"] == 1


# --- M5 ------------------------------------------------------------------------------

class TestPerUserCap:
    """M5: the cap counted tickets plus pending reservations, then inserted separately."""

    def test_concurrent_reservations_cannot_exceed_the_cap(self):
        cap = 2
        e = _make_event(max_per_user=cap)
        wave_id = e["waves"][0]["wave_id"]
        headers, user_id, _email = mint_user()
        try:
            calls = [(headers, {"event_id": e["event_id"], "wave_id": wave_id,
                                "quantity": 1}) for _ in range(6)]
            responses = _reserve_simultaneously(calls)
            accepted = [r for r in responses if r.status_code == 200]

            assert len(accepted) == cap, (
                f"{len(accepted)} of 6 simultaneous reservations succeeded against a cap "
                f"of {cap} per user"
            )
            held = sum(d["quantity"] for d in db.reservations.find(
                {"event_id": e["event_id"], "user_id": user_id, "status": "pending"}))
            assert held == cap, f"{held} tickets held against a cap of {cap}"
        finally:
            _cleanup(e["event_id"])

    def test_rolled_back_reservations_return_their_stock(self):
        """A request that loses the cap race must give back the wave stock it took on
        the way in, or the losers quietly drain the event."""
        cap = 1
        e = _make_event(max_per_user=cap, wave_capacity=10)
        wave_id = e["waves"][0]["wave_id"]
        headers, _uid, _email = mint_user()
        try:
            calls = [(headers, {"event_id": e["event_id"], "wave_id": wave_id,
                                "quantity": 1}) for _ in range(5)]
            responses = _reserve_simultaneously(calls)
            accepted = sum(1 for r in responses if r.status_code == 200)
            assert accepted == cap

            wave = db.events.find_one({"event_id": e["event_id"]})["waves"][0]
            assert wave["available"] == 10 - cap, (
                f"wave shows {wave['available']} of 10 left after {accepted} reservation(s) "
                f"— {10 - cap - wave['available']} tickets were held by rolled-back requests "
                "and never returned"
            )
        finally:
            _cleanup(e["event_id"])

    def test_cap_still_allows_a_single_valid_reservation(self):
        """The guard must not be so eager that it blocks the ordinary path."""
        e = _make_event(max_per_user=4)
        wave_id = e["waves"][0]["wave_id"]
        headers, _uid, _email = mint_user()
        try:
            r = requests.post(f"{API}/reservations", timeout=TIMEOUT, headers=headers,
                              json={"event_id": e["event_id"], "wave_id": wave_id, "quantity": 3})
            support.skip_if_rate_limited(r, "reservations")
            assert r.status_code == 200, r.text
            assert r.json()["quantity"] == 3
        finally:
            _cleanup(e["event_id"])
