"""
A tier's admission window, and the running order tiers are offered in.

Two changes to the event editor land here.

`tier_id` is what orders the tiers a buyer sees — lowest first. They used to come out in
whatever order they were added in, with no way to change it short of deleting and
re-adding. The sort happens on the way INTO the database so that the event page, the
admin form and the exports cannot disagree about the running order.

`access_from` is the other end of the window `access_until` already guarded, and it is
enforced at the door: a holder scanning before it is treated exactly as one scanning
after `access_until` — neither admitted nor refused, but handed to a person. The field
existed once before, was read by nothing, and was deleted for it; the tests here are
what stop that happening twice. Note in particular the migration that used to erase it
on every schema bump, retired in the same change.
"""
import uuid
from datetime import datetime, timezone, timedelta

import pytest
import requests

from support import API, TIMEOUT, db, mint_user

pytestmark = [pytest.mark.integration, pytest.mark.xdist_group("test_tier_access_window")]


def _iso(**delta):
    return (datetime.now(timezone.utc) + timedelta(**delta)).isoformat()


def _wave(name, tier_id=None, **extra):
    w = {"name": name, "price_ron": 50.0, "capacity": 10,
         "starts_at": _iso(days=-1), "ends_at": _iso(days=30)}
    if tier_id is not None:
        w["tier_id"] = tier_id
    w.update(extra)
    return w


