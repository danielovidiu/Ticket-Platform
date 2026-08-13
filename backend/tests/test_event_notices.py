"""
Event change notices — POST /api/admin/events/{id}/notify.

The whole point of this feature is *targeting*: a venue change must reach the people
holding tickets and nobody else. So most of what is asserted here is about the audience —
who gets it, who doesn't, and how many copies — rather than about the wording.

Mail is read back out of `db.outbox`, the dev-fallback collection `mailer.send_mail`
writes to when RESEND_API_KEY is unset. That is the same path the ticket-delivery and
verification tests use.
"""
import uuid
from datetime import datetime, timezone, timedelta

import pytest
import requests

import support
from support import API, TIMEOUT, db, mint_user


pytestmark = pytest.mark.integration


# --- fixtures ----------------------------------------------------------------------

def _make_event(**overrides) -> dict:
    """An event row written straight to the database.

    Direct insert rather than POST /admin/events: these tests are about who receives a
    notice, and going through the API would drag wave/capacity validation into a test
    that has nothing to say about it.
    """
    event_id = f"evt_pytest_{uuid.uuid4().hex[:12]}"
    doc = {
        "event_id": event_id,
        "title": f"pytest event {uuid.uuid4().hex[:6]}",
        "slug": f"pytest-{uuid.uuid4().hex[:8]}",
        "description": "", "venue": "Club Pytest", "city": "Bucharest",
        "starts_at": (datetime.now(timezone.utc) + timedelta(days=30)).isoformat(),
        "ends_at": None, "doors_open_at": None,
        "image_url": "", "artist_ids": [], "max_tickets_per_user": 4,
        "is_published": True, "sold_out_message": "", "waves": [],
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    doc.update(overrides)
    db.events.insert_one(dict(doc))
    return doc


def _give_ticket(event_id: str, user_id: str, status: str = "issued") -> str:
    ticket_id = f"tkt_pytest_{uuid.uuid4().hex[:12]}"
    db.tickets.insert_one({
        "ticket_id": ticket_id,
        "qr_code": f"SNTY-PYTEST-{uuid.uuid4().hex[:12].upper()}",
        "reservation_id": None, "user_id": user_id, "event_id": event_id,
        "wave_id": None, "price_ron": 100.0, "status": status,
        "scanned_at": None, "scanned_by": None,
        "created_at": datetime.now(timezone.utc).isoformat(),
    })
    return ticket_id


@pytest.fixture
def event():
    """A throwaway event, removed with its tickets and notices afterwards."""
    e = _make_event()
    yield e
    db.events.delete_one({"event_id": e["event_id"]})
    db.tickets.delete_many({"event_id": e["event_id"]})
    db.event_notices.delete_many({"event_id": e["event_id"]})


def _notices_for(email: str) -> list:
    return list(db.outbox.find({"to": email, "kind": "event_notice"}))


def _notify(headers, event_id, kind="venue", message="We moved to a new room."):
    """The notify endpoint is capped per admin per hour. Each pytest session mints its
    own admin, so the budget starts fresh — but treat a spent one as "didn't run"
    rather than a failure, the way the rest of the suite does."""
    r = requests.post(f"{API}/admin/events/{event_id}/notify",
                      json={"kind": kind, "message": message},
                      headers=headers, timeout=TIMEOUT)
    return support.skip_if_rate_limited(r, "event notify")


# --- targeting ---------------------------------------------------------------------

class TestAudience:
    def test_reaches_issued_holders_only(self, admin_headers, event):
        """The core guarantee: a holder gets it, a refunded buyer does not, and someone
        with a ticket to a *different* event is untouched."""
        _holder, holder_id, holder_email = mint_user()
        _refunded, refunded_id, refunded_email = mint_user()
        _other, other_id, other_email = mint_user()
        other_event = _make_event()

        _give_ticket(event["event_id"], holder_id, "issued")
        _give_ticket(event["event_id"], refunded_id, "refunded")
        _give_ticket(other_event["event_id"], other_id, "issued")

        try:
            r = _notify(admin_headers, event["event_id"])
            assert r.status_code == 200, r.text
            assert r.json()["recipient_count"] == 1

            assert len(_notices_for(holder_email)) == 1
            assert _notices_for(refunded_email) == []
            assert _notices_for(other_email) == []
        finally:
            db.events.delete_one({"event_id": other_event["event_id"]})
            db.tickets.delete_many({"event_id": other_event["event_id"]})

    def test_one_email_per_buyer_not_per_ticket(self, admin_headers, event):
        """Buying four tickets is one purchase, not four people to notify."""
        _h, holder_id, holder_email = mint_user()
        for _ in range(4):
            _give_ticket(event["event_id"], holder_id, "issued")

        r = _notify(admin_headers, event["event_id"])
        assert r.status_code == 200
        assert r.json()["recipient_count"] == 1
        assert len(_notices_for(holder_email)) == 1

    def test_no_holders_sends_nothing(self, admin_headers, event):
        r = _notify(admin_headers, event["event_id"])
        assert r.status_code == 200
        assert r.json()["recipient_count"] == 0
        assert r.json()["sent"] == 0

    def test_preview_counts_without_sending(self, admin_headers, event):
        _h, holder_id, holder_email = mint_user()
        _give_ticket(event["event_id"], holder_id, "issued")

        r = requests.get(f"{API}/admin/events/{event['event_id']}/notice-preview",
                         headers=admin_headers, timeout=TIMEOUT)
        assert r.status_code == 200
        assert r.json()["recipient_count"] == 1
        assert _notices_for(holder_email) == []   # a preview must not mail anyone


# --- content -----------------------------------------------------------------------

class TestContent:
    def test_carries_event_facts_and_message(self, admin_headers):
        e = _make_event(venue="Guesthouse", city="Bucharest")
        _h, holder_id, holder_email = mint_user()
        _give_ticket(e["event_id"], holder_id, "issued")
        try:
            assert _notify(admin_headers, e["event_id"],
                           message="Room change, same night.").status_code == 200
            msg = _notices_for(holder_email)[0]
            assert e["title"] in msg["subject"]
            assert "Room change, same night." in msg["html"]
            assert "Guesthouse" in msg["html"]    # derived from the event, not typed
        finally:
            db.events.delete_one({"event_id": e["event_id"]})
            db.tickets.delete_many({"event_id": e["event_id"]})
            db.event_notices.delete_many({"event_id": e["event_id"]})

    def test_kind_drives_the_subject(self, admin_headers, event):
        _h, holder_id, holder_email = mint_user()
        _give_ticket(event["event_id"], holder_id, "issued")

        assert _notify(admin_headers, event["event_id"], kind="cancelled",
                       message="The show is off.").status_code == 200
        assert "Cancelled" in _notices_for(holder_email)[0]["subject"]

    def test_message_is_escaped_not_injected(self, admin_headers, event):
        """The message is admin-typed free text landing in an HTML email."""
        _h, holder_id, holder_email = mint_user()
        _give_ticket(event["event_id"], holder_id, "issued")

        assert _notify(admin_headers, event["event_id"],
                       message="<script>alert(1)</script> Doors & gates").status_code == 200
        html = _notices_for(holder_email)[0]["html"]
        assert "<script>" not in html
        assert "&lt;script&gt;" in html
        assert "&amp;" in html


# --- access & validation -----------------------------------------------------------

class TestGuards:
    def test_non_admin_cannot_send(self, user_headers, event):
        _h, holder_id, holder_email = mint_user()
        _give_ticket(event["event_id"], holder_id, "issued")

        assert _notify(user_headers, event["event_id"]).status_code == 403
        assert _notices_for(holder_email) == []

    def test_anonymous_cannot_send(self, event):
        r = requests.post(f"{API}/admin/events/{event['event_id']}/notify",
                          json={"kind": "venue", "message": "hi"}, timeout=TIMEOUT)
        assert r.status_code in (401, 403)

    def test_empty_message_rejected(self, admin_headers, event):
        assert _notify(admin_headers, event["event_id"], message="").status_code == 422

    def test_unknown_kind_rejected(self, admin_headers, event):
        assert _notify(admin_headers, event["event_id"], kind="price").status_code == 422

    def test_unknown_event_is_404(self, admin_headers):
        assert _notify(admin_headers, "evt_does_not_exist").status_code == 404


# --- record ------------------------------------------------------------------------

class TestHistory:
    def test_send_is_recorded_and_listable(self, admin_headers, event):
        _h, holder_id, _email = mint_user()
        _give_ticket(event["event_id"], holder_id, "issued")

        assert _notify(admin_headers, event["event_id"], kind="time",
                       message="Doors an hour earlier.").status_code == 200

        r = requests.get(f"{API}/admin/events/{event['event_id']}/notices",
                         headers=admin_headers, timeout=TIMEOUT)
        assert r.status_code == 200
        rows = r.json()
        assert len(rows) == 1
        assert rows[0]["kind"] == "time"
        assert rows[0]["message"] == "Doors an hour earlier."
        assert rows[0]["recipient_count"] == 1
