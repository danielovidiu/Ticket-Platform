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
import time
import uuid
import threading
from datetime import datetime, timezone, timedelta

import pytest
import requests

import support
from support import API, TIMEOUT, db, mint_user


# Runs on one worker, in order: the module's own xdist group. This is what
# `--dist loadgroup` needs in order to behave like the `loadscope` it replaced —
# see pytest.ini.
pytestmark = [pytest.mark.integration, pytest.mark.critical, pytest.mark.xdist_group("reservations_budget")]


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


def _reset_for_retry(event_id: str):
    """Put the event back exactly as the fixture built it, so a burst can be re-fired.

    Holds are not "released" here so much as overwritten — every wave goes back to its
    full capacity and every link back to `used: 0` — because a partially-landed burst is
    precisely the state that must not leak into the retry.
    """
    db.reservations.delete_many({"event_id": event_id})
    db.special_links.update_many({"event_id": event_id}, {"$set": {"used": 0}})
    ev = db.events.find_one({"event_id": event_id}, {"_id": 0, "waves": 1}) or {}
    for w in ev.get("waves", []):
        db.events.update_one({"event_id": event_id, "waves.wave_id": w["wave_id"]},
                             {"$set": {"waves.$.available": w["capacity"]}})


# The /reservations window, from server.py. Waiting this long guarantees an empty bucket.
RESERVATIONS_WINDOW = 60


def _sleep_out_window(responses) -> bool:
    """Wait for the /reservations window to roll completely. False when nothing was limited.

    Deliberately a full window rather than `Retry-After`. That header says when *one* slot
    frees — the oldest entry ageing out — and these bursts need six at once, so honouring
    it woke the retry into a bucket with two slots free and it failed again. This file
    self-exhausts even in isolation: its four bursts want 6 + 2 + 6 + 5 requests against a
    budget of 20 a minute.
    """
    if not any(r.status_code == 429 for r in responses):
        return False
    time.sleep(RESERVATIONS_WINDOW + 2)
    return True


def _reserve_simultaneously(calls, event_id, attempts: int = 3):
    """Release every request into the handler at the same instant.

    Without the barrier the threads start staggered by however long it takes to spawn
    them, which is easily enough for one reservation to land before the next reads —
    and a staggered run passes even against the racy code.

    A 429 anywhere in the burst used to skip the test. That was the wrong trade for this
    file: these two tests are the only proof M4 and M5 stay fixed, and a skip is
    indistinguishable from a pass in the summary line. `/reservations` allows 20 a minute,
    so the budget another test spent is worth waiting out — the state is reset between
    attempts so the retry is a genuine cold burst, not a continuation of a half-landed one.
    """
    barrier = threading.Barrier(len(calls))

    def fire():
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
        return out

    for attempt in range(attempts):
        out = fire()
        if attempt == attempts - 1 or not _sleep_out_window(out):
            break
        barrier.reset()
        _reset_for_retry(event_id)

    assert not [r for r in out if r.status_code == 429], (
        f"/reservations still rate-limited after {attempts} attempts — the burst never "
        "ran cleanly, so this says nothing about the oversell guard"
    )
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
        for _ in range(4):
            headers, _uid, _email = mint_user()
            calls.append((headers, {"event_id": event["event_id"], "wave_id": wave_id,
                                    "quantity": 1, "special_link_token": token}))

        responses = _reserve_simultaneously(calls, event["event_id"])
        accepted = [r for r in responses if r.status_code == 200]
        rejected = [r for r in responses if r.status_code == 400]

        assert len(accepted) == capacity, (
            f"{len(accepted)} of 4 concurrent reservations succeeded against a link with "
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

        r = support.patient.post(f"{API}/reservations", json=payload, headers=headers)
        assert r.status_code == 200, r.text
        assert db.special_links.find_one({"token": token})["used"] == 1

        # Backdate it past the hold window; the next reservation triggers the sweep.
        db.reservations.update_one(
            {"reservation_id": r.json()["reservation_id"]},
            {"$set": {"expires_at": _iso(minutes=-30)}},
        )

        headers2, _uid2, _email2 = mint_user()
        r2 = support.patient.post(f"{API}/reservations", json=payload, headers=headers2)
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
                                "quantity": 1}) for _ in range(4)]
            responses = _reserve_simultaneously(calls, e["event_id"])
            accepted = [r for r in responses if r.status_code == 200]

            assert len(accepted) == cap, (
                f"{len(accepted)} of 4 simultaneous reservations succeeded against a cap "
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
                                "quantity": 1}) for _ in range(3)]
            responses = _reserve_simultaneously(calls, e["event_id"])
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
            r = support.patient.post(f"{API}/reservations", headers=headers,
                                     json={"event_id": e["event_id"], "wave_id": wave_id, "quantity": 3})
            assert r.status_code == 200, r.text
            assert r.json()["quantity"] == 3
        finally:
            _cleanup(e["event_id"])


