"""
The eyebrow and name at the top of the four built-in section pages.

/events, /artists, /gallery and /shop are React routes with no blocks, so their two
lines of type were literals in the JSX — a white-label customer got "Programme" over
their events and had nowhere to change it. They are content, so they moved into the CMS.

Two behaviours matter more than the storage:

* a site that never opens the panel keeps exactly the wording it displayed before, and
* an emptied box empties the line — the CMS's "blank means BLANK" rule, which the site
  settings learned the hard way (see test_site_settings_blank.py). A field that silently
  refuses the edit and keeps the old text is the worst of the three options.
"""
import pytest
import requests

from support import API, db, mint_user, TIMEOUT

pytestmark = pytest.mark.xdist_group("core_page_headers")

BUILT_IN = {
    "events": {"eyebrow": "Programme", "heading": "Events"},
    "artists": {"eyebrow": "Roster", "heading": "Artists"},
    "gallery": {"eyebrow": "Documentation", "heading": "Gallery"},
    "shop": {"eyebrow": "Merchandise", "heading": "Shop"},
}


@pytest.fixture(scope="module")
def editor():
    headers, _uid, _email = mint_user("editor")
    return headers


@pytest.fixture(autouse=True)
def _clean():
    db.site_settings.delete_one({"_id": "core_pages"})
    yield
    db.site_settings.delete_one({"_id": "core_pages"})


def _public():
    r = requests.get(f"{API}/cms/core-pages", timeout=TIMEOUT)
    assert r.status_code == 200, r.text
    return r.json()


def _put(editor, pages):
    return requests.put(f"{API}/admin/cms/core-pages", json={"pages": pages},
                        headers=editor, timeout=TIMEOUT)


class TestTheBuiltInWording:
    def test_an_untouched_site_reads_what_the_pages_used_to_hardcode(self):
        assert _public() == BUILT_IN

    def test_the_public_endpoint_needs_no_auth(self):
        """Four pages read it before they render, for every visitor."""
        assert requests.get(f"{API}/cms/core-pages", timeout=TIMEOUT).status_code == 200

    def test_the_admin_read_carries_the_defaults_alongside(self, editor):
        r = requests.get(f"{API}/admin/cms/core-pages", headers=editor, timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        assert r.json()["defaults"] == BUILT_IN


class TestEditing:
    def test_an_editor_can_rename_a_page(self, editor):
        r = _put(editor, {"shop": {"eyebrow": "Goods", "heading": "Store"}})
        assert r.status_code == 200, r.text
        assert r.json()["shop"] == {"eyebrow": "Goods", "heading": "Store"}
        assert _public()["shop"] == {"eyebrow": "Goods", "heading": "Store"}

    def test_the_pages_left_out_are_untouched(self, editor):
        _put(editor, {"shop": {"eyebrow": "Goods", "heading": "Store"}})
        assert _public()["gallery"] == BUILT_IN["gallery"]

    def test_an_emptied_box_empties_the_line(self, editor):
        """Not "fall back to the built-in wording" — that is the bug this rule exists
        for. The page renders nothing there and what was under it moves up."""
        r = _put(editor, {"gallery": {"eyebrow": "", "heading": "Gallery"}})
        assert r.json()["gallery"] == {"eyebrow": "", "heading": "Gallery"}
        assert _public()["gallery"]["eyebrow"] == ""

    def test_both_lines_can_go(self, editor):
        _put(editor, {"artists": {"eyebrow": "", "heading": ""}})
        assert _public()["artists"] == {"eyebrow": "", "heading": ""}

    def test_whitespace_is_not_content(self, editor):
        """A box holding one space looks empty in the editor; it has to read as empty
        on the site too."""
        _put(editor, {"events": {"eyebrow": "   ", "heading": "  Live  "}})
        assert _public()["events"] == {"eyebrow": "", "heading": "Live"}

    def test_an_unknown_page_is_refused_rather_than_stored(self, editor):
        r = _put(editor, {"blog": {"eyebrow": "x", "heading": "y"}})
        assert r.status_code == 400
        assert _public() == BUILT_IN


class TestItIsGuarded:
    def test_writing_needs_an_editor(self):
        r = requests.put(f"{API}/admin/cms/core-pages",
                         json={"pages": {"shop": {"eyebrow": "", "heading": ""}}},
                         timeout=TIMEOUT)
        assert r.status_code in (401, 403)

    def test_reading_the_admin_view_needs_an_editor(self):
        r = requests.get(f"{API}/admin/cms/core-pages", timeout=TIMEOUT)
        assert r.status_code in (401, 403)


class TestAStoredValueThatWentBad:
    def test_a_half_written_page_still_reads(self, editor):
        """Written straight to the database, past the endpoint. A page key that exists
        has been authored, so its missing half is an empty line rather than a crash."""
        db.site_settings.update_one({"_id": "core_pages"},
                                    {"$set": {"shop": {"heading": "Store"}}}, upsert=True)
        assert _public()["shop"] == {"eyebrow": "", "heading": "Store"}

    def test_a_page_key_of_the_wrong_shape_falls_back(self, editor):
        db.site_settings.update_one({"_id": "core_pages"},
                                    {"$set": {"shop": "Store"}}, upsert=True)
        assert _public()["shop"] == BUILT_IN["shop"]
