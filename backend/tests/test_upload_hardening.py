"""
Uploads: what the bytes are, not what the client says they are (audit M8 and M9).

The route decided the media type from the client-declared `Content-Type`, wrote the
original bytes verbatim, and checked the size only after buffering the whole body.

None of that was stored XSS on its own — the extension allowlist has no HTML or SVG type,
names are server-generated UUIDs, and `/uploads` is served with `nosniff` and a sandboxed
CSP. The finding was that it depended on all three of those staying true. These tests
remove the dependency by asserting the bytes themselves.
"""
import io
import uuid

import pytest
import requests
from PIL import Image

from support import API, TIMEOUT, db


pytestmark = [pytest.mark.integration, pytest.mark.critical]  # pins M8 + M9


def _png(size=(8, 8), colour=(255, 0, 0)):
    buf = io.BytesIO()
    Image.new("RGB", size, colour).save(buf, "PNG")
    return buf.getvalue()


def _jpeg(size=(8, 8)):
    buf = io.BytesIO()
    Image.new("RGB", size, (0, 128, 255)).save(buf, "JPEG")
    return buf.getvalue()


def _gif_html_polyglot():
    """A file that is a valid GIF *and* contains a live script.

    GIF89a's header carries the canvas dimensions in bytes a browser will also read as
    text, which is the classic trick: `GIF89a` then a comment extension holding markup.
    Pillow decodes it as an image; a browser told to sniff would find the script.
    """
    buf = io.BytesIO()
    Image.new("RGB", (11, 11), (1, 2, 3)).save(buf, "GIF")
    raw = bytearray(buf.getvalue())
    payload = b"<script>alert(document.domain)</script>"
    # A GIF comment extension: 0x21 0xFE, length-prefixed blocks, terminated by 0x00.
    comment = b"\x21\xfe" + bytes([len(payload)]) + payload + b"\x00"
    return bytes(raw[:13]) + comment + bytes(raw[13:])


def _upload(headers, data, filename, content_type, extra=None):
    return requests.post(f"{API}/admin/uploads",
                         files={"file": (filename, data, content_type)},
                         data=extra or {}, headers=headers, timeout=60)


def _cleanup(response):
    if response.status_code == 200:
        body = response.json()
        for key in ("url", "thumbnail_url"):
            if body.get(key):
                db.gallery.delete_many({"image_url": body[key]})


class TestTheBytesMustMatchTheClaim:

    def test_a_png_announced_as_a_jpeg_is_refused(self, admin_headers):
        r = _upload(admin_headers, _png(), "x.jpg", "image/jpeg")
        assert r.status_code == 400, f"{r.status_code}: {r.text[:160]}"
        assert "does not match" in r.text

    def test_html_announced_as_an_image_is_refused(self, admin_headers):
        r = _upload(admin_headers, b"<html><script>alert(1)</script></html>",
                    "x.png", "image/png")
        assert r.status_code == 400, f"{r.status_code}: {r.text[:160]}"
        assert "not a readable image" in r.text

    def test_html_announced_as_a_video_is_refused(self, admin_headers):
        """Video cannot be re-encoded without ffmpeg, so the container header is the
        whole check — which makes it worth asserting rather than assuming."""
        r = _upload(admin_headers, b"<html><script>alert(1)</script></html>",
                    "x.mp4", "video/mp4")
        assert r.status_code == 400, f"{r.status_code}: {r.text[:160]}"
        assert "does not look like" in r.text

    def test_an_empty_file_is_refused(self, admin_headers):
        r = _upload(admin_headers, b"", "x.png", "image/png")
        assert r.status_code == 400, f"{r.status_code}: {r.text[:160]}"


