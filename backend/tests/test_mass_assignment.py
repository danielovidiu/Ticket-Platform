"""
Admin PATCH bodies are a fixed set of fields, not a free-form document (audit M6).

Both routes here used to take a bare `dict` and `$set` it wholesale. The obvious half of
that is skipped validation. The half that actually bites is that the *key names* belonged
to the caller: MongoDB reads a dotted key as a path, so `waves.0.available` was a write
straight into a nested subdocument — past the reconciliation that derives stock from what
has sold, and past anything that would have noticed.

These tests are written against the observable contract rather than the models, so they
would still catch a regression that reintroduced the hole by a different route.
"""
import uuid
from datetime import datetime, timezone, timedelta

import pytest
import requests

from support import API, TIMEOUT, db


# Runs on one worker, in order: the module's own xdist group. This is what
# `--dist loadgroup` needs in order to behave like the `loadscope` it replaced —
# see pytest.ini.
pytestmark = [pytest.mark.integration, pytest.mark.critical, pytest.mark.xdist_group("test_mass_assignment")]  # pins audit M6


def _iso(**delta):
    return (datetime.now(timezone.utc) + timedelta(**delta)).isoformat()


@pytest.fixture
def event(admin_headers):
    """A real event, created through the API so its wave carries a server-issued id."""
    body = {
        "title": f"TEST_massassign {uuid.uuid4().hex[:6]}",
        "slug": f"test-massassign-{uuid.uuid4().hex[:8]}",
        "description": "original description", "venue": "Club Pytest", "city": "Bucharest",
        "starts_at": _iso(days=7), "ends_at": _iso(days=7, hours=5),
        "doors_open_at": _iso(days=7, hours=-1),
        "image_url": "", "artist_ids": [], "max_tickets_per_user": 4,
        "is_published": True, "sold_out_message": "",
        "waves": [{"name": "GENERAL", "price_ron": 100.0, "capacity": 200,
                   "starts_at": _iso(days=-1), "ends_at": _iso(days=7), "tier": "general"}],
    }
    r = requests.post(f"{API}/admin/events", json=body, headers=admin_headers, timeout=TIMEOUT)
    assert r.status_code == 200, r.text
    e = r.json()
    yield e
    db.events.delete_many({"event_id": e["event_id"]})


@pytest.fixture
def artist(admin_headers):
    body = {"name": f"TEST_massassign {uuid.uuid4().hex[:6]}",
            "slug": f"test-massassign-{uuid.uuid4().hex[:8]}",
            "bio": "original bio", "image_url": "", "links": {"ig": "https://example.invalid"}}
    r = requests.post(f"{API}/admin/artists", json=body, headers=admin_headers, timeout=TIMEOUT)
    assert r.status_code == 200, r.text
    a = r.json()
    yield a
    db.artists.delete_many({"artist_id": a["artist_id"]})


def _patch(headers, event_id, body):
    return requests.patch(f"{API}/admin/events/{event_id}", json=body,
                          headers=headers, timeout=TIMEOUT)


def _stored(event_id):
    return db.events.find_one({"event_id": event_id}, {"_id": 0})


