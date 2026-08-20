"""
The four Low findings: L1 hash disclosure, L2 unauthenticated order data, L3 lost
inventory, L4 stock that never comes back on a quiet event.

None of these is exploitable on its own — that is what makes them Low. They are the
things that turn something else into a real problem, or that quietly cost money.
"""
import uuid
from datetime import datetime, timezone, timedelta

import jwt
import pytest
import requests

from support import API, TIMEOUT, db, mint_user

import server


# Runs on one worker, in order: the module's own xdist group. This is what
# `--dist loadgroup` needs in order to behave like the `loadscope` it replaced —
# see pytest.ini.
pytestmark = [pytest.mark.integration, pytest.mark.critical,
              pytest.mark.xdist_group("reservations_budget")]


def _iso(**delta):
    return (datetime.now(timezone.utc) + timedelta(**delta)).isoformat()


def _event(starts_in_days=7, capacity=10):
    """An event with one wave, and a wave that has already sold two seats."""
    event_id = f"evt_low_{uuid.uuid4().hex[:10]}"
    wave_id = f"wave_low_{uuid.uuid4().hex[:10]}"
    db.events.insert_one({
        "event_id": event_id, "title": f"TEST_low {uuid.uuid4().hex[:6]}",
        "slug": f"test-low-{uuid.uuid4().hex[:8]}", "description": "", "venue": "", "city": "",
        "starts_at": _iso(days=starts_in_days), "ends_at": None, "doors_open_at": None,
        "image_url": "", "artist_ids": [], "max_tickets_per_user": 4,
        "is_published": True, "sold_out_message": "", "created_at": _iso(),
        "waves": [{"wave_id": wave_id, "name": "GENERAL", "price_ron": 100.0,
                   "capacity": capacity, "available": capacity - 2,
                   "starts_at": _iso(days=-1), "ends_at": _iso(days=30),
                   "tier": "general", "access_until": None}],
    })
    return event_id, wave_id


def _reservation(event_id, wave_id, user_id, status="paid", quantity=2, expires_in=10):
    rid = f"res_low_{uuid.uuid4().hex[:10]}"
    db.reservations.insert_one({
        "reservation_id": rid, "user_id": user_id, "event_id": event_id, "wave_id": wave_id,
        "quantity": quantity, "status": status, "total_ron": 100.0 * quantity,
        "expires_at": _iso(minutes=expires_in), "created_at": _iso(),
    })
    return rid


def _available(event_id):
    return db.events.find_one({"event_id": event_id})["waves"][0]["available"]


# --- L1 -------------------------------------------------------------------------------

class TestResetTokenDiscloservesNothing:
    """A JWT payload is base64, not encrypted. Whatever is in the `ph` claim is readable
    by anyone who sees the reset URL — a proxy log, a browser history, a forwarded email."""

    def test_the_token_carries_no_fragment_of_the_stored_hash(self):
        password_hash = "$2b$12$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ012345"
        token = server.make_token("pwd-reset", "user_low_test",
                                  {"ph": server._password_fingerprint(password_hash)})
        claims = jwt.decode(token, options={"verify_signature": False, "verify_aud": False})

        assert password_hash[-12:] not in token, "twelve characters of the hash are in the URL"
        assert claims["ph"] not in password_hash, "the claim is a substring of the hash"
        for size in (8, 12, 16):
            assert password_hash[-size:] not in claims["ph"]

    def test_the_fingerprint_still_changes_when_the_password_does(self):
        """The whole point of the claim: it makes the token single-use."""
        a = server._password_fingerprint("$2b$12$" + "a" * 53)
        b = server._password_fingerprint("$2b$12$" + "b" * 53)
        assert a != b
        assert a == server._password_fingerprint("$2b$12$" + "a" * 53), "not deterministic"

    def test_it_is_not_reversible_to_the_hash(self):
        digest = server._password_fingerprint("$2b$12$" + "x" * 53)
        assert len(digest) == 32
        assert all(c in "0123456789abcdef" for c in digest), "not a hex digest"


# --- L2 -------------------------------------------------------------------------------

