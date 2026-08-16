"""
CMS backend tests — iteration 6.
Covers:
  - Public endpoints (theme, nav, pages) with no auth
  - Seed idempotency
  - Auth gating (401 no-cookie, 403 user, 200 editor/admin)
  - Page CRUD as editor, publish → versions behavior, revert
  - Reorder
  - Theme flow (draft → publish → public reflects)
  - Nav filtering (in_nav=false excluded)
"""
import uuid
import pytest
import requests

from support import API, bearer, mint_user

# These used to be UMB_*_TOKEN environment variables injected by the Emergent runner, and
# `_mint` used to shell out to mongosh with the database name hardcoded as
# 'test_database'. Both are gone.
#
# They are now ROLE SENTINELS, not tokens: `_b()` resolves one to a real session token on
# first use and caches it for the module. Resolving lazily matters — minting at import
# time would hit the network during collection, which is precisely how the old suite
# turned "server not running" into an unreadable wall of collection errors.
ADMIN_TOKEN = "admin"
EDITOR_TOKEN = "editor"
USER_TOKEN = "user"

_ROLES = ("admin", "editor", "user", "door")
_token_cache: dict = {}


def _mint(role):
    """Register a throwaway account with `role` and return its session token."""
    headers, _uid, _email = mint_user(role)
    return headers["Authorization"].split(" ", 1)[1]


def _b(role_or_token):
    """Bearer header from either a role sentinel above or a literal session token."""
    if role_or_token in _ROLES:
        if role_or_token not in _token_cache:
            _token_cache[role_or_token] = _mint(role_or_token)
        return bearer(_token_cache[role_or_token])
    return bearer(role_or_token)


# ---------- Public ----------

def test_public_theme_no_auth():
    r = requests.get(f"{API}/cms/theme", timeout=15)
    assert r.status_code == 200, r.text
    d = r.json()
    assert "published" in d
    theme = d["published"]
    assert "colors" in theme and "fonts" in theme
    assert theme["colors"].get("accent")


def test_public_nav_no_auth():
    r = requests.get(f"{API}/cms/nav", timeout=15)
    assert r.status_code == 200
    items = r.json()
    assert isinstance(items, list)
    slugs = [i["slug"] for i in items]
    # Seeded: home, mission, contact
    for s in ["home", "mission", "contact"]:
        assert s in slugs, f"expected {s} in nav, got {slugs}"
    for it in items:
        assert "slug" in it and "label" in it


def test_public_home_page():
    r = requests.get(f"{API}/cms/pages/home", timeout=15)
    assert r.status_code == 200
    d = r.json()
    assert d["slug"] == "home"
    assert isinstance(d.get("blocks"), list)
    assert len(d["blocks"]) > 0


def test_public_unknown_slug_404():
    r = requests.get(f"{API}/cms/pages/nonexistent-slug-xyz", timeout=15)
    assert r.status_code == 404


# ---------- Seed idempotency ----------

def test_seed_idempotent():
    # /api/cms/seed is now admin-gated (iteration 7 security hardening)
    r = requests.post(f"{API}/cms/seed", headers=_b(ADMIN_TOKEN), timeout=15)
    assert r.status_code == 200
    d = r.json()
    # Should be no-op since seed was already invoked by main agent
    assert d.get("seeded") is False
    assert "already" in (d.get("reason") or "").lower()


# ---------- Auth gating ----------

def test_admin_pages_no_auth_401():
    r = requests.get(f"{API}/admin/cms/pages", timeout=15)
    assert r.status_code == 401


def test_admin_pages_user_role_403():
    tok = _mint("user")
    r = requests.get(f"{API}/admin/cms/pages", headers=_b(tok), timeout=15)
    assert r.status_code == 403


def test_admin_pages_editor_role_200():
    assert EDITOR_TOKEN
    r = requests.get(f"{API}/admin/cms/pages", headers=_b(EDITOR_TOKEN), timeout=15)
    assert r.status_code == 200
    assert isinstance(r.json(), list)


def test_admin_pages_admin_role_200():
    assert ADMIN_TOKEN
    r = requests.get(f"{API}/admin/cms/pages", headers=_b(ADMIN_TOKEN), timeout=15)
    assert r.status_code == 200


# ---------- Page CRUD as editor ----------

