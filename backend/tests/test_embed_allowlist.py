"""
The embed allowlist and the deployed CSP have to agree (audit M11).

Two independent controls now stand between an editor and an arbitrary framed page:

  * `frontend/src/lib/embeds.js` — the code will only ever emit a src on `EMBED_HOSTS`;
  * `frame-src` in the CSP — the browser will only ever load a frame from those hosts.

They are declared in three different files, in two languages, and neither runtime can
import the other's constant. Drift is silent and lands in exactly one place: production.

  * a host in the code but not the CSP  -> embeds work locally, blocked once deployed;
  * a host in the CSP but not the code  -> a wider frame policy than anything needs.

The second is the one that decays into a real finding. This test is the only thing that
would notice either.
"""
import json
import pathlib
import re

import pytest


# Runs on one worker, in order: the module's own xdist group. This is what
# `--dist loadgroup` needs in order to behave like the `loadscope` it replaced —
# see pytest.ini.
pytestmark = [pytest.mark.critical, pytest.mark.xdist_group("test_embed_allowlist")]  # no server needed; pins audit M11

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
EMBEDS_JS = ROOT / "frontend" / "src" / "lib" / "embeds.js"
VERCEL_JSON = ROOT / "vercel.json"
DEPLOY_VPS = ROOT / "DEPLOY_VPS.md"


def _code_hosts() -> set:
    """`export const EMBED_HOSTS = ["a", "b"];` — read as text, not evaluated."""
    src = EMBEDS_JS.read_text()
    m = re.search(r"export const EMBED_HOSTS\s*=\s*\[(.*?)\]", src, re.S)
    assert m, "EMBED_HOSTS not found in embeds.js"
    return set(re.findall(r'"([^"]+)"', m.group(1)))


def _frame_src(policy: str) -> set:
    m = re.search(r"frame-src ([^;\"]+)", policy)
    assert m, f"no frame-src in policy: {policy[:120]}"
    return {p.strip().removeprefix("https://").removeprefix("http://")
            for p in m.group(1).split() if p.strip() and not p.startswith("'")}


def _vercel_csp() -> str:
    data = json.loads(VERCEL_JSON.read_text())
    for header in data["services"]["frontend"]["headers"][0]["headers"]:
        if header["key"] == "Content-Security-Policy":
            return header["value"]
    pytest.fail("vercel.json frontend headers carry no Content-Security-Policy")


def _nginx_csp() -> str:
    text = DEPLOY_VPS.read_text()
    m = re.search(r'set \$csp "([^"]+)"', text)
    assert m, "DEPLOY_VPS.md nginx block has no $csp definition"
    return m.group(1)


class TestTheAllowlistsAgree:

    def test_the_code_emits_only_hosts_the_vercel_csp_permits(self):
        code, csp = _code_hosts(), _frame_src(_vercel_csp())
        assert code <= csp, (
            f"embeds.js can emit {sorted(code - csp)}, which vercel.json's frame-src "
            "does not allow — those embeds would be blank in production"
        )

    def test_the_code_emits_only_hosts_the_nginx_csp_permits(self):
        code, csp = _code_hosts(), _frame_src(_nginx_csp())
        assert code <= csp, (
            f"embeds.js can emit {sorted(code - csp)}, which the nginx frame-src in "
            "DEPLOY_VPS.md does not allow"
        )

    def test_neither_csp_is_wider_than_the_code_needs(self):
        """A frame-src entry no code path can produce is a permission granted for
        nothing — and the next person to add an embed will assume it is load-bearing."""
        code = _code_hosts()
        for label, policy in (("vercel.json", _vercel_csp()), ("DEPLOY_VPS.md", _nginx_csp())):
            extra = _frame_src(policy) - code
            assert not extra, f"{label} frame-src permits {sorted(extra)}, which nothing emits"

    def test_the_two_deployments_have_the_same_frame_policy(self):
        assert _frame_src(_vercel_csp()) == _frame_src(_nginx_csp()), (
            "Vercel and the VPS disagree about what may be framed; whichever is wider is "
            "the one that matters"
        )

    def test_the_allowlist_is_not_empty_or_a_wildcard(self):
        """Guards the failure mode where the regex matches nothing and every assertion
        above passes vacuously against two empty sets."""
        code = _code_hosts()
        assert code, "EMBED_HOSTS parsed as empty — the regex or the file changed shape"
        assert not any("*" in h for h in code), f"wildcard host in EMBED_HOSTS: {code}"
        for policy in (_vercel_csp(), _nginx_csp()):
            hosts = _frame_src(policy)
            assert hosts, "frame-src parsed as empty"
            assert not any("*" in h for h in hosts), f"wildcard in frame-src: {hosts}"


class TestTheRawPassthroughIsGone:
    """The specific regression: `let src = props.url` with no allowlist."""

    def test_the_component_does_not_frame_an_author_supplied_url(self):
        src = (ROOT / "frontend" / "src" / "components" / "blocks" / "index.jsx").read_text()
        video = src.split("function VideoEmbed", 1)[1].split("\nfunction ", 1)[0]
        assert "src={embed.src}" in video, "the iframe no longer renders the resolved src"
        assert "props.url}" not in video.replace("{props.url}</div>", ""), \
            "VideoEmbed frames props.url again — that is audit M11"

    def test_the_iframe_is_sandboxed(self):
        """Reads the attribute's value, not the surrounding source: the comment above it
        names `allow-top-navigation` to explain its absence, and a grep over the whole
        function matched that and failed. A test that reads prose is testing prose."""
        src = (ROOT / "frontend" / "src" / "components" / "blocks" / "index.jsx").read_text()
        video = src.split("function VideoEmbed", 1)[1].split("\nfunction ", 1)[0]
        m = re.search(r'sandbox="([^"]*)"', video)
        assert m, "the embed iframe lost its sandbox attribute"
        tokens = set(m.group(1).split())
        assert "allow-scripts" in tokens, f"players need scripts: {tokens}"
        for forbidden in ("allow-top-navigation", "allow-top-navigation-by-user-activation",
                          "allow-forms", "allow-modals", "allow-downloads"):
            assert forbidden not in tokens, (
                f"sandbox grants {forbidden}; an embed should not be able to do that "
                f"(current: {sorted(tokens)})"
            )
