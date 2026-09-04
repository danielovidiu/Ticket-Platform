"""
What an image WEIGHS once it is stored, which is a different question from whether it
was safe to accept.

test_upload_hardening.py owns the second question — the polyglot, the mismatched
declaration, the size cap. This file owns the first, and it exists because of a number
measured on the deployed homepage: a single photograph, stored as a PNG, was 2,252,542
bytes. The 640px thumbnail of the same picture, sitting beside it in the same bucket,
was 60,342. The whole page shipped 2,548,181 bytes of images to draw boxes no wider than
1272 CSS pixels.

Two causes, both fixed in `_reencode_image`:

  * PNG is lossless, so a photograph saved as one is enormous no matter how hard
    `optimize=True` works. The old code re-encoded PNG to PNG, spending CPU to keep a
    format choice that was wrong for the content.
  * nothing downscaled. lib/imagePipeline.js caps the long edge at 2560 "larger than any
    slot on this site renders" — but only for files over 3.5 MB, because its real job
    there is dodging the serverless body limit. A 3 MB 3000x3000 photo slipped under that
    threshold and was stored, and served, at full size.

These call `_reencode_image` directly rather than driving the endpoint. The endpoint is
covered next door; what is asserted here is the encoder's own arithmetic, and going
through HTTP would only add an upload's worth of latency to each case.
"""
import io

import pytest
import requests
from PIL import Image

import server
from support import API, db

pytestmark = [pytest.mark.xdist_group("test_image_storage")]