def test_page_crud_publish_revert_flow():
    editor = _b(EDITOR_TOKEN)
    slug = f"test-cms-{uuid.uuid4().hex[:8]}"

    # CREATE
    r = requests.post(f"{API}/admin/cms/pages",
                      json={"slug": slug, "title": "Test CMS"},
                      headers=editor, timeout=15)
    assert r.status_code == 200, r.text
    p = r.json()
    pid = p["page_id"]
    assert p["draft"]["blocks"] == []
    assert p["published"] is None
    assert p.get("versions") == []

    # GET list includes it
    r2 = requests.get(f"{API}/admin/cms/pages", headers=editor, timeout=15)
    assert r2.status_code == 200
    assert any(x["page_id"] == pid for x in r2.json())

    # PATCH draft with a block
    block = {"block_id": "bk_test1", "type": "hero", "enabled": True, "props": {"heading": "First"}}
    r3 = requests.patch(f"{API}/admin/cms/pages/{pid}",
                        json={"draft": {"blocks": [block]}},
                        headers=editor, timeout=15)
    assert r3.status_code == 200
    assert r3.json()["draft"]["blocks"][0]["props"]["heading"] == "First"

    # PUBLISH #1 — no versions expected (first publish, no prior published)
    r4 = requests.post(f"{API}/admin/cms/pages/{pid}/publish", headers=editor, timeout=15)
    assert r4.status_code == 200
    p4 = r4.json()
    assert p4["published"]["blocks"][0]["props"]["heading"] == "First"
    assert p4.get("versions", []) == [], f"first publish should NOT create version, got {p4.get('versions')}"

    # Edit draft to a new heading, then publish again — versions should now have 1 entry with old blocks
    block2 = {"block_id": "bk_test2", "type": "hero", "enabled": True, "props": {"heading": "Second"}}
    requests.patch(f"{API}/admin/cms/pages/{pid}",
                   json={"draft": {"blocks": [block2]}},
                   headers=editor, timeout=15)
    r5 = requests.post(f"{API}/admin/cms/pages/{pid}/publish", headers=editor, timeout=15)
    assert r5.status_code == 200
    p5 = r5.json()
    assert p5["published"]["blocks"][0]["props"]["heading"] == "Second"
    versions = p5.get("versions", [])
    assert len(versions) == 1, f"expected 1 version snapshot, got {len(versions)}"
    assert versions[0]["blocks"][0]["props"]["heading"] == "First"
    version_id = versions[0]["version_id"]

    # REVERT loads the old blocks into draft
    r6 = requests.post(f"{API}/admin/cms/pages/{pid}/revert/{version_id}",
                       headers=editor, timeout=15)
    assert r6.status_code == 200
    p6 = r6.json()
    assert p6["draft"]["blocks"][0]["props"]["heading"] == "First"

    # DELETE
    r7 = requests.delete(f"{API}/admin/cms/pages/{pid}", headers=editor, timeout=15)
    assert r7.status_code == 200

    # Verify gone
    r8 = requests.get(f"{API}/admin/cms/pages/{pid}", headers=editor, timeout=15)
    assert r8.status_code == 404


# ---------- Reorder ----------

def test_reorder_pages():
    editor = _b(EDITOR_TOKEN)
    r = requests.get(f"{API}/admin/cms/pages", headers=editor, timeout=15)
    pages = r.json()
    # Only seeded ones (order 0,1,2). Grab their ids in current order.
    seeded = [p for p in pages if p["slug"] in ("home", "mission", "contact")]
    seeded.sort(key=lambda p: p["nav_order"])
    ids_original = [p["page_id"] for p in seeded]
    assert len(ids_original) == 3

    # Reverse them
    reversed_ids = list(reversed(ids_original))
    r2 = requests.post(f"{API}/admin/cms/pages/reorder",
                       json={"order": reversed_ids}, headers=editor, timeout=15)
    assert r2.status_code == 200

    r3 = requests.get(f"{API}/admin/cms/pages", headers=editor, timeout=15)
    by_id = {p["page_id"]: p for p in r3.json()}
    for i, pid in enumerate(reversed_ids):
        assert by_id[pid]["nav_order"] == i, f"page {pid} should have nav_order {i}"

    # Restore
    requests.post(f"{API}/admin/cms/pages/reorder",
                  json={"order": ids_original}, headers=editor, timeout=15)


# ---------- Theme flow ----------

