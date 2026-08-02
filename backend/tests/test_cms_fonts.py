"""
Uploaded webfonts: POST/GET/DELETE /admin/cms/fonts and the public GET /cms/fonts.

The server never parses a font, it only reads its signature, so these fixtures are a
real signature followed by filler. That is not a shortcut around the test — it is
exactly the surface the endpoint has.

Nothing here touches the theme document. The `in_use` flag is exercised in test_cms.py
instead, alongside the other theme test: both do a read-modify-write of the same draft,
and pytest-xdist's loadscope keeps a single module on a single worker, which is the only
thing making that pair safe from a lost update.

Run: venv/bin/python -m pytest tests/test_cms_fonts.py -q
"""
import contextlib
import uuid

import pytest
import requests

from support import API, bearer, mint_user

# Signature + filler. Every branch of sniff_font_format(), one fixture each.
WOFF2 = b"wOF2" + b"\x00" * 256
WOFF = b"wOFF" + b"\x00" * 256
OTF = b"OTTO" + b"\x00" * 256
TTF = b"\x00\x01\x00\x00" + b"\x00" * 256
TTF_TRUE = b"true" + b"\x00" * 256

# What an upload filter that trusts the client-declared Content-Type lets through.
NOT_A_FONT = b"<html><script>alert(document.cookie)</script></html>"

_tokens = {}


def _b(role):
    if role not in _tokens:
        headers, _uid, _email = mint_user(role)
        _tokens[role] = headers["Authorization"].split(" ", 1)[1]
    return bearer(_tokens[role])


def _family():
    """A family name unique to this test, and legal under FAMILY_RE."""
    return f"Test{uuid.uuid4().hex[:12]}"


# Sentinel, not None: "" is a value these tests deliberately send, and `family or _family()`
# would have quietly swapped it for a valid name and passed.
_UNSET = object()


def _upload(headers, data=WOFF2, *, family=_UNSET, weight=400, style="normal",
            filename="Test-Regular.woff2", content_type="font/woff2"):
    return requests.post(
        f"{API}/admin/cms/fonts",
        files={"file": (filename, data, content_type)},
        data={"family": _family() if family is _UNSET else family,
              "weight": str(weight), "style": style},
        headers=headers, timeout=20,
    )


@pytest.fixture
def cleanup():
    """Delete whatever the test created, whatever the test did."""
    created = []
    yield created
    admin = _b("admin")
    for font_id in created:
        with contextlib.suppress(Exception):
            requests.delete(f"{API}/admin/cms/fonts/{font_id}", headers=admin, timeout=15)


# ---------- Access ----------

def test_public_list_needs_no_auth():
    r = requests.get(f"{API}/cms/fonts", timeout=15)
    assert r.status_code == 200, r.text
    assert isinstance(r.json(), list)


def test_upload_rejects_anonymous():
    r = requests.post(
        f"{API}/admin/cms/fonts",
        files={"file": ("x.woff2", WOFF2, "font/woff2")},
        data={"family": _family(), "weight": "400", "style": "normal"},
        timeout=20,
    )
    assert r.status_code in (401, 403), r.text


def test_upload_rejects_plain_user():
    r = _upload(_b("user"))
    assert r.status_code == 403, r.text


def test_editor_may_upload(cleanup):
    """Editors, not just admins — the CMS is an editor tool and typography lives in it."""
    r = _upload(_b("editor"))
    assert r.status_code == 200, r.text
    cleanup.append(r.json()["font_id"])


# ---------- The format is read off the bytes ----------

@pytest.mark.parametrize("data,expected", [
    (WOFF2, "woff2"), (WOFF, "woff"), (OTF, "otf"), (TTF, "ttf"), (TTF_TRUE, "ttf"),
])
def test_format_comes_from_the_signature(data, expected, cleanup):
    r = _upload(_b("admin"), data, filename="whatever.bin", content_type="application/octet-stream")
    assert r.status_code == 200, r.text
    body = r.json()
    cleanup.append(body["font_id"])
    assert body["format"] == expected


def test_html_declared_as_a_font_is_refused():
    """The hole this closes: the image route picks its type from the client-declared
    Content-Type and writes the bytes verbatim (audit M8). Serving stored HTML from the
    app origin is stored XSS the moment anything stops sending `nosniff`."""
    r = _upload(_b("admin"), NOT_A_FONT, filename="evil.woff2", content_type="font/woff2")
    assert r.status_code == 400, r.text
    assert "font" in r.json()["detail"].lower()


def test_empty_file_is_refused():
    r = _upload(_b("admin"), b"")
    assert r.status_code == 400, r.text


def test_oversize_file_is_refused():
    too_big = b"wOF2" + b"\x00" * (5 * 1024 * 1024 + 1)
    r = _upload(_b("admin"), too_big)
    assert r.status_code == 400, r.text
    assert "5MB" in r.json()["detail"]


# ---------- Metadata validation ----------

