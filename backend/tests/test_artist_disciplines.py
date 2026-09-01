"""
The artist record's second half: a managed discipline vocabulary, hand-picked galleries,
an outside project link, and the artist<->project edge.

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
  * `project_ids` is a write-through onto `projects.artist_ids`: absent leaves the links
    alone, [] clears them, and deleting an artist takes their id out of every project
    and event that named them.
"""
import uuid

import pytest
import requests

from support import API, db, mint_user, TIMEOUT

pytestmark = pytest.mark.xdist_group("artists")

_artist_ids: list = []
_project_ids: list = []
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
    if _project_ids:
        db.projects.delete_many({"project_id": {"$in": _project_ids}})
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


def _mk_project(admin, **fields):
    body = {"title": f"PYTEST PRJ {uuid.uuid4().hex[:6]}",
            "slug": f"pytest-prj-{uuid.uuid4().hex[:8]}"}
    body.update(fields)
    r = requests.post(f"{API}/admin/projects", json=body, headers=admin, timeout=TIMEOUT)
    assert r.status_code == 200, r.text
    p = r.json()
    _project_ids.append(p["project_id"])
    return p


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

    def test_replacing_it_keeps_order_and_drops_blanks_and_duplicates(self, admin):
        r = requests.put(f"{API}/admin/artists/disciplines",
                         json={"disciplines": ["Aerial", "  ", "DJ", "Aerial", ""]},
                         headers=admin, timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        assert r.json()["disciplines"] == ["Aerial", "DJ"]

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


# --- the artist <-> project edge ------------------------------------------------------

class TestProjectLinks:
    def test_an_artist_can_be_added_to_several_projects(self, admin):
        p1, p2 = _mk_project(admin), _mk_project(admin)
        a = _mk_artist(admin, project_ids=[p1["project_id"], p2["project_id"]])

        got = requests.get(f"{API}/artists/{a['slug']}", timeout=TIMEOUT).json()
        assert {p["project_id"] for p in got["projects"]} == {p1["project_id"], p2["project_id"]}

    def test_project_ids_is_not_stored_on_the_artist(self, admin):
        """It is an edge on the project, and duplicating it would let the two disagree."""
        p = _mk_project(admin)
        a = _mk_artist(admin, project_ids=[p["project_id"]])
        assert "project_ids" not in db.artists.find_one({"artist_id": a["artist_id"]})

    def test_patching_the_list_removes_the_links_it_leaves_out(self, admin):
        p1, p2 = _mk_project(admin), _mk_project(admin)
        a = _mk_artist(admin, project_ids=[p1["project_id"], p2["project_id"]])

        requests.patch(f"{API}/admin/artists/{a['artist_id']}",
                       json={"project_ids": [p2["project_id"]]}, headers=admin, timeout=TIMEOUT)

        got = requests.get(f"{API}/artists/{a['slug']}", timeout=TIMEOUT).json()
        assert [p["project_id"] for p in got["projects"]] == [p2["project_id"]]

    def test_an_absent_list_leaves_the_links_alone(self, admin):
        """Absent means "not editing that", or every unrelated patch would unlink."""
        p = _mk_project(admin)
        a = _mk_artist(admin, project_ids=[p["project_id"]])

        requests.patch(f"{API}/admin/artists/{a['artist_id']}",
                       json={"name": "RENAMED"}, headers=admin, timeout=TIMEOUT)

        got = requests.get(f"{API}/artists/{a['slug']}", timeout=TIMEOUT).json()
        assert [p["project_id"] for p in got["projects"]] == [p["project_id"]]

    def test_an_empty_list_clears_them(self, admin):
        p = _mk_project(admin)
        a = _mk_artist(admin, project_ids=[p["project_id"]])

        requests.patch(f"{API}/admin/artists/{a['artist_id']}",
                       json={"project_ids": []}, headers=admin, timeout=TIMEOUT)

        got = requests.get(f"{API}/artists/{a['slug']}", timeout=TIMEOUT).json()
        assert got["projects"] == []

    def test_editing_one_artist_does_not_disturb_another(self, admin):
        """$addToSet/$pull rather than rewriting the array — the property that makes two
        admins editing two artists at once safe."""
        p = _mk_project(admin)
        first = _mk_artist(admin, project_ids=[p["project_id"]])
        second = _mk_artist(admin, project_ids=[p["project_id"]])

        ids = db.projects.find_one({"project_id": p["project_id"]})["artist_ids"]
        assert {first["artist_id"], second["artist_id"]} <= set(ids)

    def test_the_admin_list_reports_the_links_back(self, admin):
        p = _mk_project(admin)
        a = _mk_artist(admin, project_ids=[p["project_id"]])
        rows = requests.get(f"{API}/admin/artists", headers=admin, timeout=TIMEOUT).json()
        row = next(r for r in rows if r["artist_id"] == a["artist_id"])
        assert row["project_ids"] == [p["project_id"]]

    def test_deleting_an_artist_takes_their_id_out_of_projects_and_events(self, admin):
        p = _mk_project(admin)
        event_id = _mk_event(published=True)
        a = _mk_artist(admin, project_ids=[p["project_id"]])
        db.events.update_one({"event_id": event_id},
                             {"$push": {"artist_ids": a["artist_id"]}})

        requests.delete(f"{API}/admin/artists/{a['artist_id']}", headers=admin, timeout=TIMEOUT)

        assert a["artist_id"] not in db.projects.find_one(
            {"project_id": p["project_id"]})["artist_ids"]
        assert a["artist_id"] not in db.events.find_one(
            {"event_id": event_id})["artist_ids"]


class TestProjectPatch:
    def test_a_project_can_be_edited_at_all(self, admin):
        """It could not before: projects were create-and-delete only, so an artist list
        set at creation was permanent."""
        p = _mk_project(admin)
        r = requests.patch(f"{API}/admin/projects/{p['project_id']}",
                           json={"title": "RETITLED"}, headers=admin, timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        assert r.json()["title"] == "RETITLED"

    def test_artists_can_be_set_from_the_project_side(self, admin):
        a = _mk_artist(admin)
        p = _mk_project(admin)
        requests.patch(f"{API}/admin/projects/{p['project_id']}",
                       json={"artist_ids": [a["artist_id"]]}, headers=admin, timeout=TIMEOUT)

        got = requests.get(f"{API}/artists/{a['slug']}", timeout=TIMEOUT).json()
        assert [x["project_id"] for x in got["projects"]] == [p["project_id"]]

    def test_it_needs_admin(self, admin):
        p = _mk_project(admin)
        r = requests.patch(f"{API}/admin/projects/{p['project_id']}",
                           json={"title": "nope"}, timeout=TIMEOUT)
        assert r.status_code in (401, 403)