def test_theme_draft_publish_flow():
    editor = _b(EDITOR_TOKEN)
    # Get current
    r = requests.get(f"{API}/admin/cms/theme", headers=editor, timeout=15)
    assert r.status_code == 200
    t = r.json()
    assert "draft" in t and "published" in t
    orig_pub_accent = t["published"]["colors"]["accent"]

    # PATCH draft with a new color
    new_draft = dict(t.get("draft") or t["published"])
    new_draft["colors"] = dict(new_draft["colors"])
    new_draft["colors"]["accent"] = "#00FF00"
    r2 = requests.patch(f"{API}/admin/cms/theme",
                        json={"draft": new_draft}, headers=editor, timeout=15)
    assert r2.status_code == 200
    assert r2.json()["draft"]["colors"]["accent"] == "#00FF00"

    # Publish
    r3 = requests.post(f"{API}/admin/cms/theme/publish", headers=editor, timeout=15)
    assert r3.status_code == 200
    p = r3.json()
    assert p["published"]["colors"]["accent"] == "#00FF00"

    # Public reflects
    r4 = requests.get(f"{API}/cms/theme", timeout=15)
    assert r4.json()["published"]["colors"]["accent"] == "#00FF00"

    # Restore
    restore = dict(new_draft)
    restore["colors"] = dict(restore["colors"])
    restore["colors"]["accent"] = orig_pub_accent
    requests.patch(f"{API}/admin/cms/theme",
                   json={"draft": restore}, headers=editor, timeout=15)
    requests.post(f"{API}/admin/cms/theme/publish", headers=editor, timeout=15)


def test_uploaded_font_reports_whether_the_theme_uses_it():
    """`in_use` is what warns an editor before they delete the face their site is set in.

    Lives here rather than in test_cms_fonts.py deliberately: it does a read-modify-write
    of the theme draft, exactly as test_theme_draft_publish_flow above does, and xdist's
    loadscope only guarantees that one module runs on one worker. Split across two files
    the two tests would race and one would lose its update.
    """
    editor = _b(EDITOR_TOKEN)
    family = f"InUse{uuid.uuid4().hex[:10]}"

    up = requests.post(
        f"{API}/admin/cms/fonts",
        files={"file": ("InUse-Regular.woff2", b"wOF2" + b"\x00" * 256, "font/woff2")},
        data={"family": family, "weight": "400", "style": "normal"},
        headers=editor, timeout=20,
    )
    assert up.status_code == 200, up.text
    font_id = up.json()["font_id"]

    def row():
        rows = requests.get(f"{API}/admin/cms/fonts", headers=editor, timeout=15).json()
        return next(f for f in rows if f["font_id"] == font_id)

    t = requests.get(f"{API}/admin/cms/theme", headers=editor, timeout=15).json()
    original = dict(t.get("draft") or t["published"])
    try:
        assert row()["in_use"] is False

        draft = dict(original)
        draft["fonts"] = {**(original.get("fonts") or {}), "display": family}
        r = requests.patch(f"{API}/admin/cms/theme", json={"draft": draft}, headers=editor, timeout=15)
        assert r.status_code == 200, r.text

        assert row()["in_use"] is True
    finally:
        requests.patch(f"{API}/admin/cms/theme", json={"draft": original}, headers=editor, timeout=15)
        requests.delete(f"{API}/admin/cms/fonts/{font_id}", headers=editor, timeout=15)


# ---------- Nav filtering ----------

def test_nav_excludes_in_nav_false():
    editor = _b(EDITOR_TOKEN)
    slug = f"hidden-{uuid.uuid4().hex[:6]}"

    # Create page
    r = requests.post(f"{API}/admin/cms/pages",
                      json={"slug": slug, "title": "Hidden", "in_nav": False},
                      headers=editor, timeout=15)
    assert r.status_code == 200, r.text
    pid = r.json()["page_id"]

    # Add a block + publish so it has published data
    block = {"block_id": "bk_h", "type": "rich_text", "enabled": True, "props": {"content": "hi"}}
    requests.patch(f"{API}/admin/cms/pages/{pid}",
                   json={"draft": {"blocks": [block]}}, headers=editor, timeout=15)
    requests.post(f"{API}/admin/cms/pages/{pid}/publish", headers=editor, timeout=15)

    # Public nav MUST not include it
    r2 = requests.get(f"{API}/cms/nav", timeout=15)
    assert r2.status_code == 200
    slugs = [i["slug"] for i in r2.json()]
    assert slug not in slugs, f"hidden slug should not be in nav: {slugs}"

    # But the page itself should be reachable via /cms/pages/{slug}
    r3 = requests.get(f"{API}/cms/pages/{slug}", timeout=15)
    assert r3.status_code == 200

    # Cleanup
    requests.delete(f"{API}/admin/cms/pages/{pid}", headers=editor, timeout=15)


