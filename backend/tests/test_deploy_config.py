"""
Deployment configuration that security depends on, asserted rather than described.

None of this is application code, so none of it is covered by anything else — and all of
it is the kind of thing that gets edited during an incident at 2am and never put back.
Three files have to agree: `vite.config.mjs` (what the build emits), `vercel.json` (how
Vercel serves it) and the nginx block in `DEPLOY_VPS.md` (how the VPS serves it).

SECURITY.md describes these invariants in prose. Prose does not fail a build.
"""
import json
import pathlib
import re

import pytest


# Runs on one worker, in order: the module's own xdist group. This is what
# `--dist loadgroup` needs in order to behave like the `loadscope` it replaced —
# see pytest.ini.
pytestmark = [pytest.mark.critical, pytest.mark.xdist_group("test_deploy_config")]  # config-only; needs no server

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
VITE_CONFIG = ROOT / "frontend" / "vite.config.mjs"
VERCEL_JSON = ROOT / "vercel.json"
DEPLOY_VPS = ROOT / "DEPLOY_VPS.md"
LAUNCH_JSON = ROOT / ".claude" / "launch.json"


def _nginx_block() -> str:
    blocks = re.findall(r"```nginx\n(.*?)```", DEPLOY_VPS.read_text(), re.S)
    assert blocks, "no nginx block in DEPLOY_VPS.md"
    return blocks[0]


def _launch_config(name: str) -> dict:
    data = json.loads(LAUNCH_JSON.read_text())
    for cfg in data["configurations"]:
        if cfg["name"] == name:
            return cfg
    raise AssertionError(f"no {name!r} configuration in .claude/launch.json")


def _vercel_headers() -> dict:
    data = json.loads(VERCEL_JSON.read_text())
    entries = data["services"]["frontend"]["headers"][0]["headers"]
    return {h["key"]: h["value"] for h in entries}


class TestSourceMapsAreNotShipped:
    """3.9 MB of maps against 912 KB of app, consumed by nothing — there is no error
    tracker wired up. Not a secrecy claim (the bundle carries no secrets, verified
    separately); it removes a free, readable map of the attack surface."""

    def test_the_production_build_emits_no_source_maps(self):
        """Was a craco assertion on `webpackConfig.devtool = false`. Vite states the same
        thing declaratively and for every build rather than behind a mode check, so there
        is no branch left to assert -- only the setting."""
        src = VITE_CONFIG.read_text()
        assert re.search(r"sourcemap\s*:\s*false", src), \
            "vite.config.mjs no longer sets build.sourcemap = false, so a production " \
            "build would publish source maps again"

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


class TestTheProxyOverwritesTheForwardedHeader:
    """The single line audit H1 now rests on.

    uvicorn is told to trust `X-Forwarded-For` from 127.0.0.1, which is safe *only*
    because nginx replaces the header with the real peer. The usual copy-paste is
    `$proxy_add_x_forwarded_for`, which APPENDS — and then the left-most entry is whatever
    the caller sent, uvicorn believes it, and every rate limit is bypassable again. One
    variable name is the whole difference, and nothing but this test would notice.
    """

    def test_x_forwarded_for_is_set_not_appended(self):
        block = _nginx_block()
        m = re.search(r"proxy_set_header\s+X-Forwarded-For\s+(\S+);", block)
        assert m, "the nginx block no longer sets X-Forwarded-For at all"
        value = m.group(1)
        assert value == "$remote_addr", (
            f"X-Forwarded-For is set from {value} — it must be $remote_addr. "
            "$proxy_add_x_forwarded_for appends the caller's value, which reopens H1."
        )

    def test_x_real_ip_is_the_peer(self):
        block = _nginx_block()
        m = re.search(r"proxy_set_header\s+X-Real-IP\s+(\S+);", block)
        assert m, "the nginx block no longer sets X-Real-IP"
        assert m.group(1) == "$remote_addr", f"X-Real-IP is set from {m.group(1)}"

    def test_forwarded_allow_ips_is_documented_as_required(self):
        text = DEPLOY_VPS.read_text()
        assert "FORWARDED_ALLOW_IPS" in text, (
            "DEPLOY_VPS.md no longer mentions FORWARDED_ALLOW_IPS — the app will refuse "
            "to boot in production and the runbook will not say why"
        )


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