class TestPaymentStatusReturnsOnlyTheOutcome:
    """Unauthenticated on purpose — the success page polls it before its cookie is back —
    which is exactly why it must not hand over the transaction row."""

    @pytest.fixture
    def transaction(self):
        session_id = f"cs_low_{uuid.uuid4().hex[:16]}"
        db.payment_transactions.insert_one({
            "session_id": session_id, "payment_status": "paid", "status": "complete",
            "user_id": "user_low_victim", "email": "victim@pytest.invalid",
            "amount_ron": 1234.56, "reservation_id": "res_low_secret",
            "created_at": _iso(),
        })
        yield session_id
        db.payment_transactions.delete_many({"session_id": session_id})

    def test_it_does_not_leak_who_paid_or_how_much(self, transaction):
        r = requests.get(f"{API}/payments/status/{transaction}", timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        body = r.json()
        for leaked in ("user_id", "email", "amount_ron", "reservation_id"):
            assert leaked not in body, f"{leaked} is still in the response: {body}"
        assert "victim@pytest.invalid" not in r.text
        assert "1234.56" not in r.text

    def test_it_still_tells_the_success_page_what_it_needs(self, transaction):
        """`payment_status` and `status` are the two fields both success pages poll."""
        body = requests.get(f"{API}/payments/status/{transaction}", timeout=TIMEOUT).json()
        assert body["payment_status"] == "paid"
        assert body["status"] == "complete"

    def test_an_unknown_session_is_404(self):
        r = requests.get(f"{API}/payments/status/cs_low_nope", timeout=TIMEOUT)
        assert r.status_code == 404


# --- L3 -------------------------------------------------------------------------------

class TestRefundReturnsSellableStock:

    def test_a_refund_before_the_show_puts_the_seats_back(self, admin_headers):
        event_id, wave_id = _event(starts_in_days=7)
        _h, uid, _e = mint_user()
        rid = _reservation(event_id, wave_id, uid, quantity=2)
        try:
            assert _available(event_id) == 8
            r = requests.post(f"{API}/admin/orders/{rid}/refund", headers=admin_headers, timeout=TIMEOUT)
            assert r.status_code == 200, r.text
            assert r.json()["stock_returned"] is True
            assert _available(event_id) == 10, "the refunded seats never went back on sale"
        finally:
            db.events.delete_many({"event_id": event_id})
            db.reservations.delete_many({"reservation_id": rid})

    def test_a_refund_after_the_show_does_not(self, admin_headers):
        """Nothing can be sold into a finished event, and incrementing `available` on one
        only corrupts the numbers an admin reads afterwards."""
        event_id, wave_id = _event(starts_in_days=-3)
        _h, uid, _e = mint_user()
        rid = _reservation(event_id, wave_id, uid, quantity=2)
        try:
            r = requests.post(f"{API}/admin/orders/{rid}/refund", headers=admin_headers, timeout=TIMEOUT)
            assert r.status_code == 200, r.text
            assert r.json()["stock_returned"] is False
            assert _available(event_id) == 8, "stock was returned to a finished event"
        finally:
            db.events.delete_many({"event_id": event_id})
            db.reservations.delete_many({"reservation_id": rid})

    def test_refunding_twice_credits_the_stock_once(self, admin_headers):
        """The S1 lesson, applied rather than re-learned: the status flip is conditional."""
        event_id, wave_id = _event(starts_in_days=7)
        _h, uid, _e = mint_user()
        rid = _reservation(event_id, wave_id, uid, quantity=2)
        try:
            requests.post(f"{API}/admin/orders/{rid}/refund", headers=admin_headers, timeout=TIMEOUT)
            second = requests.post(f"{API}/admin/orders/{rid}/refund", headers=admin_headers, timeout=TIMEOUT)
            assert second.status_code == 200, second.text
            assert second.json().get("stock_returned") is False
            assert _available(event_id) == 10, "the second refund credited the stock again"
        finally:
            db.events.delete_many({"event_id": event_id})
            db.reservations.delete_many({"reservation_id": rid})

    def test_the_tickets_are_marked_refunded(self, admin_headers):
        event_id, wave_id = _event(starts_in_days=7)
        _h, uid, _e = mint_user()
        rid = _reservation(event_id, wave_id, uid)
        tkt = f"tkt_low_{uuid.uuid4().hex[:10]}"
        db.tickets.insert_one({
            "ticket_id": tkt, "qr_code": f"SNTY-LOW-{uuid.uuid4().hex[:10].upper()}",
            "reservation_id": rid, "user_id": uid, "event_id": event_id, "wave_id": wave_id,
            "price_ron": 100.0, "status": "issued", "scanned_at": None,
            "scanned_by": None, "created_at": _iso(),
        })
        try:
            requests.post(f"{API}/admin/orders/{rid}/refund", headers=admin_headers, timeout=TIMEOUT)
            assert db.tickets.find_one({"ticket_id": tkt})["status"] == "refunded"
        finally:
            db.events.delete_many({"event_id": event_id})
            db.reservations.delete_many({"reservation_id": rid})
            db.tickets.delete_many({"ticket_id": tkt})


class TestRefundOnlyGivesBackWhatWasHeld:
    """`available` above `capacity` is inventory that was never sold.

    The refund route used to claim any row that was not already `refunded`. A reservation
    only holds stock while it is `pending`, and the expiry sweep hands that stock back
    when it flips the row to `expired` — so refunding anything unpaid credited the wave a
    second time, and the surplus then survived every admin edit (see
    TestAnOverCountDoesNotSurviveAnEdit).
    """

    def _wave_at(self, capacity, available, starts_in_days=7):
        event_id = f"evt_low_{uuid.uuid4().hex[:10]}"
        wave_id = f"wave_low_{uuid.uuid4().hex[:10]}"
        db.events.insert_one({
            "event_id": event_id, "title": f"TEST_low {uuid.uuid4().hex[:6]}",
            "slug": f"test-low-{uuid.uuid4().hex[:8]}", "description": "", "venue": "", "city": "",
            "starts_at": _iso(days=starts_in_days), "ends_at": None, "doors_open_at": None,
            "image_url": "", "artist_ids": [], "max_tickets_per_user": 4,
            "is_published": True, "sold_out_message": "", "created_at": _iso(),
            "waves": [{"wave_id": wave_id, "name": "GENERAL", "price_ron": 100.0,
                       "capacity": capacity, "available": available,
                       "starts_at": _iso(days=-1), "ends_at": _iso(days=30),
                       "tier": "general", "access_until": None}],
        })
        return event_id, wave_id

    @pytest.mark.parametrize("status", ["expired", "pending"])
    def test_an_unpaid_reservation_cannot_credit_the_wave(self, admin_headers, status):
        """Capacity 10 with all 10 on sale: whatever this row once held is already back."""
        event_id, wave_id = self._wave_at(capacity=10, available=10)
        _h, uid, _e = mint_user()
        rid = _reservation(event_id, wave_id, uid, status=status, quantity=2)
        try:
            r = requests.post(f"{API}/admin/orders/{rid}/refund",
                              headers=admin_headers, timeout=TIMEOUT)
            assert r.status_code == 200, r.text
            assert r.json()["stock_returned"] is False
            assert r.json()["not_paid"] is True
            assert _available(event_id) == 10, (
                f"a {status} reservation was refunded and invented seats"
            )
            assert db.reservations.find_one(
                {"reservation_id": rid})["status"] == status, "status changed on a no-op refund"
        finally:
            db.events.delete_many({"event_id": event_id})
            db.reservations.delete_many({"reservation_id": rid})

    def test_the_reported_case_capacity_100_one_sold_then_refunded(self, admin_headers):
        """The path that always worked, pinned so it keeps working: 100 capacity, one
        seat sold, refunded before the show, back to 100."""
        event_id, wave_id = self._wave_at(capacity=100, available=99)
        _h, uid, _e = mint_user()
        rid = _reservation(event_id, wave_id, uid, quantity=1)
        try:
            r = requests.post(f"{API}/admin/orders/{rid}/refund",
                              headers=admin_headers, timeout=TIMEOUT)
            assert r.status_code == 200, r.text
            assert r.json()["stock_returned"] is True
            assert _available(event_id) == 100
        finally:
            db.events.delete_many({"event_id": event_id})
            db.reservations.delete_many({"reservation_id": rid})

    def test_a_release_can_never_push_availability_past_capacity(self, admin_headers):
        """The backstop, independent of who calls it: even a paid row whose seats were
        somehow already back cannot lift `available` above the ceiling."""
        event_id, wave_id = self._wave_at(capacity=10, available=10)
        _h, uid, _e = mint_user()
        rid = _reservation(event_id, wave_id, uid, quantity=2)  # status="paid"
        try:
            requests.post(f"{API}/admin/orders/{rid}/refund",
                          headers=admin_headers, timeout=TIMEOUT)
            assert _available(event_id) == 10, "the ceiling did not hold"
        finally:
            db.events.delete_many({"event_id": event_id})
            db.reservations.delete_many({"reservation_id": rid})


class TestAnOverCountDoesNotSurviveAnEdit:
    """`sold` is derived as capacity - available. On a wave already over its ceiling that
    is negative, and the reconciliation added it back rather than clamping — so a 250-seat
    wave showing 251 stayed at 251 through every save, and shrinking it to 200 gave 201."""

    def _over_counted(self, capacity=250, available=251):
        event_id = f"evt_low_{uuid.uuid4().hex[:10]}"
        wave_id = f"wave_low_{uuid.uuid4().hex[:10]}"
        db.events.insert_one({
            "event_id": event_id, "title": f"TEST_low {uuid.uuid4().hex[:6]}",
            "slug": f"test-low-{uuid.uuid4().hex[:8]}", "description": "", "venue": "", "city": "",
            "starts_at": _iso(days=7), "ends_at": None, "doors_open_at": None,
            "image_url": "", "artist_ids": [], "max_tickets_per_user": 4,
            "is_published": True, "sold_out_message": "", "created_at": _iso(),
            "waves": [{"wave_id": wave_id, "name": "GENERAL", "price_ron": 100.0,
                       "capacity": capacity, "available": available,
                       "starts_at": _iso(days=-1), "ends_at": _iso(days=30),
                       "tier": "general", "access_until": None}],
        })
        return event_id, wave_id

    def _patch(self, admin_headers, event_id, wave_id, capacity):
        return requests.patch(
            f"{API}/admin/events/{event_id}",
            json={"waves": [{"wave_id": wave_id, "name": "GENERAL", "price_ron": 100.0,
                             "capacity": capacity, "starts_at": _iso(days=-1),
                             "ends_at": _iso(days=30), "tier": "general"}]},
            headers=admin_headers, timeout=TIMEOUT)

    def test_re_saving_the_lineup_heals_it(self, admin_headers):
        event_id, wave_id = self._over_counted()
        try:
            r = self._patch(admin_headers, event_id, wave_id, capacity=250)
            assert r.status_code == 200, r.text
            assert _available(event_id) == 250, "the surplus survived the edit"
        finally:
            db.events.delete_many({"event_id": event_id})

    def test_shrinking_the_capacity_heals_it_too(self, admin_headers):
        event_id, wave_id = self._over_counted()
        try:
            r = self._patch(admin_headers, event_id, wave_id, capacity=200)
            assert r.status_code == 200, r.text
            assert _available(event_id) == 200, "the surplus was carried down with capacity"
        finally:
            db.events.delete_many({"event_id": event_id})

    def test_a_healthy_wave_still_keeps_its_sold_count(self, admin_headers):
        """The clamp must not erase real sales: 10 capacity with 2 sold stays 2 sold."""
        event_id, wave_id = self._over_counted(capacity=10, available=8)
        try:
            r = self._patch(admin_headers, event_id, wave_id, capacity=20)
            assert r.status_code == 200, r.text
            assert _available(event_id) == 18, "the two sold seats were forgotten"
        finally:
            db.events.delete_many({"event_id": event_id})


# --- L4 -------------------------------------------------------------------------------

class TestExpiredHoldsComeBackOnQuietEvents:
    """The sweep only runs when somebody reserves. Filtering it to that one event meant an
    abandoned checkout on a show nobody is buying held its seats indefinitely — the stock
    was withheld exactly where it was least affordable."""

    def test_a_quiet_events_expired_hold_is_swept_by_activity_elsewhere(self, admin_headers):
        quiet_event, quiet_wave = _event(starts_in_days=20)
        busy_event, busy_wave = _event(starts_in_days=20)
        _h, uid, _e = mint_user()
        stale = _reservation(quiet_event, quiet_wave, uid, status="pending",
                             quantity=2, expires_in=-30)
        buyer, buyer_id, _be = mint_user()
        try:
            assert _available(quiet_event) == 8

            # Somebody reserves on a *different* event. Under the old per-event filter this
            # swept nothing on the quiet one.
            r = requests.post(f"{API}/reservations", headers=buyer, timeout=TIMEOUT,
                              json={"event_id": busy_event, "wave_id": busy_wave, "quantity": 1})
            if r.status_code == 429:
                pytest.skip("reservations budget spent by another test in this window")
            assert r.status_code == 200, r.text

            assert _available(quiet_event) == 10, (
                "the expired hold on the quiet event was never returned — that is L4"
            )
            assert db.reservations.find_one({"reservation_id": stale})["status"] == "expired"
        finally:
            for eid in (quiet_event, busy_event):
                db.events.delete_many({"event_id": eid})
                db.reservations.delete_many({"event_id": eid})

    def test_a_live_hold_is_left_alone(self, admin_headers):
        """The sweep must only take holds that have actually expired."""
        event_id, wave_id = _event(starts_in_days=20)
        _h, uid, _e = mint_user()
        live = _reservation(event_id, wave_id, uid, status="pending", quantity=2, expires_in=30)
        buyer, _bid, _be = mint_user()
        other_event, other_wave = _event(starts_in_days=20)
        try:
            r = requests.post(f"{API}/reservations", headers=buyer, timeout=TIMEOUT,
                              json={"event_id": other_event, "wave_id": other_wave, "quantity": 1})
            if r.status_code == 429:
                pytest.skip("reservations budget spent by another test in this window")
            assert _available(event_id) == 8, "a hold that has not expired was swept"
            assert db.reservations.find_one({"reservation_id": live})["status"] == "pending"
        finally:
            for eid in (event_id, other_event):
                db.events.delete_many({"event_id": eid})
                db.reservations.delete_many({"event_id": eid})
