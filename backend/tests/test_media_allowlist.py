"""
The image-host list the CMS warns against and the deployed `img-src` have to agree.

The same problem test_embed_allowlist.py solves for frames, one directive along. The
difference is worth stating, because it changes what this file is FOR:

  * `frame-src` and embeds.js are two controls. embeds.js will only ever emit a src on
    EMBED_HOSTS, and the browser will only ever load one from there.
  * `img-src` and MEDIA_HOSTS are one control and one explanation. The browser refuses
    the image; MEDIA_HOSTS exists so the CMS can tell an editor that BEFORE they save,
    instead of letting them paste a URL, see an empty box on the live page, and have
    nothing to go on.

That makes drift here a usability failure rather than a security one — but a silent
usability failure that only appears in production, on somebody else's machine:

  * a host in `img-src` but not in MEDIA_HOSTS -> the CMS refuses a URL that would in fact
    have worked, and the editor has no way to argue;
  * a host in MEDIA_HOSTS but not in `img-src` -> the CMS blesses a URL the deployed page
    will silently drop, which is the exact failure the warning was added to prevent.

Declared in three files and two languages, and neither runtime can import the other's
constant. This test is the only thing that would notice.

Note that the two DEPLOYMENTS are allowed to differ here, unlike frame-src: a VPS leaves
BLOB_READ_WRITE_TOKEN unset and stores uploads on local disk, so it needs no blob host at
all. That difference is asserted explicitly rather than waved through.
"""
import json
import pathlib
import re

import pytest

pytestmark = [pytest.mark.critical, pytest.mark.xdist_group("test_media_allowlist")]

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
MEDIA_JS = ROOT / "frontend" / "src" / "lib" / "media.js"
VERCEL_JSON = ROOT / "vercel.json"
DEPLOY_VPS = ROOT / "DEPLOY_VPS.md"

# Sources in img-src that are not remote hosts, and so have no counterpart in the code:
# 'self' is this origin (always fine, and the reason a relative path needs no check),
# data: and blob: are locally constructed.
NON_HOST_SOURCES = {"'self'", "data:", "blob:"}


def _code_hosts() -> set:
    """`export const MEDIA_HOSTS = ["a", ".b"];` — read as text, not evaluated.

    A leading dot in the code means "or any subdomain", which the CSP spells `*.`. They
    are normalised to the CSP's spelling so the two sets can be compared directly.
    """
    src = MEDIA_JS.read_text()
    m = re.search(r"export const MEDIA_HOSTS\s*=\s*\[(.*?)\]", src, re.S)
    assert m, "MEDIA_HOSTS not found in media.js"
    return {("*" + h if h.startswith(".") else h)
            for h in re.findall(r'"([^"]+)"', m.group(1))}


def _img_src(policy: str) -> set:
    m = re.search(r"img-src ([^;\"]+)", policy)
    assert m, f"no img-src in policy: {policy[:120]}"
    return {p.strip().removeprefix("https://").removeprefix("http://")
            for p in m.group(1).split()
            if p.strip() and p.strip() not in NON_HOST_SOURCES}


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


class TestTheImageAllowlistsAgree:

    def test_the_cms_blesses_only_hosts_the_vercel_csp_permits(self):
        code, csp = _code_hosts(), _img_src(_vercel_csp())
        assert code <= csp, (
            f"media.js tells editors {sorted(code - csp)} is fine, but vercel.json's "
            "img-src does not allow it — those images would be blank in production, "
            "which is the failure the warning exists to prevent"
        )

    def test_the_cms_does_not_refuse_a_host_the_policy_allows(self):
        """The other direction, and the one that reads as a bug to an editor: being told
        a URL cannot be used when the deployed page would have loaded it happily."""
        code, csp = _code_hosts(), _img_src(_vercel_csp())
        missing = csp - code
        assert not missing, (
            f"vercel.json img-src allows {sorted(missing)}, which media.js would refuse — "
            "the CMS would reject a URL that works"
        )

    def test_the_vps_policy_is_narrower_and_only_where_it_can_afford_to_be(self):
        """The two deployments deliberately DIFFER here, unlike frame-src.

        This started as an equality assertion, which failed, and the config turned out to
        be right: DEPLOY_VPS.md leaves BLOB_READ_WRITE_TOKEN unset, so storage.py writes
        to local disk and every media URL on a VPS is a relative `/uploads/...` path that
        `'self'` already covers. Blob storage hosts in that policy would be a permission
        granted for something the deployment cannot produce.

        So what has to hold is containment, not equality — the VPS may allow less, never
        more. If it ever grows a source Vercel does not have, that is a real finding.
        """
        vps, vercel = _img_src(_nginx_csp()), _img_src(_vercel_csp())
        assert vps <= vercel, (
            f"DEPLOY_VPS.md img-src allows {sorted(vps - vercel)}, which the Vercel policy "
            "does not — the VPS is the wider of the two, which is backwards"
        )

    def test_what_the_vps_leaves_out_is_exactly_the_blob_storage_it_does_not_use(self):
        """Pins the REASON for the difference, so the gap cannot quietly widen.

        Without this, `vps <= vercel` above would keep passing while somebody dropped
        images.unsplash.com from the VPS policy and broke the seeded gallery on it.
        """
        gap = _img_src(_vercel_csp()) - _img_src(_nginx_csp())
        assert gap == {"*.blob.vercel-storage.com"}, (
            f"the VPS image policy now differs from Vercel's by {sorted(gap)}; the only "
            "difference that has a reason is blob storage, which a VPS does not use "
            "(DEPLOY_VPS.md leaves BLOB_READ_WRITE_TOKEN unset)"
        )
