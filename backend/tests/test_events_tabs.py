"""
The Events page's tab set, and the tri-state /events query behind it.

`upcoming` used to be a boolean defaulting to True, so there was no way to ask for the
whole programme — the page had to pick a half. It is three-valued now: omitted means
every published event. Every caller in the repo passes it explicitly, so nothing changed
shape underneath them, but a bare /events is a different answer than it was and that is
worth pinning.

The tab set is a CMS setting rather than a constant because /events is a React route with
no blocks to edit, so there is nowhere else it could be authored. Two invariants matter
more than the storage: the list can never be emptied, and the default can never point at
a tab that is not shown — either would render a page a visitor cannot navigate.
"""
import uuid

import pytest
import requests

from support import API, db, mint_user, TIMEOUT

pytestmark = pytest.mark.xdist_group("events_tabs")

_event_ids: list = []


@pytest.fixture(scope="module")
def editor():
    headers, _uid, _email = mint_user("editor")
    return headers


@pytest.fixture(scope="module", autouse=True)
def _cleanup():
    yield
    if _event_ids:
        db.events.delete_many({"event_id": {"$in": _event_ids}})
    db.site_settings.delete_one({"_id": "events"})


def _mk_event(*, past: bool, published: bool = True):
    event_id = f"evt_pytest_{uuid.uuid4().hex[:10]}"
    when = "2020-01-01T20:00:00+00:00" if past else "2035-01-01T20:00:00+00:00"
    db.events.insert_one({
        "event_id": event_id, "title": f"PYTEST {'PAST' if past else 'FUTURE'}",
        "slug": f"pytest-evt-{uuid.uuid4().hex[:8]}",
        "starts_at": when, "ends_at": when, "is_published": published,
        "artist_ids": [], "waves": [], "created_at": "2026-01-01T00:00:00+00:00",
    })
    _event_ids.append(event_id)
    return event_id


def _ids(params=""):
    r = requests.get(f"{API}/events{params}", timeout=TIMEOUT)
    assert r.status_code == 200, r.text
    return {e["event_id"] for e in r.json()}


class TestTheQueryIsTriState:
    def test_omitted_returns_past_and_future_together(self):
        past, future = _mk_event(past=True), _mk_event(past=False)
        got = _ids()
        assert {past, future} <= got

    def test_upcoming_true_excludes_the_past(self):
        past, future = _mk_event(past=True), _mk_event(past=False)
        got = _ids("?upcoming=true")
        assert future in got and past not in got

    def test_upcoming_false_excludes_the_future(self):
        past, future = _mk_event(past=True), _mk_event(past=False)
        got = _ids("?upcoming=false")
        assert past in got and future not in got

    def test_unpublished_events_stay_out_of_every_tab(self):
        """The tab decides which slice of the PUBLISHED programme, never whether a draft
        becomes visible."""
        draft = _mk_event(past=False, published=False)
        for params in ("", "?upcoming=true", "?upcoming=false"):
            assert draft not in _ids(params), f"draft leaked into {params or '(all)'}"


class TestTheTabSetIsASetting:
    def test_it_defaults_to_all_three_opening_on_all(self):
        db.site_settings.delete_one({"_id": "events"})
        r = requests.get(f"{API}/cms/events-settings", timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        assert r.json() == {"tabs": ["all", "upcoming", "past"], "default_tab": "all"}

    def test_the_public_endpoint_needs_no_auth(self):
        """The page reads it before it renders, for every visitor."""
        assert requests.get(f"{API}/cms/events-settings", timeout=TIMEOUT).status_code == 200

    def test_an_editor_can_change_it(self, editor):
        r = requests.put(f"{API}/admin/cms/events-settings",
                         json={"tabs": ["upcoming", "past"], "default_tab": "past"},
                         headers=editor, timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        assert r.json() == {"tabs": ["upcoming", "past"], "default_tab": "past"}
        assert requests.get(f"{API}/cms/events-settings", timeout=TIMEOUT).json()["default_tab"] == "past"

    def test_the_list_cannot_be_emptied(self, editor):
        r = requests.put(f"{API}/admin/cms/events-settings",
                         json={"tabs": [], "default_tab": "all"}, headers=editor, timeout=TIMEOUT)
        assert r.status_code == 400

    def test_unknown_tabs_are_dropped_not_stored(self, editor):
        r = requests.put(f"{API}/admin/cms/events-settings",
                         json={"tabs": ["all", "sideways", "past"], "default_tab": "all"},
                         headers=editor, timeout=TIMEOUT)
        assert r.json()["tabs"] == ["all", "past"]

    def test_a_default_outside_the_shown_tabs_is_pulled_back(self, editor):
        """Otherwise the page opens on a filter with no button to leave it by."""
        r = requests.put(f"{API}/admin/cms/events-settings",
                         json={"tabs": ["past"], "default_tab": "upcoming"},
                         headers=editor, timeout=TIMEOUT)
        assert r.json() == {"tabs": ["past"], "default_tab": "past"}

    def test_duplicates_collapse(self, editor):
        r = requests.put(f"{API}/admin/cms/events-settings",
                         json={"tabs": ["all", "all", "past"], "default_tab": "all"},
                         headers=editor, timeout=TIMEOUT)
        assert r.json()["tabs"] == ["all", "past"]

    def test_a_stored_value_that_went_bad_still_reads_safely(self, editor):
        """Written straight to the database, past the endpoint's validation — the read
        path has to hold the invariants on its own."""
        db.site_settings.update_one({"_id": "events"},
                                    {"$set": {"tabs": [], "default_tab": "nonsense"}}, upsert=True)
        got = requests.get(f"{API}/cms/events-settings", timeout=TIMEOUT).json()
        assert got["tabs"] and got["default_tab"] in got["tabs"]

    def test_it_needs_an_editor(self):
        r = requests.put(f"{API}/admin/cms/events-settings",
                         json={"tabs": ["all"], "default_tab": "all"}, timeout=TIMEOUT)
        assert r.status_code in (401, 403)