# --- shop orders (found re-auditing shop_routes.py, which the audit never covered) ------

class TestShopOrderCancelIsNotRepeatable:
    """Cancelling a paid shop order credits its stock back. That has to happen once.

    `admin_update_order` read the order, released the stock, then wrote the new status
    with an unconditional `$set` — so every request that got through the flow check did
    the full job. Six concurrent cancels each returned 200 and each credited the stock:
    a variant went 5 -> 17 where 7 was correct. Sequential double-clicks were always
    safe (the second fails the flow check); only genuinely concurrent ones raced.

    Reproduced before the fix, which is why the numbers above are specific.
    """

    def _product(self, stock: int = 5):
        pid, vid = f"prd_pytest_{uuid.uuid4().hex[:10]}", f"var_pytest_{uuid.uuid4().hex[:10]}"
        db.products.insert_one({
            "product_id": pid, "slug": f"test-race-{uuid.uuid4().hex[:8]}",
            "name": "TEST_race", "description": "", "images": [], "price_ron": 100.0,
            "category": "TEST_race", "gender": "unisex", "is_published": False,
            "sort_order": 0, "created_at": _iso(),
            "variants": [{"variant_id": vid, "size": "M", "sku": "R-M", "stock": stock}],
        })
        return pid, vid

    def _paid_order(self, pid, vid, user_id, quantity=2):
        oid = f"ord_pytest_{uuid.uuid4().hex[:10]}"
        db.shop_orders.insert_one({
            "order_id": oid, "user_id": user_id, "email": "race@pytest.invalid",
            "status": "paid", "items": [{
                "product_id": pid, "variant_id": vid, "slug": "s", "name": "TEST_race",
                "size": "M", "sku": "R-M", "unit_price_ron": 100.0,
                "quantity": quantity, "line_total_ron": 100.0 * quantity}],
            "subtotal_ron": 200.0, "shipping_ron": 0.0, "total_ron": 200.0,
            "vat_rate": 0.19, "net_ron": 168.07, "vat_amount_ron": 31.93,
            "shipping_zone": "RO", "shipping_address": {}, "hold_expires_at": _iso(),
            "created_at": _iso(), "paid_at": _iso(), "shipped_at": None,
            "delivered_at": None, "tracking_number": "", "carrier": "", "invoice_id": None,
        })
        return oid

    def _stock(self, pid):
        return db.products.find_one({"product_id": pid})["variants"][0]["stock"]

    def test_concurrent_cancels_credit_the_stock_once(self, admin_headers):
        pid, vid = self._product(stock=5)
        _h, uid, _e = mint_user()
        oid = self._paid_order(pid, vid, uid, quantity=2)
        try:
            barrier = threading.Barrier(6)
            out = [None] * 6

            def cancel(i):
                barrier.wait()
                out[i] = requests.patch(f"{API}/admin/shop/orders/{oid}",
                                        json={"status": "cancelled"},
                                        headers=admin_headers, timeout=TIMEOUT)

            threads = [threading.Thread(target=cancel, args=(i,)) for i in range(6)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()

            assert sum(1 for r in out if r.status_code == 200) == 1, \
                f"more than one cancel succeeded: {sorted(r.status_code for r in out)}"
            assert self._stock(pid) == 7, (
                f"stock is {self._stock(pid)}; 5 held 2 back, so 7 is right — anything "
                "higher is the same credit applied more than once"
            )
            assert db.shop_orders.find_one({"order_id": oid})["status"] == "cancelled"
        finally:
            db.products.delete_many({"product_id": pid})
            db.shop_orders.delete_many({"order_id": oid})

    def test_a_single_cancel_still_works(self, admin_headers):
        """The guard must not break the ordinary one-admin-one-click path."""
        pid, vid = self._product(stock=5)
        _h, uid, _e = mint_user()
        oid = self._paid_order(pid, vid, uid, quantity=2)
        try:
            r = requests.patch(f"{API}/admin/shop/orders/{oid}", json={"status": "cancelled"},
                               headers=admin_headers, timeout=TIMEOUT)
            assert r.status_code == 200, r.text
            assert self._stock(pid) == 7
        finally:
            db.products.delete_many({"product_id": pid})
            db.shop_orders.delete_many({"order_id": oid})
