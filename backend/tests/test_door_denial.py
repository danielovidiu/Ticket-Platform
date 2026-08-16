"""
Denying entry at the door, and refunding that one ticket afterwards.

Two guarantees worth pinning. `denied` has to be *terminal* — a guest turned away who
walks to the back of the queue and rescans must not get in — and the refund has to be
per ticket, because denying one person cannot refund the friends who were admitted on
the same purchase.
"""
import uuid
from datetime import datetime, timezone, timedelta

import pytest
import requests

import support
from support import API, TIMEOUT, db, mint_user


pytestmark = pytest.mark.integration


def _iso(**delta):
    return (datetime.now(timezone.utc) + timedelta(**delta)).isoformat()


def _make_event(**overrides) -> dict:
    """An event whose doors are open now, so a scan is not refused on timing."""
    event_id = f"evt_pytest_door_{uuid.uuid4().hex[:10]}"
    doc = {
        "event_id": event_id,
        "title": f"pytest door {uuid.uuid4().hex[:6]}",
        "slug": f"pytest-door-{uuid.uuid4().hex[:8]}",
        "description": "", "venue": "Club Pytest", "city": "Bucharest",
        "starts_at": _iso(hours=-1), "ends_at": _iso(hours=4),
        "doors_open_at": _iso(hours=-2),
        "image_url": "", "artist_ids": [], "max_tickets_per_user": 4,
        "is_published": True, "sold_out_message": "", "waves": [],
        "created_at": _iso(),
    }
    doc.update(overrides)
    db.events.insert_one(dict(doc))
    return doc


def _give_ticket(event_id, user_id, status="issued", reservation_id=None) -> dict:
    doc = {
        "ticket_id": f"tkt_pytest_{uuid.uuid4().hex[:12]}",
        "qr_code": f"SNTY-PYTEST-{uuid.uuid4().hex[:12].upper()}",
        "reservation_id": reservation_id, "user_id": user_id, "event_id": event_id,
        "wave_id": None, "price_ron": 100.0, "status": status,
        "scanned_at": None, "scanned_by": None, "created_at": _iso(),
    }
    db.tickets.insert_one(dict(doc))
    return doc


@pytest.fixture
def event():
    e = _make_event()
    yield e
    db.events.delete_many({"event_id": e["event_id"]})
    db.tickets.delete_many({"event_id": e["event_id"]})


def _scan(headers, qr):
    return requests.post(f"{API}/scan", json={"qr_code": qr}, headers=headers, timeout=TIMEOUT)


def _deny(headers, qr, reason=""):
    return requests.post(f"{API}/scan/deny", json={"qr_code": qr, "reason": reason},
                         headers=headers, timeout=TIMEOUT)


def _stored(qr):
    return db.tickets.find_one({"qr_code": qr}, {"_id": 0})


# --- denial ---------------------------------------------------------------------------

