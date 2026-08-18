"""
CMS pages live at /<slug>, which puts them in the same namespace as every built-in route.

The failure this guards against is silent: React Router ranks a static segment above the
":slug" catch-all, so a page whose slug spells a built-in path is created without
complaint and then never renders — no 404, no log line, nothing to search for. The
reserved list is the only thing standing between an editor and that, and a list that has
to be kept in step with another file by hand is a list that drifts. So the first test
reads the router and fails if it ever has a path the backend does not know about.

Run: venv/bin/python -m pytest tests/test_page_slugs.py -q
"""
import re
import sys
import uuid
from pathlib import Path

import pytest
import requests

from support import API, bearer, mint_user

BACKEND = Path(__file__).resolve().parent.parent
APP_JS = BACKEND.parent / "frontend" / "src" / "App.js"

sys.path.insert(0, str(BACKEND))
from cms_routes import RESERVED_SLUGS, SLUG_RE, page_route  # noqa: E402

# Runs on one worker, in order: the module's own xdist group. This is what
# `--dist loadgroup` needs in order to behave like the `loadscope` it replaced —
# see pytest.ini.
pytestmark = pytest.mark.xdist_group("test_page_slugs")

_tokens = {}


def _b(role):
    if role not in _tokens:
        headers, _uid, _email = mint_user(role)
        _tokens[role] = headers["Authorization"].split(" ", 1)[1]
    return bearer(_tokens[role])


def _create(slug, headers=None):
    return requests.post(
        f"{API}/admin/cms/pages",
        json={"slug": slug, "title": "T"},
        headers=headers or _b("editor"), timeout=15,
    )


# ---------- The list cannot drift from the router ----------

def router_paths():
    """Top-level static path segments declared in App.js.

    Deliberately reads the real file rather than restating the routes: a copy would drift
    exactly as silently as the thing it is meant to catch.
    """
    src = APP_JS.read_text()
    found = set()
    for m in re.finditer(r'<Route\s+path="(/?)([^"]*)"', src):
        path = m.group(2)
        if not path or path.startswith(":"):
            continue                       # the index route and the catch-all itself
        first = path.split("/")[0]
        if first and not first.startswith(":"):
            found.add(first)
    return found


def test_every_router_path_is_reserved():
    missing = router_paths() - set(RESERVED_SLUGS)
    assert not missing, (
        f"App.js declares {sorted(missing)} but RESERVED_SLUGS does not list them. A CMS "
        f"page on one of those slugs would be created and then never open. Add them to "
        f"RESERVED_SLUGS in cms_routes.py."
    )


def test_the_router_actually_parsed():
    """Guards the guard: a regex that silently matches nothing would make the test above
    pass forever."""
    paths = router_paths()
    assert len(paths) > 10, paths
    assert {"events", "shop", "admin", "login"} <= paths


# ---------- Where a page lives ----------

def test_pages_are_served_from_the_root():
    assert page_route("mission") == "/mission"
    assert page_route("about-us") == "/about-us"


def test_no_page_route_is_namespaced_under_p():
    """The whole point of the move. /p/<slug> is now only a redirect in vercel.json."""
    assert not page_route("anything").startswith("/p/")


# ---------- Reserved slugs are refused ----------

@pytest.mark.parametrize("slug", sorted(RESERVED_SLUGS))
def test_reserved_slugs_are_refused(slug):
    r = _create(slug)
    assert r.status_code == 400, f"created a page at /{slug}: {r.text}"
    assert "reserved" in r.json()["detail"].lower()


def test_the_refusal_says_why():
    """An editor who is told only "400" will try again with the same word."""
    detail = _create("events").json()["detail"]
    assert "events" in detail and "never open" in detail


# ---------- Slug format ----------

@pytest.mark.parametrize("slug", [
    "About Us",        # space — unroutable
    "about/us",        # extra segment — ":slug" matches one
    "-leading",
    "trailing-",
    "double--hyphen",
    "under_score",
    "",
    "café",
])
def test_unroutable_slugs_are_refused(slug):
    r = _create(slug)
    assert r.status_code in (400, 422), f"accepted {slug!r}: {r.text}"


@pytest.mark.parametrize("slug", ["about", "about-us", "tour-2026", "a", "x1"])
def test_ordinary_slugs_are_accepted(slug):
    unique = f"{slug}-{uuid.uuid4().hex[:8]}"
    assert SLUG_RE.match(unique), unique
    r = _create(unique)
    assert r.status_code == 200, r.text
    requests.delete(f"{API}/admin/cms/pages/{r.json()['page_id']}", headers=_b("admin"), timeout=15)


def test_capitals_are_lowercased_rather_than_refused():
    """Case is the one difference that carries no meaning in a URL, so it is normalised
    instead of rejected. A space or a slash is not: silently rewriting those would hand
    back a different address from the one that was typed."""
    created = _create(f"About-Us-{uuid.uuid4().hex[:8]}")
    assert created.status_code == 200, created.text
    body = created.json()
    try:
        assert body["slug"] == body["slug"].lower()
        assert body["slug"].startswith("about-us-")
    finally:
        requests.delete(f"{API}/admin/cms/pages/{body['page_id']}", headers=_b("admin"), timeout=15)


def test_slug_is_normalised_before_the_checks():
    """Uppercase and surrounding space are trimmed rather than stored, so ' Events ' is
    caught by the reserved list instead of slipping past it into an unreachable page."""
    r = _create("  EVENTS  ")
    assert r.status_code == 400, r.text
    assert "reserved" in r.json()["detail"].lower()


# ---------- The nav agrees ----------

def test_nav_hrefs_are_flat():
    slug = f"navpath-{uuid.uuid4().hex[:8]}"
    created = _create(slug)
    assert created.status_code == 200, created.text
    page_id = created.json()["page_id"]
    try:
        block = {"block_id": "bk_x", "type": "rich_text", "enabled": True, "props": {"content": "hi"}}
        requests.patch(f"{API}/admin/cms/pages/{page_id}", json={"draft": {"blocks": [block]}},
                       headers=_b("editor"), timeout=15)
        requests.post(f"{API}/admin/cms/pages/{page_id}/publish", headers=_b("editor"), timeout=15)

        nav = requests.get(f"{API}/cms/nav", timeout=15).json()
        row = next((n for n in nav if n["slug"] == slug), None)
        assert row is not None, [n["slug"] for n in nav]
        assert row["route"] == f"/{slug}"
        assert not any(n["route"].startswith("/p/") for n in nav), nav
    finally:
        requests.delete(f"{API}/admin/cms/pages/{page_id}", headers=_b("admin"), timeout=15)


def test_the_homepage_still_answers_the_root():
    """is_home decides the root, not the slug — so moving pages to /<slug> must not have
    started routing the homepage to /<its-slug> as well."""
    nav = requests.get(f"{API}/cms/nav", timeout=15).json()
    roots = [n for n in nav if n["route"] == "/"]
    assert len(roots) == 1, [(n["slug"], n["route"]) for n in nav]