# ---------- Regression sanity ----------

def test_events_upcoming_regression():
    r = requests.get(f"{API}/events?upcoming=true", timeout=15)
    assert r.status_code == 200
    assert isinstance(r.json(), list)


def test_admin_stats_regression():
    r = requests.get(f"{API}/admin/stats", headers=_b(ADMIN_TOKEN), timeout=15)
    assert r.status_code == 200
    d = r.json()
    for k in ("revenue_ron", "total_orders", "total_tickets", "scanned", "events"):
        assert k in d


# ---------- Core nav links (built-in sections, reorderable from the CMS) ----------

CORE_SLUGS = {"core-events", "core-shop", "core-artists", "core-archive", "core-gallery"}


def test_core_links_appear_in_public_nav_with_routes():
    """They have no blocks and are never published, so they qualify on `kind` instead —
    the published filter that hides an unfinished page would otherwise hide them all."""
    nav = requests.get(f"{API}/cms/nav", timeout=15).json()
    core = {i["slug"]: i for i in nav if i.get("kind") == "core"}
    assert CORE_SLUGS <= set(core), f"missing core links: {CORE_SLUGS - set(core)}"
    assert core["core-shop"]["route"] == "/shop"
    assert core["core-events"]["label"] == "Events"


def test_nav_resolves_hrefs_for_authored_pages():
    """The header renders `route` verbatim now, so the routing table lives server-side.
    Three slugs predate /p/<slug> and must keep their own paths."""
    nav = {i["slug"]: i["route"] for i in requests.get(f"{API}/cms/nav", timeout=15).json()}
    assert nav.get("home") == "/"
    assert nav.get("mission") == "/mission"
    assert nav.get("contact") == "/contact"


def test_nav_is_returned_in_nav_order():
    nav = requests.get(f"{API}/cms/nav", timeout=15).json()
    pages = requests.get(f"{API}/admin/cms/pages", headers=_b(EDITOR_TOKEN), timeout=15).json()
    order = {p["slug"]: p["nav_order"] for p in pages}
    seen = [order[i["slug"]] for i in nav if i["slug"] in order]
    assert seen == sorted(seen), f"nav came back out of order: {seen}"


def test_core_link_can_be_reordered_among_pages():
    """The point of the whole change: a built-in section can be moved ahead of an
    authored page. Before this, core links were hardcoded in the header and always last."""
    editor = _b(EDITOR_TOKEN)
    pages = requests.get(f"{API}/admin/cms/pages", headers=editor, timeout=15).json()
    original = [p["page_id"] for p in pages]
    gallery = next(p for p in pages if p["slug"] == "core-gallery")

    moved = [pid for pid in original if pid != gallery["page_id"]]
    moved.insert(0, gallery["page_id"])
    try:
        r = requests.post(f"{API}/admin/cms/pages/reorder", json={"order": moved},
                          headers=editor, timeout=15)
        assert r.status_code == 200
        nav = requests.get(f"{API}/cms/nav", timeout=15).json()
        assert nav[0]["slug"] == "core-gallery", [i["slug"] for i in nav]
    finally:
        # Leave the arrangement exactly as found — every other test reads this nav.
        requests.post(f"{API}/admin/cms/pages/reorder", json={"order": original},
                      headers=editor, timeout=15)


def test_core_link_cannot_be_deleted():
    """Deleting one would strip a section from the nav with no way back from the UI,
    while the route behind it stayed live. Hiding is the reversible alternative."""
    editor = _b(EDITOR_TOKEN)
    pages = requests.get(f"{API}/admin/cms/pages", headers=editor, timeout=15).json()
    core = next(p for p in pages if p["slug"] == "core-shop")

    r = requests.delete(f"{API}/admin/cms/pages/{core['page_id']}", headers=editor, timeout=15)
    assert r.status_code == 400, r.text
    assert "cannot be deleted" in r.json()["detail"].lower()

    still = requests.get(f"{API}/admin/cms/pages", headers=editor, timeout=15).json()
    assert any(p["slug"] == "core-shop" for p in still), "core link disappeared anyway"