class TestEventPatchRejectsUnknownFields:

    def test_unknown_top_level_key_is_not_written(self, admin_headers, event):
        r = _patch(admin_headers, event["event_id"],
                   {"is_published": False, "commission_rate": 0, "internal_note": "x"})
        assert r.status_code == 200, r.text

        stored = _stored(event["event_id"])
        assert stored["is_published"] is False, "the declared field should still apply"
        assert "commission_rate" not in stored
        assert "internal_note" not in stored

    def test_dotted_path_cannot_reach_into_a_wave(self, admin_headers, event):
        """The one that mattered. `$set: {"waves.0.available": N}` is a nested write."""
        wave = event["waves"][0]
        before = wave["available"]

        r = _patch(admin_headers, event["event_id"], {"waves.0.available": 999999})
        assert r.status_code == 200, r.text

        stored = _stored(event["event_id"])
        assert stored["waves"][0]["available"] == before, "wave stock was rewritten"
        assert "waves.0.available" not in stored, "the key was written literally"

    def test_dotted_path_cannot_forge_a_wave_price(self, admin_headers, event):
        r = _patch(admin_headers, event["event_id"], {"waves.0.price_ron": 0})
        assert r.status_code == 200, r.text
        assert _stored(event["event_id"])["waves"][0]["price_ron"] == 100.0

    def test_identifiers_cannot_be_rewritten(self, admin_headers, event):
        r = _patch(admin_headers, event["event_id"],
                   {"event_id": "evt_hijacked", "created_at": "1970-01-01T00:00:00+00:00"})
        assert r.status_code == 200, r.text

        stored = _stored(event["event_id"])
        assert stored is not None, "the event lost its own id"
        assert stored["created_at"] == event["created_at"]

    def test_lifecycle_fields_are_not_the_clients_to_set(self, admin_headers, event):
        """`status`/`cancelled_at` are written by the cancel flow, not by an edit."""
        r = _patch(admin_headers, event["event_id"],
                   {"status": "cancelled", "cancelled_at": _iso()})
        assert r.status_code == 200, r.text

        stored = _stored(event["event_id"])
        assert stored.get("status") != "cancelled"
        assert "cancelled_at" not in stored


class TestEventPatchValidates:

    def test_wrong_type_is_refused(self, admin_headers, event):
        r = _patch(admin_headers, event["event_id"], {"max_tickets_per_user": "as many as I like"})
        assert r.status_code == 422, r.text
        assert _stored(event["event_id"])["max_tickets_per_user"] == 4

    def test_an_incomplete_wave_is_refused(self, admin_headers, event):
        """Used to be a 500 — the handler read `w["capacity"]` off whatever arrived."""
        r = _patch(admin_headers, event["event_id"], {"waves": [{"name": "MYSTERY"}]})
        assert r.status_code == 422, r.text
        assert _stored(event["event_id"])["waves"][0]["name"] == "GENERAL"

    def test_empty_body_is_a_no_op(self, admin_headers, event):
        before = _stored(event["event_id"])
        r = _patch(admin_headers, event["event_id"], {})
        assert r.status_code == 200, r.text
        assert _stored(event["event_id"]) == before

    def test_body_of_nothing_but_unknown_keys_is_a_no_op(self, admin_headers, event):
        """Every key drops out, leaving an empty `$set` — which Mongo rejects outright."""
        before = _stored(event["event_id"])
        r = _patch(admin_headers, event["event_id"], {"nope": 1, "also_nope": {"a": 2}})
        assert r.status_code == 200, r.text
        assert _stored(event["event_id"]) == before


class TestEventPatchIsStillAPatch:

    def test_omitted_fields_are_left_alone(self, admin_headers, event):
        """Without `exclude_unset` this request would blank the title and the venue."""
        r = _patch(admin_headers, event["event_id"], {"is_published": False})
        assert r.status_code == 200, r.text

        stored = _stored(event["event_id"])
        assert stored["title"] == event["title"]
        assert stored["venue"] == "Club Pytest"
        assert stored["description"] == "original description"
        assert stored["waves"][0]["wave_id"] == event["waves"][0]["wave_id"]

    def test_a_full_round_trip_still_saves(self, admin_headers, event):
        """What the admin UI actually sends: the whole document it was given back."""
        body = {**event, "venue": "Club Elsewhere"}
        body.pop("created_at", None)
        r = _patch(admin_headers, event["event_id"], body)
        assert r.status_code == 200, r.text

        stored = _stored(event["event_id"])
        assert stored["venue"] == "Club Elsewhere"
        assert stored["title"] == event["title"]
        assert stored["waves"][0]["wave_id"] == event["waves"][0]["wave_id"]

    def test_explicit_null_waves_leaves_the_lineup_alone(self, admin_headers, event):
        r = _patch(admin_headers, event["event_id"], {"waves": None})
        assert r.status_code == 200, r.text
        assert len(_stored(event["event_id"])["waves"]) == 1