class TestDevLaunchConfigDoesNotReopenH1:
    """The dev launcher is the one start path that is not a deployment, and it is the
    one where H1 was actually reproduced. `uvicorn` defaults to
    `forwarded_allow_ips="127.0.0.1"`, so a laptop server rewrites
    `request.client.host` from whatever `X-Forwarded-For` the caller sent — and the
    app only warns here rather than refusing, so nothing else catches it.

    That also makes this a prerequisite for the suite: the H1 regression in
    test_security_hardening.py rotates the header against a running server, and it can
    only pass against a server started the way this config starts one.

    Either spelling disables the trust — uvicorn reads `FORWARDED_ALLOW_IPS` from the
    environment when the flag is absent, and reads it as `is None`, so an empty value
    means "trust nobody" rather than falling back to the default. The config uses the
    environment variable because `server.py` reads the same one: with only the flag,
    the app cannot see it and warns that it is unset while uvicorn is in fact
    configured correctly.
    """

    def test_backend_disables_uvicorns_proxy_header_trust(self):
        cmd = " ".join(_launch_config("backend")["runtimeArgs"])

        flag = re.search(r"--forwarded-allow-ips\s+(\S+)", cmd)
        env = re.search(r"FORWARDED_ALLOW_IPS=(\S*)", cmd)
        assert flag or env, (
            "the backend launch config sets neither FORWARDED_ALLOW_IPS nor "
            "--forwarded-allow-ips, so uvicorn falls back to trusting X-Forwarded-For "
            "from 127.0.0.1 and every rate limit is bypassable locally (audit H1)"
        )

        for label, m in (("--forwarded-allow-ips", flag), ("FORWARDED_ALLOW_IPS", env)):
            if m is None:
                continue
            value = m.group(1).strip("\\")
            assert value in ('""', "''", ""), (
                f"the dev launcher trusts a proxy at {label}={m.group(1)} — nothing "
                'fronts the app locally, so this must be empty (audit H1)'
            )

    def test_ports_match_the_documented_ones(self):
        """The frontend's dev proxy and the test suite's default both assume 8000."""
        assert _launch_config("backend")["port"] == 8000
        assert _launch_config("frontend")["port"] == 3000

    def test_ports_are_pinned_rather_than_reassigned(self):
        """A launcher that quietly moves the backend to 8001 on a busy port leaves the
        frontend and the tests talking to whatever still holds 8000."""
        for name in ("backend", "frontend"):
            assert _launch_config(name).get("autoPort") is False, \
                f"the {name} launch config may be reassigned to another port"


class TestDeepLinksReachTheApp:
    """Only `/index.html` is ever built. `/login`, `/events`, `/shop/:slug` exist solely
    in the router, so any request that reaches a server for one of them — a refresh, a
    shared link, or `startLogin()`'s `window.location.assign("/login?...")` — asks for a
    file that was never emitted. Both servers have to answer those with the shell.

    nginx always said so out loud (`try_files ... /index.html`). Vercel did not: the
    `create-react-app` framework preset supplied the fallback implicitly, so switching
    that one line to `vite` — which builds multi-page sites too, and therefore assumes
    nothing — removed deep-link routing from production without touching a rewrite. The
    two targets diverged silently, and client-side clicks kept working, so it surfaced
    only when someone hard-navigated to Sign In and got a 404 from the edge.
    """

    def test_vercel_serves_the_shell_for_unbuilt_paths(self):
        rewrites = json.loads(VERCEL_JSON.read_text())["services"]["frontend"].get("rewrites")
        assert rewrites, (
            "the frontend service declares no rewrites, so an unmatched path returns "
            "Vercel's 404 — routing into a service is final and does not fall back to "
            "the top-level rules"
        )
        assert any(r.get("destination") == "/index.html" for r in rewrites), (
            f"no rewrite falls back to /index.html: {rewrites!r}"
        )

    def test_nginx_serves_the_shell_for_unbuilt_paths(self):
        """The same invariant on the VPS, where it has always been explicit."""
        block = _nginx_block()
        m = re.search(r"location\s+/\s*\{([^}]*)\}", block)
        assert m, "the nginx block no longer has a `location /`"
        assert "/index.html" in m.group(1), \
            f"`location /` no longer falls back to index.html: {m.group(1)!r}"