class TestDenyEntry:
    def test_scan_then_deny_marks_denied(self, door_headers, event):
        _h, uid, _e = mint_user()
        t = _give_ticket(event["event_id"], uid)

        assert _scan(door_headers, t["qr_code"]).json()["valid"] is True
        assert _stored(t["qr_code"])["status"] == "used"

        r = _deny(door_headers, t["qr_code"], "No ID")
        assert r.status_code == 200, r.text
        assert r.json()["ok"] is True

        stored = _stored(t["qr_code"])
        assert stored["status"] == "denied"
        assert stored["deny_reason"] == "No ID"
        assert stored["denied_at"]
        assert stored["denied_by"]

    def test_denied_ticket_cannot_scan_back_in(self, door_headers, event):
        """The point of the whole feature: turned away means turned away."""
        _h, uid, _e = mint_user()
        t = _give_ticket(event["event_id"], uid)
        _scan(door_headers, t["qr_code"])
        _deny(door_headers, t["qr_code"], "Refused search")

        again = _scan(door_headers, t["qr_code"]).json()
        assert again["valid"] is False
        assert "DENIED" in again["reason"]
        assert _stored(t["qr_code"])["status"] == "denied"

    def test_deny_is_idempotent(self, door_headers, event):
        """Door wifi drops responses; a retry must not report failure for a decision
        that already landed."""
        _h, uid, _e = mint_user()
        t = _give_ticket(event["event_id"], uid)
        _scan(door_headers, t["qr_code"])

        first = _deny(door_headers, t["qr_code"], "Intoxicated")
        second = _deny(door_headers, t["qr_code"], "Intoxicated")
        assert first.json()["ok"] is True
        assert second.json()["ok"] is True
        assert _stored(t["qr_code"])["deny_reason"] == "Intoxicated"

    def test_cannot_deny_an_unscanned_ticket(self, door_headers, event):
        """Denial reverses an admission, so there has to be one."""
        _h, uid, _e = mint_user()
        t = _give_ticket(event["event_id"], uid, status="issued")

        r = _deny(door_headers, t["qr_code"])
        assert r.json()["ok"] is False
        assert "ISSUED" in r.json()["reason"]
        assert _stored(t["qr_code"])["status"] == "issued"

    def test_cannot_deny_a_refunded_ticket(self, door_headers, event):
        _h, uid, _e = mint_user()
        t = _give_ticket(event["event_id"], uid, status="refunded")
        r = _deny(door_headers, t["qr_code"])
        assert r.json()["ok"] is False
        assert _stored(t["qr_code"])["status"] == "refunded"

    def test_unknown_code_is_reported_not_crashed(self, door_headers):
        r = _deny(door_headers, "SNTY-DOES-NOT-EXIST")
        assert r.status_code == 200
        assert r.json() == {"ok": False, "reason": "TICKET NOT FOUND"}

    def test_reason_is_optional(self, door_headers, event):
        _h, uid, _e = mint_user()
        t = _give_ticket(event["event_id"], uid)
        _scan(door_headers, t["qr_code"])
        assert _deny(door_headers, t["qr_code"]).json()["ok"] is True
        assert _stored(t["qr_code"])["deny_reason"] == ""


class TestDenyAccess:
    def test_plain_user_cannot_deny(self, user_headers, event):
        _h, uid, _e = mint_user()
        t = _give_ticket(event["event_id"], uid, status="used")
        assert _deny(user_headers, t["qr_code"]).status_code == 403
        assert _stored(t["qr_code"])["status"] == "used"

    def test_anonymous_cannot_deny(self, event):
        _h, uid, _e = mint_user()
        t = _give_ticket(event["event_id"], uid, status="used")
        r = requests.post(f"{API}/scan/deny", json={"qr_code": t["qr_code"]}, timeout=TIMEOUT)
        assert r.status_code in (401, 403)

    def test_admin_can_deny_too(self, admin_headers, event):
        """Admins work the door on small nights."""
        _h, uid, _e = mint_user()
        t = _give_ticket(event["event_id"], uid)
        _scan(admin_headers, t["qr_code"])
        assert _deny(admin_headers, t["qr_code"]).json()["ok"] is True


# --- refund ---------------------------------------------------------------------------

