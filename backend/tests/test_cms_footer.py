"""
The footer, and where a page belongs.

All of it used to be typed into Layout.jsx — a wordmark, a sentence, three hrefs, an
address, a copyright line. The hrefs were the worst part: they pointed AT CMS pages by
hardcoded path, so renaming or unpublishing one left the footer aimed at a 404 and
nothing said so. The links are pages now.

Two properties carry the weight here:

  * a page is in the top nav or in the footer, never both — and ticking either one
    unticks the other rather than refusing the edit, because an editor should not have
    to know the rule before they are allowed to act on it;
  * the migration must have run. Without it the first deploy renders an EMPTY Legal
    column: the pages are all still there, nothing marks them as belonging in it. That
    needs SCHEMA_VERSION bumped, which is the part that is easy to forget and silent
    when forgotten.
"""
import uuid

import pytest
import requests

import server
from support import API, TIMEOUT, db, mint_user

pytestmark = pytest.mark.xdist_group("cms_footer")

_page_ids: list = []


@pytest.fixture(scope="module")
def editor():
    headers, _uid, _email = mint_user("editor")
    return headers


@pytest.fixture(scope="module", autouse=True)
def _cleanup():
    yield
    if _page_ids:
        db.cms_pages.delete_many({"page_id": {"$in": _page_ids}})
    db.site_settings.delete_one({"_id": "site"})


def _mk_page(editor, **fields):
    body = {"slug": f"pytest-{uuid.uuid4().hex[:10]}", "title": "PYTEST PAGE"}
    body.update(fields)
    r = requests.post(f"{API}/admin/cms/pages", json=body, headers=editor, timeout=TIMEOUT)
    assert r.status_code == 200, r.text
    p = r.json()
    _page_ids.append(p["page_id"])
    return p


def _patch(editor, page_id, **fields):
    r = requests.patch(f"{API}/admin/cms/pages/{page_id}", json=fields,
                       headers=editor, timeout=TIMEOUT)
    assert r.status_code == 200, r.text
    return r.json()


class TestAPageIsInOnePlace:
    def test_putting_a_page_in_the_footer_takes_it_out_of_the_nav(self, editor):
        p = _mk_page(editor, in_nav=True)
        got = _patch(editor, p["page_id"], in_footer=True)
        assert got["in_footer"] is True
        assert got["in_nav"] is False, "a footer page must leave the nav"

    def test_and_back_again(self, editor):
        p = _mk_page(editor, in_nav=False, in_footer=True)
        got = _patch(editor, p["page_id"], in_nav=True)
        assert got["in_nav"] is True
        assert got["in_footer"] is False

    def test_the_rule_applies_at_creation_too(self, editor):
        """Otherwise a page can be born in both places and only the next edit fixes it."""
        p = _mk_page(editor, in_nav=True, in_footer=True)
        assert p["in_nav"] is False and p["in_footer"] is True

    def test_turning_one_off_does_not_turn_the_other_on(self, editor):
        """Unticking is not a request to move it somewhere else."""
        p = _mk_page(editor, in_nav=True)
        got = _patch(editor, p["page_id"], in_nav=False)
        assert got["in_nav"] is False and got["in_footer"] is False


class TestWhatTheFooterLinksTo:
    def test_only_published_pages_appear(self, editor):
        """A draft in the footer is a link to a page a visitor cannot open."""
        p = _mk_page(editor, in_footer=True)
        labels = [x["slug"] for x in requests.get(f"{API}/cms/site", timeout=TIMEOUT).json()["pages"]]
        assert p["slug"] not in labels, "an unpublished page reached the footer"

    def test_a_published_one_does(self, editor):
        p = _mk_page(editor, in_footer=True)
        requests.post(f"{API}/admin/cms/pages/{p['page_id']}/publish", headers=editor, timeout=TIMEOUT)
        slugs = [x["slug"] for x in requests.get(f"{API}/cms/site", timeout=TIMEOUT).json()["pages"]]
        assert p["slug"] in slugs

    def test_the_label_follows_the_page(self, editor):
        """The whole point of not hardcoding them: rename the page, the footer follows."""
        p = _mk_page(editor, in_footer=True, nav_label="Original")
        requests.post(f"{API}/admin/cms/pages/{p['page_id']}/publish", headers=editor, timeout=TIMEOUT)
        _patch(editor, p["page_id"], nav_label="Renamed")
        entry = next(x for x in requests.get(f"{API}/cms/site", timeout=TIMEOUT).json()["pages"]
                     if x["slug"] == p["slug"])
        assert entry["label"] == "Renamed"

    def test_the_seeded_legal_pages_are_in_it(self):
        """What migrate_footer_pages exists for. If this fails on a fresh database, the
        SCHEMA_VERSION bump was forgotten and the Legal column is empty in production."""
        slugs = {x["slug"] for x in requests.get(f"{API}/cms/site", timeout=TIMEOUT).json()["pages"]}
        assert {"terms", "privacy", "cookie-policy"} <= slugs

    def test_the_migration_is_gated_on_a_version_that_was_bumped(self):
        """The gate returns early when the marker matches, so a new migration without a
        bump never runs — and says nothing about it."""
        assert server.SCHEMA_VERSION >= 9


