"""
Deployment configuration that security depends on, asserted rather than described.

None of this is application code, so none of it is covered by anything else — and all of
it is the kind of thing that gets edited during an incident at 2am and never put back.
Three files have to agree: `craco.config.js` (what the build emits), `vercel.json` (how
Vercel serves it) and the nginx block in `DEPLOY_VPS.md` (how the VPS serves it).

SECURITY.md describes these invariants in prose. Prose does not fail a build.
"""
import json
import pathlib
import re

import pytest


pytestmark = pytest.mark.critical  # config-only; needs no server

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
CRACO = ROOT / "frontend" / "craco.config.js"
VERCEL_JSON = ROOT / "vercel.json"
DEPLOY_VPS = ROOT / "DEPLOY_VPS.md"


def _nginx_block() -> str:
    blocks = re.findall(r"```nginx\n(.*?)```", DEPLOY_VPS.read_text(), re.S)
    assert blocks, "no nginx block in DEPLOY_VPS.md"
    return blocks[0]


def _vercel_headers() -> dict:
    data = json.loads(VERCEL_JSON.read_text())
    entries = data["services"]["frontend"]["headers"][0]["headers"]
    return {h["key"]: h["value"] for h in entries}


class TestSourceMapsAreNotShipped:
    """3.9 MB of maps against 912 KB of app, consumed by nothing — there is no error
    tracker wired up. Not a secrecy claim (the bundle carries no secrets, verified
    separately); it removes a free, readable map of the attack surface."""

    def test_the_production_build_disables_devtool(self):
        src = CRACO.read_text()
        assert re.search(r'mode\s*===\s*"production"', src), \
            "craco.config.js no longer branches on a production build"
        assert re.search(r"devtool\s*=\s*false", src), \
            "craco.config.js no longer disables source maps (webpackConfig.devtool = false)"

    def test_nginx_refuses_to_serve_them_whatever_is_on_disk(self):
        """The backstop for a build that predates the flag or gets configured around it."""
        block = _nginx_block()
        m = re.search(r"location\s+~\s+\\\.map\$\s*\{([^}]*)\}", block)
        assert m, "the nginx block no longer refuses .map requests"
        assert "return 404" in m.group(1), f"the .map location does not 404: {m.group(1)!r}"


class TestTheThreeHeaderCopiesAgree:
    """The FastAPI middleware covers API responses. The page an attacker frames is the
    SPA, served by Vercel or nginx, which the app never sees — so the same headers are
    declared twice more. Nothing but this test notices when one copy drifts."""

    REQUIRED = ["X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy",
                "Strict-Transport-Security", "Content-Security-Policy"]

    @pytest.mark.parametrize("header", REQUIRED)
    def test_vercel_sets_it(self, header):
        assert header in _vercel_headers(), f"vercel.json does not set {header}"

    @pytest.mark.parametrize("header", REQUIRED)
    def test_nginx_sets_it(self, header):
        block = _nginx_block()
        assert re.search(rf'add_header\s+{re.escape(header)}\b', block) or (
            header == "Content-Security-Policy" and "$csp" in block
        ), f"the nginx block does not set {header}"

    def test_clickjacking_is_denied_on_both(self):
        assert _vercel_headers()["X-Frame-Options"] == "DENY"
        assert re.search(r'add_header\s+X-Frame-Options\s+"DENY"', _nginx_block())

    def test_nginx_marks_them_always_so_error_pages_keep_them(self):
        """Without `always`, nginx drops add_header on 4xx/5xx — and a framed 404 is
        still a framed page."""
        for line in _nginx_block().splitlines():
            stripped = line.split("#", 1)[0].strip()
            if stripped.startswith("add_header"):
                assert stripped.rstrip(";").endswith("always"), \
                    f"header is not marked `always`, so error responses lose it: {stripped}"

    def test_the_uploads_location_restates_them(self):
        """`add_header` inside a location REPLACES the inherited set. The uploads block
        serves user-supplied bytes and must not silently lose nosniff."""
        block = _nginx_block()
        m = re.search(r"location\s+/uploads/\s*\{(.*?)\n    \}", block, re.S)
        assert m, "no /uploads/ location found in the nginx block"
        body = m.group(1)
        for header in ("X-Content-Type-Options", "Content-Security-Policy"):
            assert header in body, (
                f"/uploads/ declares add_header but not {header} — declaring any header "
                "in a location drops every inherited one"
            )
        assert "sandbox" in body, "the uploads CSP lost its sandbox"


class TestScriptSrcStaysStrict:

    def test_no_unsafe_inline_in_script_src(self):
        """Works only because the CRA build emits no inline scripts. If that changes,
        fix the build rather than relaxing this."""
        for label, csp in (("vercel.json", _vercel_headers()["Content-Security-Policy"]),
                           ("DEPLOY_VPS.md", _nginx_block())):
            m = re.search(r"script-src ([^;\"]+)", csp)
            assert m, f"{label} has no script-src"
            assert "unsafe-inline" not in m.group(1), \
                f"{label} script-src allows unsafe-inline: {m.group(1)}"
            assert "unsafe-eval" not in m.group(1), \
                f"{label} script-src allows unsafe-eval: {m.group(1)}"