class TestTicketRefund:
    def test_refunds_only_the_denied_ticket(self, admin_headers, door_headers, event):
        """Four friends, one order, one of them turned away. The other three keep their
        tickets — which the whole-order refund endpoint would not have managed."""
        _h, uid, _e = mint_user()
        reservation = f"res_pytest_{uuid.uuid4().hex[:10]}"
        denied = _give_ticket(event["event_id"], uid, reservation_id=reservation)
        siblings = [_give_ticket(event["event_id"], uid, reservation_id=reservation)
                    for _ in range(3)]

        _scan(door_headers, denied["qr_code"])
        _deny(door_headers, denied["qr_code"], "No ID")

        r = requests.post(f"{API}/admin/tickets/{denied['ticket_id']}/refund",
                          headers=admin_headers, timeout=TIMEOUT)
        assert r.status_code == 200, r.text

        assert _stored(denied["qr_code"])["status"] == "refunded"
        for s in siblings:
            assert _stored(s["qr_code"])["status"] == "issued", \
                "refunding one denied ticket refunded its whole order"

    def test_refund_keeps_the_reason_it_happened(self, admin_headers, door_headers, event):
        _h, uid, _e = mint_user()
        t = _give_ticket(event["event_id"], uid)
        _scan(door_headers, t["qr_code"])
        _deny(door_headers, t["qr_code"], "Refused search")

        requests.post(f"{API}/admin/tickets/{t['ticket_id']}/refund",
                      headers=admin_headers, timeout=TIMEOUT)

        stored = _stored(t["qr_code"])
        assert stored["status"] == "refunded"
        assert stored["deny_reason"] == "Refused search"
        assert stored["denied_at"]

    def test_refund_works_after_the_event_has_ended(self, admin_headers, door_headers):
        """The whole point of doing it later — deny at the door, settle up afterwards."""
        e = _make_event()
        _h, uid, _e = mint_user()
        t = _give_ticket(e["event_id"], uid)
        try:
            _scan(door_headers, t["qr_code"])
            _deny(door_headers, t["qr_code"], "No ID")
            # The event is now over.
            db.events.update_one({"event_id": e["event_id"]},
                                 {"$set": {"ends_at": _iso(hours=-1)}})

            r = requests.post(f"{API}/admin/tickets/{t['ticket_id']}/refund",
                              headers=admin_headers, timeout=TIMEOUT)
            assert r.status_code == 200, r.text
            assert _stored(t["qr_code"])["status"] == "refunded"
        finally:
            db.events.delete_many({"event_id": e["event_id"]})
            db.tickets.delete_many({"event_id": e["event_id"]})

    def test_refund_is_idempotent(self, admin_headers, door_headers, event):
        _h, uid, _e = mint_user()
        t = _give_ticket(event["event_id"], uid)
        _scan(door_headers, t["qr_code"])
        _deny(door_headers, t["qr_code"])
        url = f"{API}/admin/tickets/{t['ticket_id']}/refund"
        assert requests.post(url, headers=admin_headers, timeout=TIMEOUT).status_code == 200
        second = requests.post(url, headers=admin_headers, timeout=TIMEOUT)
        assert second.status_code == 200
        assert second.json()["already"] is True

    def test_unknown_ticket_is_404(self, admin_headers):
        r = requests.post(f"{API}/admin/tickets/tkt_nope/refund",
                          headers=admin_headers, timeout=TIMEOUT)
        assert r.status_code == 404

    def test_non_admin_cannot_refund(self, door_headers, event):
        """Door staff deny; only admins move money."""
        _h, uid, _e = mint_user()
        t = _give_ticket(event["event_id"], uid, status="denied")
        r = requests.post(f"{API}/admin/tickets/{t['ticket_id']}/refund",
                          headers=door_headers, timeout=TIMEOUT)
        assert r.status_code == 403
        assert _stored(t["qr_code"])["status"] == "denied"


def _list(headers, **params):
    return requests.get(f"{API}/admin/tickets", params=params,
                        headers=headers, timeout=TIMEOUT)