class TestWaveStockStaysTheServersNumber:

    def test_client_supplied_available_is_ignored(self, admin_headers, event):
        """Sold stock is capacity minus what has gone, whatever the body claims."""
        wave = event["waves"][0]
        db.events.update_one({"event_id": event["event_id"], "waves.wave_id": wave["wave_id"]},
                             {"$set": {"waves.$.available": 150}})  # 50 sold of 200

        r = _patch(admin_headers, event["event_id"], {"waves": [
            {**wave, "available": 999999},
        ]})
        assert r.status_code == 200, r.text
        assert _stored(event["event_id"])["waves"][0]["available"] == 150

    def test_raising_capacity_adds_to_available(self, admin_headers, event):
        wave = event["waves"][0]
        db.events.update_one({"event_id": event["event_id"], "waves.wave_id": wave["wave_id"]},
                             {"$set": {"waves.$.available": 150}})  # 50 sold of 200

        r = _patch(admin_headers, event["event_id"], {"waves": [{**wave, "capacity": 300}]})
        assert r.status_code == 200, r.text

        stored_wave = _stored(event["event_id"])["waves"][0]
        assert stored_wave["capacity"] == 300
        assert stored_wave["available"] == 250, "300 capacity less the 50 already sold"

    def test_a_new_wave_gets_a_server_issued_id(self, admin_headers, event):
        r = _patch(admin_headers, event["event_id"], {"waves": [
            event["waves"][0],
            {"wave_id": "wave_i_chose_this", "name": "VIP", "price_ron": 300.0,
             "capacity": 20, "starts_at": _iso(days=-1), "ends_at": _iso(days=7),
             "tier": "vip", "available": 999},
        ]})
        assert r.status_code == 200, r.text

        vip = _stored(event["event_id"])["waves"][1]
        assert vip["wave_id"] != "wave_i_chose_this"
        assert vip["available"] == 20, "a new wave opens with exactly its capacity"

    def test_wave_defaults_survive_the_patch(self, admin_headers, event):
        """`tier` and `access_from` have model defaults; `exclude_unset` must not eat them."""
        wave = {k: v for k, v in event["waves"][0].items() if k not in ("tier", "access_from")}
        r = _patch(admin_headers, event["event_id"], {"waves": [wave]})
        assert r.status_code == 200, r.text

        stored_wave = _stored(event["event_id"])["waves"][0]
        assert stored_wave["tier"] == "general"
        assert stored_wave["access_from"] is None


class TestArtistPatch:
    """The other route M6 names — and the worse of the two: it did not even drop
    `artist_id`, so renaming the primary key was one request away."""

    def test_unknown_key_is_not_written(self, admin_headers, artist):
        r = requests.patch(f"{API}/admin/artists/{artist['artist_id']}",
                           json={"bio": "new bio", "is_admin": True},
                           headers=admin_headers, timeout=TIMEOUT)
        assert r.status_code == 200, r.text

        stored = db.artists.find_one({"artist_id": artist["artist_id"]}, {"_id": 0})
        assert stored["bio"] == "new bio"
        assert "is_admin" not in stored

    def test_artist_id_cannot_be_rewritten(self, admin_headers, artist):
        r = requests.patch(f"{API}/admin/artists/{artist['artist_id']}",
                           json={"artist_id": "art_hijacked"},
                           headers=admin_headers, timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        assert db.artists.find_one({"artist_id": artist["artist_id"]}) is not None

    def test_omitted_fields_are_left_alone(self, admin_headers, artist):
        r = requests.patch(f"{API}/admin/artists/{artist['artist_id']}",
                           json={"name": "TEST_massassign renamed"},
                           headers=admin_headers, timeout=TIMEOUT)
        assert r.status_code == 200, r.text

        stored = db.artists.find_one({"artist_id": artist["artist_id"]}, {"_id": 0})
        assert stored["bio"] == "original bio"
        assert stored["links"] == {"ig": "https://example.invalid"}