class TestStoredBytesAreOurs:

    def test_a_polyglot_does_not_survive_re_encoding(self, admin_headers):
        """The point of re-encoding rather than merely validating. The upload IS a valid
        GIF, so a check that only asked "does this decode?" would pass it through."""
        polyglot = _gif_html_polyglot()
        assert b"<script>" in polyglot, "the fixture is not actually a polyglot"
        Image.open(io.BytesIO(polyglot)).verify()  # …and it really is a valid image

        r = _upload(admin_headers, polyglot, "x.gif", "image/gif")
        assert r.status_code == 200, r.text
        try:
            stored = requests.get(r.json()["url"] if r.json()["url"].startswith("http")
                                  else f"{API.rsplit('/api', 1)[0]}{r.json()['url']}",
                                  timeout=TIMEOUT)
            assert stored.status_code == 200, stored.status_code
            assert b"<script>" not in stored.content, "the script survived into storage"
            Image.open(io.BytesIO(stored.content)).verify()  # still a usable image
        finally:
            _cleanup(r)

    def test_exif_is_stripped(self, admin_headers):
        """A side effect worth having on its own: photos from a venue carry GPS."""
        buf = io.BytesIO()
        img = Image.new("RGB", (16, 16), (9, 9, 9))
        exif = img.getexif()
        exif[0x010F] = "TEST_CAMERA_MAKE"          # Make
        img.save(buf, "JPEG", exif=exif)
        original = buf.getvalue()
        assert b"TEST_CAMERA_MAKE" in original, "the fixture has no EXIF to strip"

        r = _upload(admin_headers, original, "x.jpg", "image/jpeg")
        assert r.status_code == 200, r.text
        try:
            url = r.json()["url"]
            stored = requests.get(url if url.startswith("http")
                                  else f"{API.rsplit('/api', 1)[0]}{url}", timeout=TIMEOUT)
            assert b"TEST_CAMERA_MAKE" not in stored.content, "EXIF survived the upload"
        finally:
            _cleanup(r)

    def test_an_ordinary_image_still_uploads(self, admin_headers):
        r = _upload(admin_headers, _jpeg(), "x.jpg", "image/jpeg")
        assert r.status_code == 200, r.text
        try:
            body = r.json()
            assert body["media_type"] == "image"
            assert body["url"]
        finally:
            _cleanup(r)

    def test_an_animated_gif_stays_animated(self, admin_headers):
        """Re-encoding must not flatten a format whose whole point is the animation."""
        frames = [Image.new("RGB", (8, 8), c) for c in ((255, 0, 0), (0, 255, 0))]
        buf = io.BytesIO()
        frames[0].save(buf, "GIF", save_all=True, append_images=frames[1:], duration=100)
        r = _upload(admin_headers, buf.getvalue(), "x.gif", "image/gif")
        assert r.status_code == 200, r.text
        try:
            url = r.json()["url"]
            stored = requests.get(url if url.startswith("http")
                                  else f"{API.rsplit('/api', 1)[0]}{url}", timeout=TIMEOUT)
            out = Image.open(io.BytesIO(stored.content))
            assert getattr(out, "is_animated", False), "the animation was flattened"
        finally:
            _cleanup(r)


class TestSizeIsCappedWhileReading:

    def test_an_oversized_upload_is_refused_with_413(self, admin_headers):
        """26 MB against a 25 MB ceiling. The status matters: 413 says "too large",
        where the old 400 said "bad request" for a request that was fine apart from size.
        """
        blob = b"\x89PNG\r\n\x1a\n" + b"\x00" * (26 * 1024 * 1024)
        r = _upload(admin_headers, blob, "x.png", "image/png")
        assert r.status_code == 413, f"{r.status_code}: {r.text[:160]}"

    def test_the_oversized_upload_was_not_stored(self, admin_headers):
        before = db.gallery.count_documents({})
        blob = b"\x89PNG\r\n\x1a\n" + b"\x00" * (26 * 1024 * 1024)
        _upload(admin_headers, blob, "x.png", "image/png")
        assert db.gallery.count_documents({}) == before


class TestAccessIsUnchanged:
    """The route is `require_admin_or_editor` on purpose — the CMS image block uploads
    through it. Hardening the bytes must not quietly change who may send them."""

    def test_an_editor_may_still_upload(self, editor_headers):
        r = _upload(editor_headers, _jpeg(), "x.jpg", "image/jpeg")
        assert r.status_code == 200, r.text
        _cleanup(r)

    def test_a_plain_user_may_not(self, user_headers):
        assert _upload(user_headers, _jpeg(), "x.jpg", "image/jpeg").status_code == 403

    def test_anonymous_may_not(self):
        assert _upload({}, _jpeg(), "x.jpg", "image/jpeg").status_code == 401
