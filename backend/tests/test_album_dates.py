"""
The date an album is filed under, and the order it puts the Gallery grid in.

Albums used to sit in a hand-written `sort_order` that only the creation sequence ever
set — there was a reorder endpoint, but nothing in the CMS called it, so the grid was
frozen in the order albums happened to be made in and no editor could change it. They
carry a date now and the grid runs newest first.

Two things here are easy to get wrong and expensive to notice:

  * The fallback. An album with no date takes the day it was created, so a dateless one
    keeps a sensible place instead of collapsing into a tie at the end of the grid with
    every other dateless one.
  * Absent vs null on PATCH. Leaving the key out means "don't touch the date"; sending
    null means "clear it". A plain `is not None` check cannot tell those apart, and the
    difference is whether editing an album's title silently wipes its date.
"""
import uuid
from datetime import date, timedelta

import pytest
import requests

from support import API, TIMEOUT

pytestmark = pytest.mark.xdist_group("album_dates")

TODAY = date.today()


def _make(admin_headers, **fields):
    body = {"title": f"TEST_album_{uuid.uuid4().hex[:8]}", **fields}
    r = requests.post(f"{API}/admin/albums", headers=admin_headers, json=body, timeout=TIMEOUT)
    assert r.status_code == 200, r.text
    return r.json()


def _drop(admin_headers, album_id):
    requests.delete(f"{API}/admin/albums/{album_id}?delete_items=true",
                    headers=admin_headers, timeout=TIMEOUT)


@pytest.fixture
def album_factory(admin_headers):
    """Albums that clean themselves up, so ordering can be asserted on a known set."""
    made = []

    def factory(**fields):
        a = _make(admin_headers, **fields)
        made.append(a["album_id"])
        return a

    yield factory
    for album_id in made:
        _drop(admin_headers, album_id)


class TestTheDateField:
    def test_a_date_round_trips_through_create(self, album_factory):
        a = album_factory(date="2026-08-15")
        assert a["date"] == "2026-08-15"

    def test_an_album_may_have_no_date(self, album_factory):
        assert album_factory()["date"] is None

    def test_a_patch_sets_it(self, admin_headers, album_factory):
        a = album_factory()
        r = requests.patch(f"{API}/admin/albums/{a['album_id']}", headers=admin_headers,
                           json={"date": "2025-03-02"}, timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        assert r.json()["date"] == "2025-03-02"

    def test_null_clears_it(self, admin_headers, album_factory):
        a = album_factory(date="2026-08-15")
        r = requests.patch(f"{API}/admin/albums/{a['album_id']}", headers=admin_headers,
                           json={"date": None}, timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        assert r.json()["date"] is None

    def test_editing_the_title_leaves_the_date_alone(self, admin_headers, album_factory):
        # The absent-vs-null distinction, from the side that bites: the CMS sends only
        # the fields it is changing, and a date wiped by a title edit is a silent
        # reordering of the whole grid.
        a = album_factory(date="2026-08-15")
        r = requests.patch(f"{API}/admin/albums/{a['album_id']}", headers=admin_headers,
                           json={"title": "TEST_album_renamed"}, timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        assert r.json()["date"] == "2026-08-15"


class TestWhatIsNotADate:
    @pytest.mark.parametrize("value", [
        "15-08-2026",   # the other way round
        "2026-8-1",     # unpadded
        "2026-08",      # a month, not a day
        "15 August 2026",
        "2026-08-15T20:00:00Z",  # an instant; an album is filed under a day
        "tomorrow",
    ])
    def test_a_malformed_date_is_refused(self, admin_headers, value):
        r = requests.post(f"{API}/admin/albums", headers=admin_headers, timeout=TIMEOUT,
                          json={"title": f"TEST_album_{uuid.uuid4().hex[:8]}", "date": value})
        assert r.status_code == 400, f"{value!r} was accepted: {r.text}"

    def test_a_day_that_does_not_exist_is_refused(self, admin_headers):
        # Matches the pattern and is not a date. Caught by parsing it, not by the regex.
        r = requests.post(f"{API}/admin/albums", headers=admin_headers, timeout=TIMEOUT,
                          json={"title": f"TEST_album_{uuid.uuid4().hex[:8]}", "date": "2026-02-31"})
        assert r.status_code == 400, r.text

    def test_blank_means_no_date_rather_than_an_error(self, album_factory):
        assert album_factory(date="")["date"] is None


class TestTheOrderTheGridRunsIn:
    def _positions(self, admin_headers, ids):
        r = requests.get(f"{API}/admin/albums", headers=admin_headers, timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        listed = [a["album_id"] for a in r.json()]
        return [listed.index(i) for i in ids]

    def test_newest_first(self, admin_headers, album_factory):
        old = album_factory(date="2020-01-09")
        mid = album_factory(date="2023-03-02")
        new = album_factory(date="2026-08-15")
        pos = self._positions(admin_headers, [new["album_id"], mid["album_id"], old["album_id"]])
        assert pos == sorted(pos), "albums should read newest date first"

    def test_a_dateless_album_falls_back_to_the_day_it_was_made(self, admin_headers, album_factory):
        # Created just now, so its fallback is today: it belongs above an album dated
        # last year and below one dated next year. Sorting on `date` alone would drop it
        # under both.
        past = album_factory(date=str(TODAY - timedelta(days=400)))
        undated = album_factory()
        future = album_factory(date=str(TODAY + timedelta(days=400)))
        pos = self._positions(admin_headers,
                              [future["album_id"], undated["album_id"], past["album_id"]])
        assert pos == sorted(pos), "a dateless album should sit at its creation day, not last"


class TestTheReorderEndpointIsGone:
    def test_manual_album_ordering_no_longer_exists(self, admin_headers):
        """Date ordering replaced it. It is removed rather than left in place, because a
        route that writes a sort_order nothing reads answers 200 to a caller whose
        reorder then silently does nothing."""
        r = requests.patch(f"{API}/admin/albums/reorder", headers=admin_headers,
                           json={"ordered_ids": []}, timeout=TIMEOUT)
        assert r.status_code in (404, 405, 422), r.text
