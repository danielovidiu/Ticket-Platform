"""
The artist record's second half: a managed discipline vocabulary, hand-picked galleries,
and an outside project link.

Covers:
  * The discipline vocabulary is a setting, not a constant — it is read per request, and
    replacing it drops blanks and duplicates while keeping the admin's order.
  * Retiring a discipline does NOT reach into the artists already carrying it. A settings
    edit that silently rewrites content is the failure mode this is guarding against.
  * The new artist fields survive create and patch, and the patch boundary still refuses
    what it always refused (unknown keys, a renamed primary key).
  * `other_project_url` has to be a real outside link. It ends up in an href.
  * The roster sorts case-insensitively. Mongo's default collation files every lowercase
    name after every uppercase one, which looks correct on an all-caps roster right up
    until somebody types "dj rosa".
  * An artist's hand-picked albums are intersected with the SAME visibility rule the
    Gallery page runs on, so linking a draft event's album does not publish it.
"""
import uuid

import pytest
import requests

from support import API, db, mint_user, TIMEOUT

pytestmark = pytest.mark.xdist_group("artists")

_artist_ids: list = []
_event_ids: list = []
_album_ids: list = []


@pytest.fixture(scope="module")
def admin():
    headers, _uid, _email = mint_user("admin")
    return headers


@pytest.fixture(scope="module", autouse=True)
def _cleanup():
    yield
    if _artist_ids:
        db.artists.delete_many({"artist_id": {"$in": _artist_ids}})
    if _event_ids:
        db.events.delete_many({"event_id": {"$in": _event_ids}})
    if _album_ids:
        db.albums.delete_many({"album_id": {"$in": _album_ids}})
        db.gallery.delete_many({"album_id": {"$in": _album_ids}})
    # The vocabulary is a singleton; put it back to the built-in default.
    db.site_settings.delete_one({"_id": "artists"})


def _mk_artist(admin, **fields):
    body = {"name": f"PYTEST {uuid.uuid4().hex[:6].upper()}",
            "slug": f"pytest-{uuid.uuid4().hex[:8]}"}
    body.update(fields)
    r = requests.post(f"{API}/admin/artists", json=body, headers=admin, timeout=TIMEOUT)
    assert r.status_code == 200, r.text
    a = r.json()
    _artist_ids.append(a["artist_id"])
    return a


def _mk_album(*, event_id=None, with_item=True):
    """Straight into the database: the subject here is artist visibility, not the album
    endpoints, which test_account_and_gallery already covers."""
    album_id = f"alb_pytest_{uuid.uuid4().hex[:10]}"
    db.albums.insert_one({
        "album_id": album_id, "title": "PYTEST ALBUM",
        "slug": f"pytest-album-{uuid.uuid4().hex[:8]}",
        "event_id": event_id, "sort_order": 0, "created_at": "2026-01-01T00:00:00+00:00",
    })
    _album_ids.append(album_id)
    if with_item:
        db.gallery.insert_one({
            "gallery_id": f"gal_pytest_{uuid.uuid4().hex[:10]}", "album_id": album_id,
            "image_url": "https://example.com/x.jpg",
            "thumbnail_url": "https://example.com/x.jpg",
            "media_type": "image", "sort_order": 0,
            "created_at": "2026-01-01T00:00:00+00:00",
        })
    return album_id


def _mk_event(*, published):
    event_id = f"evt_pytest_{uuid.uuid4().hex[:10]}"
    db.events.insert_one({
        "event_id": event_id, "title": "PYTEST EVENT",
        "slug": f"pytest-evt-{uuid.uuid4().hex[:8]}",
        "starts_at": "2030-01-01T20:00:00+00:00", "is_published": published,
        "artist_ids": [], "waves": [], "created_at": "2026-01-01T00:00:00+00:00",
    })
    _event_ids.append(event_id)
    return event_id


# --- the vocabulary is a setting ------------------------------------------------------