@pytest.mark.parametrize("family", [
    '"; } body { display: none } .x {',   # closes the declaration and adds a rule
    'Acme", serif; content: "',           # closes the string
    "Acme<script>",
    "",
    "  ",
    "A" * 65,
    "-LeadingPunctuation",
])
def test_family_names_that_could_escape_the_css_are_refused(family):
    """The family is interpolated into a generated `font-family:` declaration. The
    frontend escapes too, but nothing that could break out should reach it."""
    r = _upload(_b("admin"), family=family)
    assert r.status_code in (400, 422), f"accepted {family!r}: {r.text}"


# "" is absent, not invalid: the field has a Form default, so omitting it legitimately
# means "normal". Only values that are present and wrong belong here.
@pytest.mark.parametrize("style", ["oblique", "italics", "bold"])
def test_bad_style_is_refused(style):
    r = _upload(_b("admin"), style=style)
    assert r.status_code in (400, 422), r.text


@pytest.mark.parametrize("weight", [0, -100, 1001])
def test_weight_out_of_range_is_refused(weight):
    r = _upload(_b("admin"), weight=weight)
    assert r.status_code in (400, 422), r.text


def test_italic_and_weight_are_stored(cleanup):
    fam = _family()
    r = _upload(_b("admin"), family=fam, weight=700, style="italic")
    assert r.status_code == 200, r.text
    body = r.json()
    cleanup.append(body["font_id"])
    assert (body["family"], body["weight"], body["style"]) == (fam, 700, "italic")


# ---------- Listing ----------

def test_upload_appears_in_both_listings(cleanup):
    fam = _family()
    r = _upload(_b("admin"), family=fam)
    assert r.status_code == 200, r.text
    cleanup.append(r.json()["font_id"])

    public = requests.get(f"{API}/cms/fonts", timeout=15).json()
    mine = [f for f in public if f["family"] == fam]
    assert len(mine) == 1, mine
    # Everything the frontend needs to write one @font-face rule, and nothing else.
    assert set(mine[0]) == {"font_id", "family", "weight", "style", "url", "format"}

    admin = requests.get(f"{API}/admin/cms/fonts", headers=_b("admin"), timeout=15).json()
    row = next(f for f in admin if f["family"] == fam)
    assert row["size"] == len(WOFF2)
    assert row["in_use"] is False
    assert row["filename"] == "Test-Regular.woff2"


def test_admin_listing_needs_auth():
    r = requests.get(f"{API}/admin/cms/fonts", timeout=15)
    assert r.status_code in (401, 403), r.text


# ---------- Replace and delete ----------

def test_reuploading_the_same_face_replaces_it(cleanup):
    """Same family+weight+style is the same face. Correcting a wrong file should not
    leave the wrong one behind — and must not trip the unique index."""
    fam = _family()
    first = _upload(_b("admin"), WOFF2, family=fam)
    assert first.status_code == 200, first.text
    cleanup.append(first.json()["font_id"])

    bigger = b"wOFF" + b"\x00" * 999
    second = _upload(_b("admin"), bigger, family=fam, filename="Test-Regular.woff")
    assert second.status_code == 200, second.text
    cleanup.append(second.json()["font_id"])

    rows = [f for f in requests.get(f"{API}/cms/fonts", timeout=15).json() if f["family"] == fam]
    assert len(rows) == 1, rows
    assert rows[0]["format"] == "woff"


def test_the_same_family_can_hold_several_weights(cleanup):
    """A regular and a bold are two files under one name — that is what lets the browser
    pick a real bold instead of smearing the regular."""
    fam = _family()
    for weight in (400, 700):
        r = _upload(_b("admin"), family=fam, weight=weight)
        assert r.status_code == 200, r.text
        cleanup.append(r.json()["font_id"])

    rows = [f for f in requests.get(f"{API}/cms/fonts", timeout=15).json() if f["family"] == fam]
    assert sorted(f["weight"] for f in rows) == [400, 700]


def test_delete_removes_it_from_the_public_list():
    fam = _family()
    font_id = _upload(_b("admin"), family=fam).json()["font_id"]

    r = requests.delete(f"{API}/admin/cms/fonts/{font_id}", headers=_b("admin"), timeout=15)
    assert r.status_code == 200, r.text

    rows = [f for f in requests.get(f"{API}/cms/fonts", timeout=15).json() if f["family"] == fam]
    assert rows == []


def test_delete_unknown_font_is_404():
    r = requests.delete(f"{API}/admin/cms/fonts/fnt_nope", headers=_b("admin"), timeout=15)
    assert r.status_code == 404, r.text


def test_delete_rejects_plain_user(cleanup):
    font_id = _upload(_b("admin")).json()["font_id"]
    cleanup.append(font_id)
    r = requests.delete(f"{API}/admin/cms/fonts/{font_id}", headers=_b("user"), timeout=15)
    assert r.status_code == 403, r.text
