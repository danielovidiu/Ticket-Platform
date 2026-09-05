"""
What the CMS write endpoints do when the editor sends nothing.

This exists because of a frontend bug with a server-shaped symptom. "Save now" in the CMS
flushes every registered surface, not only the dirty ones, and the shared autosave hook's
"nothing pending" guard tested for `undefined` but not `null`. Two panes initialise their
pending ref with `useRef(null)`, so pressing Save now after editing only a BLOCK sent:

  * the page-metadata pane: a PATCH with NO BODY, which came back 422 with
    `loc: ["body"], msg: "Field required"` and reached the editor as
    "Save failed — body: Field required" — naming a field nobody had touched;
  * the theme pane: `{"draft": null}`.

The frontend fix is the guard (frontend/src/lib/useAutosave.js). These tests pin the
server half of it, and one of them answers a question the fix depended on: whether that
second request could have DESTROYED a theme draft on its way to failing. `admin_patch_theme`
writes `{"$set": {"draft": body.draft}}` unconditionally, so if `ThemePatch.draft` were
nullable it would have stored null over the editor's work.

It is not, and that is worth a test rather than a reading of the model — the difference
between "a confusing error" and "a confusing error that also lost your theme".
"""
import pytest
import requests

from support import API, TIMEOUT, db

pytestmark = [pytest.mark.critical, pytest.mark.xdist_group("test_cms_empty_save")]


def _a_page_id(admin_headers):
    r = requests.get(f"{API}/admin/cms/pages", headers=admin_headers, timeout=TIMEOUT)
    assert r.status_code == 200, r.text
    pages = r.json()
    assert pages, "no CMS pages to test against"
    return pages[0]["page_id"]


class TestASaveWithNoBody:

    def test_patching_a_page_with_no_body_is_refused(self, admin_headers):
        page_id = _a_page_id(admin_headers)
        r = requests.patch(f"{API}/admin/cms/pages/{page_id}",
                           headers=admin_headers, timeout=TIMEOUT)
        assert r.status_code == 422, f"{r.status_code}: {r.text[:200]}"

    def test_and_the_message_is_the_one_the_editor_showed(self, admin_headers):
        """`loc` is just ["body"], which is why the editor said "body: Field required" —
        a field name that matches nothing on the form, which is what made it findable."""
        page_id = _a_page_id(admin_headers)
        r = requests.patch(f"{API}/admin/cms/pages/{page_id}",
                           headers=admin_headers, timeout=TIMEOUT)
        detail = r.json()["detail"]
        assert isinstance(detail, list) and detail, detail
        assert detail[0]["loc"][-1] == "body", detail
        assert detail[0]["msg"] == "Field required", detail

    def test_a_page_patch_with_no_body_changes_nothing(self, admin_headers):
        page_id = _a_page_id(admin_headers)
        before = db.cms_pages.find_one({"page_id": page_id}, {"_id": 0})
        requests.patch(f"{API}/admin/cms/pages/{page_id}",
                       headers=admin_headers, timeout=TIMEOUT)
        assert db.cms_pages.find_one({"page_id": page_id}, {"_id": 0}) == before


class TestANullThemeDraftCannotWipeTheStoredOne:
    """The question the frontend fix turned on. admin_patch_theme `$set`s body.draft
    without inspecting it, so the ONLY thing standing between a null and the editor's
    saved theme is the model refusing it."""

    def test_a_null_draft_is_refused(self, admin_headers):
        r = requests.patch(f"{API}/admin/cms/theme", headers=admin_headers,
                           json={"draft": None}, timeout=TIMEOUT)
        assert r.status_code == 422, f"{r.status_code}: {r.text[:200]}"

    def test_and_the_stored_draft_survives_it(self, admin_headers):
        # Seed something recognisable, so "unchanged" means what it says rather than
        # passing because the draft happened to be empty already.
        marker = {"colors": {"bg": "#123456"}}
        db.cms_theme.update_one({"doc_id": "theme_current"},
                                {"$set": {"draft": marker}}, upsert=True)
        try:
            requests.patch(f"{API}/admin/cms/theme", headers=admin_headers,
                           json={"draft": None}, timeout=TIMEOUT)
            after = db.cms_theme.find_one({"doc_id": "theme_current"}, {"_id": 0})
            assert after["draft"] == marker, "a refused write still reached the document"
        finally:
            db.cms_theme.update_one({"doc_id": "theme_current"},
                                    {"$unset": {"draft": ""}})

    def test_a_real_draft_still_writes(self, admin_headers):
        """The refusal must be about null, not about the endpoint being broken."""
        r = requests.patch(f"{API}/admin/cms/theme", headers=admin_headers,
                           json={"draft": {"colors": {"bg": "#010203"}}}, timeout=TIMEOUT)
        assert r.status_code == 200, f"{r.status_code}: {r.text[:200]}"
        assert r.json()["draft"]["colors"]["bg"] == "#010203"