class TestEventCancellation:
    """Cancelling an event used to mark its tickets `refunded` outright, which said
    something untrue — no money had moved — and made "we called the show off"
    indistinguishable from "this buyer was refunded"."""

    def _cancel(self, admin_headers, event_id):
        return requests.post(f"{API}/admin/events/{event_id}/cancel",
                             headers=admin_headers, timeout=TIMEOUT)

    def test_issued_tickets_become_cancelled_not_refunded(self, admin_headers, event):
        _h, uid, _e = mint_user()
        t = _give_ticket(event["event_id"], uid)

        r = self._cancel(admin_headers, event["event_id"])
        assert r.status_code == 200, r.text
        assert r.json()["tickets_cancelled"] == 1

        stored = _stored(t["qr_code"])
        assert stored["status"] == "cancelled", "a cancellation is not a completed refund"
        assert stored["cancelled_at"]

    def test_a_cancelled_ticket_does_not_scan(self, admin_headers, door_headers, event):
        _h, uid, _e = mint_user()
        t = _give_ticket(event["event_id"], uid)
        self._cancel(admin_headers, event["event_id"])

        res = _scan(door_headers, t["qr_code"]).json()
        assert res["valid"] is False
        assert "CANCELLED" in res["reason"]

    def test_settled_tickets_are_left_alone(self, admin_headers, door_headers, event):
        """A guest already inside, one refused at the door, and one already refunded are
        each finished business — calling off what remains does not reopen them."""
        _h, uid, _e = mint_user()
        used = _give_ticket(event["event_id"], uid)
        denied = _give_ticket(event["event_id"], uid)
        already = _give_ticket(event["event_id"], uid, status="refunded")
        _scan(door_headers, used["qr_code"])
        _scan(door_headers, denied["qr_code"])
        _deny(door_headers, denied["qr_code"], "No ID")

        self._cancel(admin_headers, event["event_id"])

        assert _stored(used["qr_code"])["status"] == "used"
        assert _stored(denied["qr_code"])["status"] == "denied"
        assert _stored(already["qr_code"])["status"] == "refunded"

    def test_cancelled_ticket_can_then_be_refunded(self, admin_headers, event):
        """`cancelled` is the state between calling the show off and paying people back."""
        _h, uid, _e = mint_user()
        t = _give_ticket(event["event_id"], uid)
        self._cancel(admin_headers, event["event_id"])

        r = requests.post(f"{API}/admin/tickets/{t['ticket_id']}/refund",
                          headers=admin_headers, timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        assert _stored(t["qr_code"])["status"] == "refunded"

    def test_refunded_cancellation_stays_under_both_filters(self, admin_headers, event):
        """Otherwise "who is still owed money?" has no answer once you start paying."""
        _h, uid, _e = mint_user()
        t = _give_ticket(event["event_id"], uid)
        self._cancel(admin_headers, event["event_id"])
        requests.post(f"{API}/admin/tickets/{t['ticket_id']}/refund",
                      headers=admin_headers, timeout=TIMEOUT)

        for status in ("cancelled", "refunded"):
            rows = _list(admin_headers, status=status,
                         event_id=event["event_id"]).json()["tickets"]
            assert t["ticket_id"] in [r["ticket_id"] for r in rows], \
                f"missing from the {status} filter"

    def test_a_denial_is_not_a_cancellation(self, admin_headers, door_headers, event):
        """The distinction the status exists for: both end at `refunded`, and the two
        filters must not bleed into each other."""
        _h, uid, _e = mint_user()
        denied = _give_ticket(event["event_id"], uid)
        cancelled = _give_ticket(event["event_id"], uid)
        _scan(door_headers, denied["qr_code"])
        _deny(door_headers, denied["qr_code"], "No ID")
        self._cancel(admin_headers, event["event_id"])

        def ids(status):
            return {r["ticket_id"] for r in
                    _list(admin_headers, status=status, event_id=event["event_id"]).json()["tickets"]}

        assert ids("denied") == {denied["ticket_id"]}
        assert ids("cancelled") == {cancelled["ticket_id"]}

    def test_cancellation_notice_still_reaches_the_holders(self, admin_headers, event):
        """The interaction that makes `cancelled` dangerous to add carelessly: cancelling
        moves every ticket off `issued` *before* the admin writes the notice, so a
        recipient query filtering on `issued` alone would announce the cancellation to
        nobody — the one message that most has to arrive."""
        _h, uid, _e = mint_user()
        _give_ticket(event["event_id"], uid)
        self._cancel(admin_headers, event["event_id"])

        r = requests.get(f"{API}/admin/events/{event['event_id']}/notice-preview",
                         headers=admin_headers, timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        assert r.json()["recipient_count"] == 1, "the cancellation notice would reach nobody"

    def test_counts_include_cancelled(self, admin_headers, event):
        _h, uid, _e = mint_user()
        _give_ticket(event["event_id"], uid)
        _give_ticket(event["event_id"], uid)
        self._cancel(admin_headers, event["event_id"])

        counts = _list(admin_headers, event_id=event["event_id"]).json()["counts"]
        assert counts["cancelled"] == 2
        assert counts["issued"] == 0


class TestTicketListing:
    def test_lists_denials_with_buyer_and_event(self, admin_headers, door_headers, event):
        _h, uid, email = mint_user()
        t = _give_ticket(event["event_id"], uid)
        _scan(door_headers, t["qr_code"])
        _deny(door_headers, t["qr_code"], "No ID")

        rows = _list(admin_headers, status="denied", event_id=event["event_id"]).json()["tickets"]
        mine = [r for r in rows if r["ticket_id"] == t["ticket_id"]]
        assert len(mine) == 1
        assert mine[0]["buyer"]["email"] == email
        assert mine[0]["event"]["title"] == event["title"]
        assert mine[0]["deny_reason"] == "No ID"

    def test_refunded_denial_appears_under_both_filters(self, admin_headers, door_headers, event):
        """A denial that has been refunded still happened. Filtering the denial history
        on the current status would hide exactly the rows you look for after settling up."""
        _h, uid, _e = mint_user()
        t = _give_ticket(event["event_id"], uid)
        _scan(door_headers, t["qr_code"])
        _deny(door_headers, t["qr_code"])
        requests.post(f"{API}/admin/tickets/{t['ticket_id']}/refund",
                      headers=admin_headers, timeout=TIMEOUT)

        for status in ("denied", "refunded"):
            rows = _list(admin_headers, status=status, event_id=event["event_id"]).json()["tickets"]
            ids = [r["ticket_id"] for r in rows]
            assert t["ticket_id"] in ids, f"missing from the {status} filter"

    def test_each_status_filter_returns_only_that_status(self, admin_headers, door_headers, event):
        _h, uid, _e = mint_user()
        issued = _give_ticket(event["event_id"], uid)
        used = _give_ticket(event["event_id"], uid)
        denied = _give_ticket(event["event_id"], uid)
        _scan(door_headers, used["qr_code"])
        _scan(door_headers, denied["qr_code"])
        _deny(door_headers, denied["qr_code"], "No ID")

        def ids(status):
            return {r["ticket_id"] for r in
                    _list(admin_headers, status=status, event_id=event["event_id"]).json()["tickets"]}

        assert ids("issued") == {issued["ticket_id"]}
        assert ids("used") == {used["ticket_id"]}
        assert ids("denied") == {denied["ticket_id"]}

    def test_unfiltered_returns_every_ticket_with_counts(self, admin_headers, door_headers, event):
        _h, uid, _e = mint_user()
        issued = _give_ticket(event["event_id"], uid)
        denied = _give_ticket(event["event_id"], uid)
        _scan(door_headers, denied["qr_code"])
        _deny(door_headers, denied["qr_code"])

        body = _list(admin_headers, event_id=event["event_id"]).json()
        assert {r["ticket_id"] for r in body["tickets"]} == {issued["ticket_id"], denied["ticket_id"]}
        assert body["counts"]["all"] == 2
        assert body["counts"]["issued"] == 1
        assert body["counts"]["denied"] == 1

    def test_counts_ignore_the_status_filter(self, admin_headers, door_headers, event):
        """Otherwise the tab labels collapse to whichever filter is already selected."""
        _h, uid, _e = mint_user()
        _give_ticket(event["event_id"], uid)
        d = _give_ticket(event["event_id"], uid)
        _scan(door_headers, d["qr_code"])
        _deny(door_headers, d["qr_code"])

        body = _list(admin_headers, status="denied", event_id=event["event_id"]).json()
        assert len(body["tickets"]) == 1
        assert body["counts"]["issued"] == 1, "counts narrowed to the active filter"
        assert body["counts"]["all"] == 2

    def test_unknown_status_is_rejected(self, admin_headers):
        r = _list(admin_headers, status="banana")
        assert r.status_code == 400
        assert "Unknown status" in r.text

    def test_non_admin_cannot_list(self, door_headers):
        assert _list(door_headers, status="denied").status_code == 403