def test_core_link_can_be_hidden_and_restored():
    editor = _b(EDITOR_TOKEN)
    pages = requests.get(f"{API}/admin/cms/pages", headers=editor, timeout=15).json()
    core = next(p for p in pages if p["slug"] == "core-archive")
    try:
        requests.patch(f"{API}/admin/cms/pages/{core['page_id']}", json={"in_nav": False},
                       headers=editor, timeout=15)
        slugs = [i["slug"] for i in requests.get(f"{API}/cms/nav", timeout=15).json()]
        assert "core-archive" not in slugs, slugs
    finally:
        requests.patch(f"{API}/admin/cms/pages/{core['page_id']}", json={"in_nav": True},
                       headers=editor, timeout=15)
    slugs = [i["slug"] for i in requests.get(f"{API}/cms/nav", timeout=15).json()]
    assert "core-archive" in slugs, slugs


# ---------- Homepage designation ----------

def _pages(editor):
    return requests.get(f"{API}/admin/cms/pages", headers=editor, timeout=15).json()


def _current_home(editor):
    return next((p for p in _pages(editor) if p.get("is_home")), None)


def test_home_endpoint_serves_a_page_whatever_its_slug():
    """The point of the flag: "/" must not depend on a page being called "home"."""
    r = requests.get(f"{API}/cms/home", timeout=15)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["blocks"], "the homepage came back with no content"
    for k in ("page_id", "slug", "title", "blocks"):
        assert k in body


def test_home_page_links_to_the_root_in_nav(seeded):
    """The homepage must appear in the nav, and point at `/` rather than its own slug.

    This used to skip when the entry was missing — which is the more interesting of the
    two failures it can have, quietly reported as a non-result. A homepage absent from
    the nav is a broken install, so it is now asserted; `seeded` guarantees there is
    content to assert against.
    """
    home = requests.get(f"{API}/cms/home", timeout=15).json()
    nav = requests.get(f"{API}/cms/nav", timeout=15).json()
    entry = next((n for n in nav if n["slug"] == home["slug"]), None)
    assert entry is not None, (
        f"the homepage ({home['slug']!r}) is missing from the nav; "
        f"nav has {[n['slug'] for n in nav]}"
    )
    assert entry["route"] == "/", f"homepage should link to / not {entry['route']}"


def test_setting_home_moves_the_flag_and_never_leaves_two():
    editor = _b(EDITOR_TOKEN)
    original = _current_home(editor)
    other = next(p for p in _pages(editor)
                 if p.get("kind") != "core" and p.get("published")
                 and (original is None or p["page_id"] != original["page_id"]))
    try:
        r = requests.post(f"{API}/admin/cms/pages/{other['page_id']}/home", headers=editor, timeout=15)
        assert r.status_code == 200, r.text
        flagged = [p["slug"] for p in _pages(editor) if p.get("is_home")]
        assert flagged == [other["slug"]], f"expected exactly one homepage, got {flagged}"
        assert requests.get(f"{API}/cms/home", timeout=15).json()["slug"] == other["slug"]
    finally:
        if original:
            requests.post(f"{API}/admin/cms/pages/{original['page_id']}/home", headers=editor, timeout=15)


def test_core_link_cannot_be_the_homepage():
    """A built-in link is a React route with no blocks — there is nothing to render."""
    editor = _b(EDITOR_TOKEN)
    core = next(p for p in _pages(editor) if p["slug"] == "core-shop")
    r = requests.post(f"{API}/admin/cms/pages/{core['page_id']}/home", headers=editor, timeout=15)
    assert r.status_code == 400, r.text
    assert not any(p.get("is_home") and p["slug"] == "core-shop" for p in _pages(editor))


def test_unpublished_page_cannot_be_the_homepage():
    """/cms/home reads the published copy, so a draft-only page would blank the root."""
    editor = _b(EDITOR_TOKEN)
    slug = f"test-cms-{uuid.uuid4().hex[:8]}"
    created = requests.post(f"{API}/admin/cms/pages", json={"slug": slug, "title": "Draft Only"},
                            headers=editor, timeout=15).json()
    try:
        r = requests.post(f"{API}/admin/cms/pages/{created['page_id']}/home", headers=editor, timeout=15)
        assert r.status_code == 400, r.text
        assert "publish" in r.json()["detail"].lower()
    finally:
        requests.delete(f"{API}/admin/cms/pages/{created['page_id']}", headers=editor, timeout=15)
