"""
The theme as a render-blocking stylesheet.

This endpoint exists to remove a flash, and the properties that matter are the ones that
decide whether the flash comes back:

  * it must WIN over the defaults in index.css, whichever order the two stylesheets are
    injected in — the bundler puts the app's CSS after this link, so equal specificity
    would silently lose and the endpoint would do nothing;
  * a publish must be visible on the next load, or a cached stale palette replaces the
    flash with something worse;
  * it must be public, because it is linked from the document by every visitor.
"""
import pytest
import requests

from support import API, TIMEOUT, db

# One worker, in order. Every test here mutates the single published theme document, so
# run in parallel they invalidate each other's ETags and the freshness assertions become
# a race rather than a check.
pytestmark = [pytest.mark.xdist_group("test_theme_css")]


def _published(**colors):
    db.cms_theme.update_one(
        {"doc_id": "theme_current"},
        {"$set": {f"published.colors.{k}": v for k, v in colors.items()}},
    )


def _css():
    r = requests.get(f"{API}/cms/theme.css", timeout=TIMEOUT)
    assert r.status_code == 200, r.text
    return r


class TestItIsAStylesheet:

    def test_it_is_served_as_css(self):
        r = _css()
        assert r.headers["content-type"].startswith("text/css")

    def test_it_needs_no_session(self):
        # Linked from <head> on every public page, so a 401 here is a broken site.
        r = requests.get(f"{API}/cms/theme.css", timeout=TIMEOUT)
        assert r.status_code == 200

    def test_it_outranks_the_defaults_rather_than_relying_on_order(self):
        """`:root:root`, not `:root`.

        index.css declares the same properties as defaults and is injected AFTER this
        link — in the built output the app's stylesheet is literally the next tag. At
        equal specificity the defaults would win on source order and this endpoint would
        change nothing at all.
        """
        body = _css().text
        assert ":root:root" in body
        assert "\n:root {" not in body


class TestItCarriesTheTheme:

    def test_the_published_colours_are_in_it(self):
        before = db.cms_theme.find_one({"doc_id": "theme_current"})["published"]["colors"]
        try:
            _published(bg="#0B2E13", accent="#00FF88")
            body = _css().text
            assert "--bg: #0B2E13;" in body
            assert "--accent: #00FF88;" in body
        finally:
            _published(bg=before["bg"], accent=before["accent"])

    def test_tailwind_gets_the_bare_channels_too(self):
        """rgb(var(--x) / a) needs "r g b", not a hex — the ramp in index.css is built
        on it, so a colour without channels renders as a broken ramp."""
        before = db.cms_theme.find_one({"doc_id": "theme_current"})["published"]["colors"]
        try:
            _published(accent="#1166FF")
            assert "--accent-rgb: 17 102 255;" in _css().text
        finally:
            _published(accent=before["accent"])

    def test_a_colour_cannot_smuggle_css_out_of_its_declaration(self):
        """A `}` in a colour field would end the rule and let an editor write arbitrary
        CSS into every page. Colours need none of those characters."""
        before = db.cms_theme.find_one({"doc_id": "theme_current"})["published"]["colors"]
        try:
            _published(bg="#000} body{display:none} :root{--x:")
            body = _css().text
            assert "display:none" not in body
            assert body.count("{") == body.count("}")
        finally:
            _published(bg=before["bg"])


class TestFreshness:

    def test_an_unchanged_theme_revalidates_cheaply(self):
        etag = _css().headers["etag"]
        r = requests.get(f"{API}/cms/theme.css", headers={"If-None-Match": etag}, timeout=TIMEOUT)
        assert r.status_code == 304

    def test_publishing_invalidates_it_immediately(self):
        before = db.cms_theme.find_one({"doc_id": "theme_current"})["published"]["colors"]
        try:
            etag = _css().headers["etag"]
            _published(accent="#ABCDEF")
            # A stale palette served from cache would be a worse bug than the flash this
            # endpoint replaces, so the same conditional request must now miss.
            r = requests.get(f"{API}/cms/theme.css", headers={"If-None-Match": etag}, timeout=TIMEOUT)
            assert r.status_code == 200
            assert "--accent: #ABCDEF;" in r.text
        finally:
            _published(accent=before["accent"])