@pytest.fixture
def make_event(admin_headers):
    """Events created through the real endpoint, so the ordering under test is the one
    the editor actually produces."""
    made = []

    def factory(waves, **overrides):
        body = {
            "title": f"TEST_tier_{uuid.uuid4().hex[:8]}",
            "slug": f"test-tier-{uuid.uuid4().hex[:10]}",
            "description": "", "venue": "Club Pytest", "city": "Bucharest",
            "starts_at": _iso(days=7), "ends_at": _iso(days=7, hours=4),
            "doors_open_at": _iso(days=7), "image_url": "", "artist_ids": [],
            "max_tickets_per_user": 4, "is_published": True, "sold_out_message": "",
            "waves": waves,
        }
        body.update(overrides)
        r = requests.post(f"{API}/admin/events", headers=admin_headers, json=body, timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        made.append(r.json()["event_id"])
        return r.json()

    yield factory
    for event_id in made:
        requests.delete(f"{API}/admin/events/{event_id}", headers=admin_headers, timeout=TIMEOUT)


class TestTheRunningOrder:
    def test_tiers_come_back_lowest_id_first(self, make_event):
        e = make_event([_wave("VIP", 3), _wave("EARLY", 1), _wave("GENERAL", 2)])
        assert [w["name"] for w in e["waves"]] == ["EARLY", "GENERAL", "VIP"]

    def test_the_buyer_sees_the_same_order(self, make_event):
        e = make_event([_wave("VIP", 3), _wave("EARLY", 1), _wave("GENERAL", 2)])
        r = requests.get(f"{API}/events/{e['slug']}", timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        assert [w["name"] for w in r.json()["waves"]] == ["EARLY", "GENERAL", "VIP"]

    def test_editing_the_id_moves_the_tier(self, admin_headers, make_event):
        e = make_event([_wave("EARLY", 1), _wave("GENERAL", 2)])
        waves = e["waves"]
        waves[0]["tier_id"] = 9  # send EARLY to the back
        r = requests.patch(f"{API}/admin/events/{e['event_id']}", headers=admin_headers,
                           json={"waves": waves}, timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        assert [w["name"] for w in r.json()["waves"]] == ["GENERAL", "EARLY"]

    def test_an_unnumbered_tier_sorts_last_not_first(self, make_event):
        # A tier nobody has placed should not push a placed one down the page.
        e = make_event([_wave("NO ID"), _wave("SECOND", 2), _wave("FIRST", 1)])
        assert [w["name"] for w in e["waves"]] == ["FIRST", "SECOND", "NO ID"]

    def test_ids_need_not_be_consecutive(self, make_event):
        # Editors leave gaps on purpose, to slot something in later.
        e = make_event([_wave("C", 100), _wave("A", 10), _wave("B", 50)])
        assert [w["name"] for w in e["waves"]] == ["A", "B", "C"]


class TestOnlyOneEndOfTheWindow:
    def test_both_ends_at_once_is_refused_and_the_tier_is_named(self, admin_headers):
        body = {
            "title": f"TEST_tier_{uuid.uuid4().hex[:8]}",
            "slug": f"test-tier-{uuid.uuid4().hex[:10]}",
            "description": "", "venue": "", "city": "",
            "starts_at": _iso(days=7), "ends_at": _iso(days=7, hours=4),
            "doors_open_at": _iso(days=7), "image_url": "", "artist_ids": [],
            "max_tickets_per_user": 4, "is_published": False, "sold_out_message": "",
            "waves": [_wave("BACKSTAGE", 1, access_until=_iso(hours=2), access_from=_iso(hours=1))],
        }
        r = requests.post(f"{API}/admin/events", headers=admin_headers, json=body, timeout=TIMEOUT)
        assert r.status_code == 400, r.text
        assert "BACKSTAGE" in r.json()["detail"]

    def test_either_end_alone_is_fine(self, make_event):
        e = make_event([_wave("UNTIL", 1, access_until=_iso(hours=2)),
                        _wave("FROM", 2, access_from=_iso(hours=1))])
        assert e["waves"][0]["access_until"] and not e["waves"][0].get("access_from")
        assert e["waves"][1]["access_from"] and not e["waves"][1].get("access_until")

    def test_neither_end_is_the_normal_case(self, make_event):
        e = make_event([_wave("PLAIN", 1)])
        assert e["waves"][0].get("access_until") is None
        assert e["waves"][0].get("access_from") is None


class TestTheDoorReadsBothEnds:
    """A scan outside the window is handed to a person, not decided by the software."""

    @pytest.fixture
    def door_headers(self):
        headers, _, _ = mint_user("door")
        return headers

    @pytest.fixture(autouse=True)
    def _cleanup(self):
        """These events are written straight to the database rather than through the API,
        so nothing else clears them: the suite's sweeper keys on the TEST_ title prefix
        that only the HTTP fixtures apply. Left alone they accumulate in the dev database
        and show up on the local site."""
        self._made = []
        yield
        for event_id in self._made:
            db.events.delete_many({"event_id": event_id})
            db.tickets.delete_many({"event_id": event_id})

    def _event_with_ticket(self, wave_extra):
        """An event running right now, one tier, one issued ticket in it."""
        event_id = f"evt_pytest_win_{uuid.uuid4().hex[:10]}"
        wave_id = f"wave_pytest_{uuid.uuid4().hex[:10]}"
        wave = {"wave_id": wave_id, "name": "GENERAL", "tier_id": 1, "price_ron": 50.0,
                "capacity": 10, "available": 9,
                "starts_at": _iso(days=-2), "ends_at": _iso(days=2), **wave_extra}
        db.events.insert_one({
            "event_id": event_id, "title": f"pytest window {uuid.uuid4().hex[:6]}",
            "slug": f"pytest-window-{uuid.uuid4().hex[:8]}", "description": "",
            "venue": "", "city": "", "starts_at": _iso(hours=-1), "ends_at": _iso(hours=4),
            "doors_open_at": _iso(hours=-2), "image_url": "", "artist_ids": [],
            "max_tickets_per_user": 4, "is_published": True, "sold_out_message": "",
            "waves": [wave], "created_at": _iso(),
        })
        _, user_id, _ = mint_user("user")
        qr = f"SNTY-PYTEST-{uuid.uuid4().hex[:12].upper()}"
        db.tickets.insert_one({
            "ticket_id": f"tkt_pytest_{uuid.uuid4().hex[:12]}", "qr_code": qr,
            "reservation_id": None, "user_id": user_id, "event_id": event_id,
            "wave_id": wave_id, "price_ron": 50.0, "status": "issued",
            "scanned_at": None, "scanned_by": None, "created_at": _iso(),
        })
        self._made.append(event_id)
        return event_id, qr

    def _scan(self, door_headers, qr, **extra):
        return requests.post(f"{API}/scan", headers=door_headers,
                             json={"qr_code": qr, **extra}, timeout=TIMEOUT)

    def test_arriving_after_access_until_asks_rather_than_refusing(self, door_headers):
        _, qr = self._event_with_ticket({"access_until": _iso(hours=-1)})
        d = self._scan(door_headers, qr).json()
        assert d["valid"] is False
        assert d["needs_override"] is True
        assert d["reason"] == "ACCESS EXPIRED"
        assert d["edge"] == "late", "the door has to know which end was crossed"

    def test_arriving_before_access_from_asks_the_same_way(self, door_headers):
        # The whole point of bringing the field back: it is enforced now.
        _, qr = self._event_with_ticket({"access_from": _iso(hours=1)})
        d = self._scan(door_headers, qr).json()
        assert d["valid"] is False
        assert d["needs_override"] is True
        assert d["reason"] == "ACCESS NOT YET OPEN"
        assert d["edge"] == "early"
        assert d["access_from"], "the screen has to be able to say what time it opens"

    def test_inside_the_window_simply_admits(self, door_headers):
        _, qr = self._event_with_ticket({"access_from": _iso(hours=-1)})
        d = self._scan(door_headers, qr).json()
        assert d["valid"] is True, d

    def test_no_window_at_all_simply_admits(self, door_headers):
        _, qr = self._event_with_ticket({})
        assert self._scan(door_headers, qr).json()["valid"] is True

    def test_the_door_can_admit_an_early_arrival_anyway(self, door_headers):
        # Same override the late case has always had — the guest is standing there.
        _, qr = self._event_with_ticket({"access_from": _iso(hours=1)})
        d = self._scan(door_headers, qr, override=True).json()
        assert d["valid"] is True
        assert d["overridden"] is True
        t = db.tickets.find_one({"qr_code": qr})
        assert t["status"] == "used"
        assert t.get("override_by"), "who decided has to be recorded on the ticket"