class TestTheSettings:
    def test_they_start_from_the_built_in_values(self):
        db.site_settings.delete_one({"_id": "site"})
        got = requests.get(f"{API}/cms/site", timeout=TIMEOUT).json()
        assert got["wordmark"] and got["copyright_name"] and got["legal_heading"]

    def test_an_editor_can_change_them(self, editor):
        r = requests.put(f"{API}/admin/cms/site", headers=editor, timeout=TIMEOUT,
                         json={"wordmark": "CHANGED", "description": "New words."})
        assert r.status_code == 200, r.text
        got = requests.get(f"{API}/cms/site", timeout=TIMEOUT).json()
        assert got["wordmark"] == "CHANGED" and got["description"] == "New words."

    def test_the_two_wordmarks_are_independent(self, editor):
        """Separate fields on purpose: they say the same thing today and nothing should
        force them to say it forever."""
        requests.put(f"{API}/admin/cms/site", headers=editor, timeout=TIMEOUT,
                     json={"wordmark": "FOOTER ONLY"})
        got = requests.get(f"{API}/cms/site", timeout=TIMEOUT).json()
        assert got["wordmark"] == "FOOTER ONLY"
        assert got["header_wordmark"] != "FOOTER ONLY"

    def test_a_blank_clears_the_field(self, editor):
        """Blank means blank. This asserted the opposite until it was changed on purpose.

        The old rule was "a footer with no wordmark and no copyright reads as broken, not
        as deliberate", and the route enforced it by discarding empty values. What that
        produced was not a fallback: the field kept whatever custom text was already
        there, so clearing the footer description in the CMS left the box empty, the
        editor saying saved, and the site showing the old words. An edit that is refused
        without saying so is worse than either behaviour it was choosing between.

        The consequence is real and was accepted: an emptied wordmark now renders as an
        empty corner. That is the editor's call to make.
        """
        requests.put(f"{API}/admin/cms/site", headers=editor, timeout=TIMEOUT,
                     json={"wordmark": "   ", "copyright_name": ""})
        got = requests.get(f"{API}/cms/site", timeout=TIMEOUT).json()
        assert got["wordmark"] == ""
        assert got["copyright_name"] == ""

        # Put them back. Blanking used to be a no-op, so this test could leave the
        # document however it liked; now it genuinely empties two fields that anything
        # reading site settings afterwards would find missing.
        requests.put(f"{API}/admin/cms/site", headers=editor, timeout=TIMEOUT,
                     json={"wordmark": "SUPERSANITY", "copyright_name": "Supersanity"})

    def test_empty_social_entries_are_dropped(self, editor):
        requests.put(f"{API}/admin/cms/site", headers=editor, timeout=TIMEOUT,
                     json={"social": {"instagram": "https://i.example", "youtube": "  "}})
        got = requests.get(f"{API}/cms/site", timeout=TIMEOUT).json()
        assert got["social"] == {"instagram": "https://i.example"}

    def test_the_public_endpoint_needs_no_auth(self):
        assert requests.get(f"{API}/cms/site", timeout=TIMEOUT).status_code == 200

    def test_writing_needs_an_editor(self):
        r = requests.put(f"{API}/admin/cms/site", json={"wordmark": "nope"}, timeout=TIMEOUT)
        assert r.status_code in (401, 403)