def _photo(size, mode="RGB", seed=12345):
    """Something that compresses like a photograph rather than like flat colour.

    The fixture matters more than it looks. Two obvious choices both lie:

      * a flat fill or a clean gradient is stored by PNG in almost no bytes, and a test
        built on one shows PNG BEATING WebP — the opposite of what real content does.
        A first draft of this file used a periodic ripple and measured 2.4% off, because
        PNG's row filters predict a repeating pattern almost perfectly.
      * pure per-pixel noise is incompressible for everyone and overstates the win.

    A gradient carrying irregular, deterministic noise is what a camera actually produces:
    broad smooth areas with fine detail that does not repeat. It measures ~82% off here,
    against 91.7% for the real 1500x1000 hero taken off the deployed site.

    Seeded rather than `random` so a failure is reproducible; the generator is a plain LCG
    so the numbers do not move if Python's RNG changes.
    """
    width, height = size
    img = Image.new(mode, size)
    px = img.load()
    state = seed
    for y in range(height):
        for x in range(width):
            state = (1103515245 * state + 12345) & 0x7FFFFFFF
            noise = (state >> 16) % 40 - 20
            base = ((x * 200) // width + 30,
                    (y * 200) // height + 30,
                    ((x + y) * 200) // (width + height) + 30)
            rgb = tuple(max(0, min(255, c + noise)) for c in base)
            # A real alpha RAMP in RGBA mode, not a constant 255. A fully opaque alpha
            # channel carries no information and Pillow drops it on the way into WebP —
            # so a fixture that used one would assert nothing about transparency while
            # appearing to.
            px[x, y] = rgb + ((x * 255) // width,) if mode == "RGBA" else rgb
    return img


def _encoded(img, fmt, **kw):
    buf = io.BytesIO()
    img.save(buf, fmt, **kw)
    return buf.getvalue()


def _dims(data):
    return Image.open(io.BytesIO(data)).size


class TestAPhotographIsNotStoredAsAPng:

    def test_png_in_webp_out(self):
        raw = _encoded(_photo((900, 600)), "PNG")
        out, content_type, ext = server._reencode_image(raw, "image/png")
        assert content_type == "image/webp"
        assert ext == ".webp"
        assert Image.open(io.BytesIO(out)).format == "WEBP"

    def test_and_it_is_dramatically_smaller(self):
        """The saving that motivated this. On the real 1500x1000 hero from the deployed
        site the same conversion took 2,252,542 bytes to 187,958 — 91.7% — with the
        dimensions untouched, so none of it came from throwing pixels away."""
        raw = _encoded(_photo((900, 600)), "PNG")
        out, _, _ = server._reencode_image(raw, "image/png")
        assert _dims(out) == (900, 600), "the saving must not come from dropping pixels"
        assert len(out) < len(raw) / 2, (
            f"PNG {len(raw):,} -> WebP {len(out):,}; expected at least half off"
        )

    def test_transparency_survives_it(self):
        """WebP and not JPEG precisely because of this: a logo with an alpha channel
        handed to JPEG comes back with the transparency filled in black.

        Asserted on the PIXELS rather than on the mode. Pillow reports a mode, but a
        lossy WebP of an image whose alpha happens to be uniform is stored without an
        alpha channel at all — correctly — so a mode check passes or fails for reasons
        that have nothing to do with whether transparency was preserved.
        """
        raw = _encoded(_photo((240, 240), mode="RGBA"), "PNG")
        out, _, _ = server._reencode_image(raw, "image/png")

        after = Image.open(io.BytesIO(out)).convert("RGBA")
        assert after.getpixel((0, 120))[3] < 32, "the transparent edge came back opaque"
        assert after.getpixel((239, 120))[3] > 223, "the opaque edge came back transparent"

    def test_a_jpeg_stays_a_jpeg(self):
        """Nothing is gained by re-containering a photograph that already chose a lossy
        format, and a second lossy pass is quality spent for nothing."""
        raw = _encoded(_photo((900, 600)), "JPEG", quality=90)
        out, content_type, ext = server._reencode_image(raw, "image/jpeg")
        assert (content_type, ext) == ("image/jpeg", ".jpg")


class TestNothingIsStoredLargerThanTheSiteRenders:

    def test_the_long_edge_is_capped(self):
        raw = _encoded(_photo((3000, 3000)), "JPEG", quality=90)
        out, _, _ = server._reencode_image(raw, "image/jpeg")
        assert max(_dims(out)) == server.STORED_IMAGE_MAX_EDGE

    def test_the_aspect_ratio_is_kept(self):
        raw = _encoded(_photo((4000, 1000)), "JPEG", quality=90)
        out, _, _ = server._reencode_image(raw, "image/jpeg")
        width, height = _dims(out)
        assert width == server.STORED_IMAGE_MAX_EDGE
        # 4:1 in, 4:1 out — allow a pixel of rounding.
        assert abs(width / height - 4.0) < 0.01

    def test_a_smaller_image_is_never_enlarged(self):
        """Upscaling would spend bytes inventing detail that was never captured."""
        raw = _encoded(_photo((320, 200)), "JPEG", quality=90)
        out, _, _ = server._reencode_image(raw, "image/jpeg")
        assert _dims(out) == (320, 200)

    def test_an_image_exactly_at_the_cap_is_left_alone(self):
        edge = server.STORED_IMAGE_MAX_EDGE
        raw = _encoded(_photo((edge, edge // 2)), "JPEG", quality=90)
        out, _, _ = server._reencode_image(raw, "image/jpeg")
        assert _dims(out) == (edge, edge // 2)


class TestAnimationIsLeftAlone:

    def test_an_animated_gif_keeps_its_frames_and_its_format(self):
        """Resizing one frame of an animation and calling it done would silently flatten
        it, which is the same reason lib/imagePipeline.js excludes GIF client-side."""
        # Different seeds, deliberately: identical frames are collapsed to one by the
        # GIF encoder, and the resulting file is not animated at all — which would make
        # this test pass through the wrong branch and assert nothing.
        frames = [_photo((80, 60), seed=s) for s in (1, 2, 3)]
        buf = io.BytesIO()
        frames[0].save(buf, "GIF", save_all=True, append_images=frames[1:], duration=100)
        raw = buf.getvalue()

        out, content_type, ext = server._reencode_image(raw, "image/gif")
        assert (content_type, ext) == ("image/gif", ".gif")
        after = Image.open(io.BytesIO(out))
        assert getattr(after, "is_animated", False)
        assert after.n_frames == 3


class TestTheEndpointStoresWhatTheEncoderProduces:
    """The unit cases above pin the encoder. This one pins the wiring: that /admin/uploads
    actually returns the re-encoded object rather than the bytes it was handed, and that
    the thumbnail is still generated from them."""

    def _upload(self, headers, data, filename, content_type):
        return requests.post(f"{API}/admin/uploads",
                             files={"file": (filename, data, content_type)},
                             headers=headers, timeout=60)

    def test_a_png_photograph_is_stored_as_webp(self, admin_headers):
        raw = _encoded(_photo((1200, 800)), "PNG")
        r = self._upload(admin_headers, raw, "hero.png", "image/png")
        assert r.status_code == 200, f"{r.status_code}: {r.text[:200]}"
        body = r.json()
        try:
            assert body["url"].endswith(".webp"), body["url"]
            # The thumbnail is a separate object and still a JPEG — unchanged behaviour,
            # asserted so this does not quietly disappear with the format change.
            assert body["thumbnail_url"].endswith("_thumb.jpg"), body["thumbnail_url"]
            assert body["thumbnail_url"] != body["url"]
        finally:
            for key in ("url", "thumbnail_url"):
                if body.get(key):
                    db.gallery.delete_many({"image_url": body[key]})

    def test_an_oversized_upload_comes_back_capped(self, admin_headers):
        raw = _encoded(_photo((3200, 1600)), "JPEG", quality=90)
        r = self._upload(admin_headers, raw, "wide.jpg", "image/jpeg")
        assert r.status_code == 200, f"{r.status_code}: {r.text[:200]}"
        body = r.json()
        try:
            fetched = requests.get(body["url"] if body["url"].startswith("http")
                                   else f"{API.rsplit('/api', 1)[0]}{body['url']}", timeout=30)
            assert fetched.status_code == 200
            assert max(Image.open(io.BytesIO(fetched.content)).size) == \
                server.STORED_IMAGE_MAX_EDGE
        finally:
            for key in ("url", "thumbnail_url"):
                if body.get(key):
                    db.gallery.delete_many({"image_url": body[key]})