class TestDisciplineVocabulary:
    def test_it_starts_from_the_built_in_list(self, admin):
        db.site_settings.delete_one({"_id": "artists"})
        r = requests.get(f"{API}/admin/artists/disciplines", headers=admin, timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        assert "DJ" in r.json()["disciplines"]

    def test_replacing_it_sorts_and_drops_blanks_and_duplicates(self, admin):
        """A-Z, not the order they were typed. This is a list to FIND a discipline in and
        it is read in three places — the manager, the artist form and the artist page —
        so an order that depends on the sequence someone added them in is an order none
        of the three can explain.

        The previous fixture here was ["Aerial", "DJ"], which is alphabetical by accident:
        it went on passing after the behaviour changed while claiming to pin the opposite.
        """
        r = requests.put(f"{API}/admin/artists/disciplines",
                         json={"disciplines": ["Trapeze", "  ", "aerial", "DJ", "Trapeze", ""]},
                         headers=admin, timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        assert r.json()["disciplines"] == ["aerial", "DJ", "Trapeze"]

    def test_a_list_stored_out_of_order_still_reads_back_sorted(self, admin):
        """Sorted on read as well as write, so a value that predates the rule — or was
        edited into the database directly — is not the one unordered list."""
        db.site_settings.update_one({"_id": "artists"},
                                    {"$set": {"disciplines": ["Zebra", "Alpha", "Mid"]}},
                                    upsert=True)
        r = requests.get(f"{API}/admin/artists/disciplines", headers=admin, timeout=TIMEOUT)
        assert r.json()["disciplines"] == ["Alpha", "Mid", "Zebra"]

    def test_the_built_in_default_is_sorted_too(self, admin):
        db.site_settings.delete_one({"_id": "artists"})
        got = requests.get(f"{API}/admin/artists/disciplines", headers=admin,
                           timeout=TIMEOUT).json()["disciplines"]
        assert got == sorted(got, key=lambda v: (v.casefold(), v))

    def test_it_is_read_per_request_not_cached_at_import(self, admin):
        requests.put(f"{API}/admin/artists/disciplines",
                     json={"disciplines": ["Only One"]}, headers=admin, timeout=TIMEOUT)
        r = requests.get(f"{API}/admin/artists/disciplines", headers=admin, timeout=TIMEOUT)
        assert r.json()["disciplines"] == ["Only One"]

    def test_retiring_a_discipline_leaves_artists_who_had_it_alone(self, admin):
        """The whole reason disciplines are stored as strings and not ids."""
        requests.put(f"{API}/admin/artists/disciplines",
                     json={"disciplines": ["Trapeze", "DJ"]}, headers=admin, timeout=TIMEOUT)
        a = _mk_artist(admin, disciplines=["Trapeze"])

        requests.put(f"{API}/admin/artists/disciplines",
                     json={"disciplines": ["DJ"]}, headers=admin, timeout=TIMEOUT)

        again = requests.get(f"{API}/artists/{a['slug']}", timeout=TIMEOUT).json()
        assert again["disciplines"] == ["Trapeze"]

    def test_it_needs_admin(self):
        r = requests.get(f"{API}/admin/artists/disciplines", timeout=TIMEOUT)
        assert r.status_code in (401, 403)


# --- the new fields -------------------------------------------------------------------

class TestArtistFields:
    def test_they_round_trip_through_create(self, admin):
        a = _mk_artist(admin, disciplines=["DJ", "Producer"],
                       other_project_name="Side Thing",
                       other_project_url="https://example.com/side")
        assert a["disciplines"] == ["DJ", "Producer"]
        assert a["other_project_name"] == "Side Thing"

    def test_disciplines_are_stored_a_to_z_whatever_order_they_were_clicked(self, admin):
        """The multiselect appends in click order, which is nobody's idea of an order by
        the time it reaches the artist's page. Canonicalised on write so every reader
        gets the same list without each one having to sort it."""
        a = _mk_artist(admin, disciplines=["Vocalist", "DJ", "Producer"])
        assert a["disciplines"] == ["DJ", "Producer", "Vocalist"]
        public = requests.get(f"{API}/artists/{a['slug']}", timeout=TIMEOUT).json()
        assert public["disciplines"] == ["DJ", "Producer", "Vocalist"]

    def test_patching_them_sorts_too(self, admin):
        a = _mk_artist(admin)
        r = requests.patch(f"{API}/admin/artists/{a['artist_id']}",
                           json={"disciplines": ["Vocalist", "Curator"]},
                           headers=admin, timeout=TIMEOUT)
        assert r.json()["disciplines"] == ["Curator", "Vocalist"]

    def test_they_round_trip_through_patch(self, admin):
        a = _mk_artist(admin)
        r = requests.patch(f"{API}/admin/artists/{a['artist_id']}",
                           json={"disciplines": ["Dancer"]}, headers=admin, timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        assert r.json()["disciplines"] == ["Dancer"]

    def test_an_outside_link_has_to_be_one(self, admin):
        for bad in ("javascript:alert(1)", "//evil.example.com", "/uploads/local.png"):
            r = requests.post(f"{API}/admin/artists",
                              json={"name": "X", "slug": f"x-{uuid.uuid4().hex[:8]}",
                                    "other_project_url": bad},
                              headers=admin, timeout=TIMEOUT)
            assert r.status_code == 400, f"{bad} was accepted: {r.text}"

    def test_the_patch_boundary_still_drops_what_it_always_dropped(self, admin):
        a = _mk_artist(admin)
        r = requests.patch(f"{API}/admin/artists/{a['artist_id']}",
                           json={"artist_id": "art_hijacked", "role": "admin"},
                           headers=admin, timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        assert r.json()["artist_id"] == a["artist_id"]
        assert "role" not in r.json()


# --- the roster -----------------------------------------------------------------------

class TestRosterOrder:
    def test_it_is_alphabetical_ignoring_case(self, admin):
        marker = uuid.uuid4().hex[:6]
        for name in (f"zz {marker} lower", f"AA {marker} UPPER", f"mm {marker} Mixed"):
            _mk_artist(admin, name=name)
        names = [a["name"] for a in requests.get(f"{API}/artists", timeout=TIMEOUT).json()
                 if marker in a.get("name", "")]
        assert names == sorted(names, key=str.casefold)
        # The property that a bytewise sort would break.
        assert names[0].startswith("AA")


# --- galleries ------------------------------------------------------------------------

class TestPickedGalleries:
    def test_a_linked_album_shows_on_the_artist(self, admin):
        album_id = _mk_album(event_id=_mk_event(published=True))
        a = _mk_artist(admin, album_ids=[album_id])
        got = requests.get(f"{API}/artists/{a['slug']}", timeout=TIMEOUT).json()
        assert [al["album_id"] for al in got["albums"]] == [album_id]

    def test_a_draft_events_album_is_not_published_by_linking_it(self, admin):
        """An admin can link anything. This page must not become how a draft leaks."""
        album_id = _mk_album(event_id=_mk_event(published=False))
        a = _mk_artist(admin, album_ids=[album_id])
        got = requests.get(f"{API}/artists/{a['slug']}", timeout=TIMEOUT).json()
        assert got["albums"] == []

    def test_an_empty_album_has_no_tile(self, admin):
        album_id = _mk_album(event_id=None, with_item=False)
        a = _mk_artist(admin, album_ids=[album_id])
        got = requests.get(f"{API}/artists/{a['slug']}", timeout=TIMEOUT).json()
        assert got["albums"] == []


class TestCollab:
    """Resident or guest, and nothing else.

    The roster's tabs are built straight from this vocabulary, so a third value would put
    an artist in a group with no tab to reach them — on the site, absent from both halves
    of the filter, with nothing to say why. The server is where that is settled rather
    than the dropdown, which is one client's opinion.
    """

    def test_an_artist_is_a_resident_unless_told_otherwise(self, admin):
        # Which is also what the migration wrote onto every artist that predates the
        # field: these are the people the collective already had.
        assert _mk_artist(admin)["collab"] == "resident"

    def test_a_guest_round_trips(self, admin):
        assert _mk_artist(admin, collab="guest")["collab"] == "guest"

    def test_it_can_be_changed_after_the_fact(self, admin):
        a = _mk_artist(admin)
        r = requests.patch(f"{API}/admin/artists/{a['artist_id']}", headers=admin,
                           json={"collab": "guest"}, timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        assert r.json()["collab"] == "guest"

    @pytest.mark.parametrize("bad", ["Resident", "RESIDENT", "collaborator", "", "friend"])
    def test_anything_outside_the_two_is_refused(self, admin, bad):
        r = requests.post(f"{API}/admin/artists", headers=admin, timeout=TIMEOUT,
                          json={"name": f"PYTEST {uuid.uuid4().hex[:6]}",
                                "slug": f"pytest-{uuid.uuid4().hex[:8]}", "collab": bad})
        assert r.status_code == 400, f"{bad!r} was accepted: {r.text}"

    def test_the_public_roster_carries_it_so_the_page_can_filter(self, admin):
        # The tabs filter a list the page already has rather than refetching per click,
        # which only works if the value travels with the artist.
        a = _mk_artist(admin, collab="guest")
        roster = requests.get(f"{API}/artists", timeout=TIMEOUT).json()
        mine = next(x for x in roster if x["artist_id"] == a["artist_id"])
        assert mine["collab"] == "guest"
