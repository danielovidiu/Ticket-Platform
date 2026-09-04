"""
Audio uploads: the same rule as video, applied to a format that needed a different check.

The CMS's Split + Audio block plays clips uploaded through `/admin/uploads`, so the route
now accepts a third media type. That is a widened attack surface, and the defence is the
one video already has — the bytes are checked against the declared type, because there is
no transcoder here to rebuild them the way images are rebuilt.

Two things about audio made this more than adding a dict entry, and both are asserted:

  * WAV is a RIFF container and so is AVI. Only the form type at offset 8 separates them,
    so the check has to require ALL of a type's signatures rather than any one of them —
    the opposite of `_sniff_video`, where any single match passes.
  * MP3 has no fixed signature at all. A file with metadata opens with an ID3 tag; one
    without opens at an audio frame, whose only constant is eleven set sync bits.

Most of this needs no server — the sniffing and the two allowlists are checked as pure
functions and as text. `TestTheRoundTrip` at the end is the exception and is marked
`integration`: a sniffer that accepts the right bytes proves nothing about whether the
route stores them, serves them back under a type a browser will play, or refuses an
anonymous caller.
"""
import io
import pathlib
import re
import wave

import pytest
import requests

from fastapi import HTTPException

from support import API, TIMEOUT
from server import AUDIO_CONTENT_TYPES, VIDEO_CONTENT_TYPES, IMAGE_CONTENT_TYPES, _sniff_audio


# Runs on one worker, in order: the module's own xdist group. This is what
# `--dist loadgroup` needs in order to behave like the `loadscope` it replaced —
# see pytest.ini.
pytestmark = [pytest.mark.critical, pytest.mark.xdist_group("test_audio_uploads")]  # no server needed


ID3_MP3 = b"ID3\x03\x00\x00\x00\x00\x00\x00" + b"\x00" * 64
BARE_MP3 = b"\xff\xfb\x90\x64" + b"\x00" * 64          # frame sync, no metadata
WAV = b"RIFF\x24\x08\x00\x00WAVEfmt " + b"\x00" * 32
AVI = b"RIFF\x24\x08\x00\x00AVI LIST" + b"\x00" * 32   # a RIFF file that is not a WAV
OGG = b"OggS\x00\x02" + b"\x00" * 64
M4A = b"\x00\x00\x00\x20ftypM4A " + b"\x00" * 48
HTML = b"<html><script>alert(document.domain)</script></html>"


class TestTheBytesMustMatchTheClaim:

    @pytest.mark.parametrize("declared, data", [
        ("audio/mpeg", ID3_MP3),
        ("audio/mpeg", BARE_MP3),
        ("audio/wav", WAV),
        ("audio/x-wav", WAV),
        ("audio/ogg", OGG),
        ("audio/mp4", M4A),
        ("audio/aac", M4A),
    ])
    def test_a_real_file_passes(self, declared, data):
        _sniff_audio(data, declared)   # raises on failure

    @pytest.mark.parametrize("declared", sorted(AUDIO_CONTENT_TYPES))
    def test_markup_announced_as_audio_is_refused(self, declared):
        with pytest.raises(HTTPException) as caught:
            _sniff_audio(HTML, declared)
        assert caught.value.status_code == 400

    def test_an_avi_announced_as_a_wav_is_refused(self):
        """The reason the signature list is ALL rather than ANY. Both files open with
        `RIFF`; a rule that stopped at the first match would take the video."""
        with pytest.raises(HTTPException):
            _sniff_audio(AVI, "audio/wav")

    def test_an_mp3_announced_as_an_ogg_is_refused(self):
        with pytest.raises(HTTPException):
            _sniff_audio(ID3_MP3, "audio/ogg")

    def test_an_empty_file_is_refused(self):
        for declared in AUDIO_CONTENT_TYPES:
            with pytest.raises(HTTPException):
                _sniff_audio(b"", declared)

    def test_a_type_nobody_offers_is_refused_rather_than_waved_through(self):
        """An unknown type has no signatures, and "no signatures" must not read as
        "nothing to check"."""
        with pytest.raises(HTTPException):
            _sniff_audio(ID3_MP3, "audio/flac")


class TestTheTableItself:

    def test_no_extension_is_claimed_by_two_media_types(self):
        """The stored extension follows the declared type, and `/uploads` is served from
        the application origin — an audio type that mapped onto an image extension would
        let a caller choose how the file is later served."""
        audio_ext = set(AUDIO_CONTENT_TYPES.values())
        assert not audio_ext & set(IMAGE_CONTENT_TYPES.values())
        assert not audio_ext & set(VIDEO_CONTENT_TYPES.values())

    def test_every_accepted_type_has_a_check(self):
        # MP3 is handled in code rather than by the table, hence the explicit pass.
        from server import AUDIO_SNIFF
        for declared in AUDIO_CONTENT_TYPES:
            assert declared == "audio/mpeg" or declared in AUDIO_SNIFF, declared

    def test_no_html_or_svg_extension_is_reachable(self):
        for ext in AUDIO_CONTENT_TYPES.values():
            assert ext.lower() not in (".html", ".htm", ".svg", ".xml")


class TestTheDirectRouteAcceptsTheSameThings:
    """The gate on the OTHER route, which no Python test would otherwise reach.

    A large file goes from the browser straight to Blob and never passes the sniffing
    above — the token's `allowedContentTypes` is the whole of the check. That list lives
    in JavaScript, in a separate service, and it was written for video.

    Adding audio here and not there is not a hypothetical: it shipped, and it failed in
    the worst available way. The token refusal carries no HTTP response, so the browser
    read it as a dropped connection, retried three times, and reported "Connection lost"
    — a sentence about the network, for a file the server had simply declined. Local
    uploads went through the Python route and worked, so it only failed once deployed.

    Read as text rather than imported: there is no JavaScript runtime here, and the
    constant is a literal by design.
    """

    ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
    BLOB_UPLOAD_JS = ROOT / "blob-upload" / "index.js"

    def _direct_route_types(self) -> set:
        src = self.BLOB_UPLOAD_JS.read_text()
        m = re.search(r"const ALLOWED_CONTENT_TYPES\s*=\s*\[(.*?)\]", src, re.S)
        assert m, "ALLOWED_CONTENT_TYPES not found in blob-upload/index.js"
        return set(re.findall(r'"([^"]+)"', m.group(1)))

    def test_every_audio_type_the_api_takes_is_also_allowed_a_token(self):
        missing = set(AUDIO_CONTENT_TYPES) - self._direct_route_types()
        assert not missing, (
            f"{sorted(missing)} upload fine through the API and are refused a direct-upload "
            "token — which reaches the editor as 'Connection lost' after three retries")

    def test_video_did_not_lose_anything_on_the_way_past(self):
        assert not set(VIDEO_CONTENT_TYPES) - self._direct_route_types()

    def test_the_direct_route_offers_nothing_the_api_would_refuse(self):
        # The mirror: a type minted a token here but unknown to the API is a file that
        # lands in the store and then cannot be re-uploaded or replaced through the
        # ordinary path. Images are deliberately absent from both — they always go
        # through the API, which re-encodes them.
        extra = self._direct_route_types() - set(AUDIO_CONTENT_TYPES) - set(VIDEO_CONTENT_TYPES)
        assert not extra, f"{sorted(extra)} can be uploaded straight to Blob but the API does not know it"


def _real_wav(seconds=0.25, rate=8000) -> bytes:
    """An actual, playable WAV — written by the standard library, not hand-assembled.

    The header tests above use fixtures short enough to reason about. This is the other
    half: a file a browser would really play, so the round trip is exercised against a
    genuine one rather than against a magic number.
    """
    buf = io.BytesIO()
    with wave.open(buf, "w") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(b"\x00\x01" * int(rate * seconds))
    return buf.getvalue()


def _upload(headers, data, filename, content_type):
    return requests.post(f"{API}/admin/uploads",
                         files={"file": (filename, data, content_type)},
                         headers=headers, timeout=60)


def _fetch(url: str):
    return requests.get(url if url.startswith("http") else f"{API.rsplit('/api', 1)[0]}{url}",
                        timeout=TIMEOUT)


@pytest.mark.integration
class TestTheRoundTrip:
    """The half the unit tests above cannot reach: a file actually going in and coming back.

    Worth its own class because every other check here is a pure function. A sniffer that
    accepts the right bytes proves nothing about whether the route stores them, serves them
    under a type a browser will play, or hands back a URL the block can use.
    """

    def test_a_real_wav_uploads_and_comes_back_playable(self, admin_headers):
        original = _real_wav()
        r = _upload(admin_headers, original, "clip.wav", "audio/wav")
        assert r.status_code == 200, f"{r.status_code}: {r.text[:200]}"
        body = r.json()
        assert body["media_type"] == "audio"
        assert body["url"].endswith(".wav")

        stored = _fetch(body["url"])
        assert stored.status_code == 200, stored.status_code
        # Byte-identical on purpose: audio is NOT re-encoded the way images are — there is
        # no transcoder here — so what a visitor plays is what was uploaded.
        assert stored.content == original, "the stored file is not the file that was sent"
        assert stored.headers.get("content-type", "").startswith("audio/")

    def test_audio_reports_no_poster(self, admin_headers):
        """A sound file has no frame to capture, and saying otherwise would hand a caller
        the audio URL where it expected a picture."""
        r = _upload(admin_headers, _real_wav(), "clip.wav", "audio/wav")
        assert r.status_code == 200, r.text[:200]
        assert r.json()["has_poster"] is False

    def test_markup_announced_as_audio_is_refused_by_the_route(self, admin_headers):
        r = _upload(admin_headers, b"<html><script>alert(1)</script></html>", "x.mp3", "audio/mpeg")
        assert r.status_code == 400, f"{r.status_code}: {r.text[:200]}"

    def test_a_wav_announced_as_an_mp3_is_refused_by_the_route(self, admin_headers):
        r = _upload(admin_headers, _real_wav(), "x.mp3", "audio/mpeg")
        assert r.status_code == 400, f"{r.status_code}: {r.text[:200]}"

    def test_a_format_neither_side_takes_is_named_in_the_refusal(self, admin_headers):
        r = _upload(admin_headers, b"fLaC\x00\x00\x00\x22", "x.flac", "audio/flac")
        assert r.status_code == 400, r.status_code
        # The message has to list what IS accepted; "unsupported" alone sends an editor
        # back to the picker to guess.
        assert "audio" in r.text.lower()

    def test_an_anonymous_caller_cannot_upload(self):
        r = _upload({}, _real_wav(), "clip.wav", "audio/wav")
        assert r.status_code in (401, 403), f"{r.status_code}: {r.text[:200]}"


class TestTheBrowserSideAgreesToo:
    """The other two lists, which no test reached until an `x-m4a` went missing from them.

    Four places have to name the same audio types, in two languages:

      1. `AUDIO_CONTENT_TYPES` here — what the API stores;
      2. `ALLOWED_CONTENT_TYPES` in blob-upload — what gets a direct-upload token;
      3. `ACCEPTED` in lib/uploadAudio.js — what the browser sends at all;
      4. the `accept` attribute on the file input — what the picker will even offer.

    Each is a gate, so the narrowest one wins, and a type missing from any of them is a
    file the editor cannot upload however many of the others allow it. 3 and 4 fail the
    most quietly of the four: the picker simply greys the file out, or the upload is
    refused before a request exists to inspect.

    Read as text for the same reason as the class above: no JavaScript runtime here.
    """

    ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
    UPLOAD_AUDIO_JS = ROOT / "frontend" / "src" / "lib" / "uploadAudio.js"
    TRACKS_FIELD_JSX = ROOT / "frontend" / "src" / "components" / "AudioTracksField.jsx"

    def _client_accepted(self) -> set:
        src = self.UPLOAD_AUDIO_JS.read_text()
        m = re.search(r"const ACCEPTED = new Set\(\[(.*?)\]\)", src, re.S)
        assert m, "ACCEPTED not found in uploadAudio.js"
        return set(re.findall(r'"([^"]+)"', m.group(1)))

    def _picker_accepted(self) -> set:
        src = self.TRACKS_FIELD_JSX.read_text()
        m = re.search(r'accept="(audio/[^"]+)"', src)
        assert m, "audio accept attribute not found in AudioTracksField.jsx"
        return {t.strip() for t in m.group(1).split(",") if t.strip()}

    def test_the_browser_sends_every_type_the_api_stores(self):
        missing = set(AUDIO_CONTENT_TYPES) - self._client_accepted()
        assert not missing, (
            f"{sorted(missing)} are stored fine by the API but refused in the browser "
            "before anything is sent")

    def test_the_picker_offers_every_type_the_api_stores(self):
        missing = set(AUDIO_CONTENT_TYPES) - self._picker_accepted()
        assert not missing, (
            f"{sorted(missing)} would be greyed out in the file picker — the editor cannot "
            "choose a file the server would have taken")

    def test_neither_offers_something_the_api_would_refuse(self):
        for name, listed in (("uploadAudio.js", self._client_accepted()),
                             ("the file picker", self._picker_accepted())):
            extra = listed - set(AUDIO_CONTENT_TYPES)
            assert not extra, f"{sorted(extra)} is offered by {name} and refused by the API"

    def test_the_spellings_browsers_actually_use_are_covered(self):
        # The `x-` forms are the same containers under the names some browsers and encoders
        # report. Safari calls an M4A `audio/x-m4a`; leaving it out refused a file the
        # player handles perfectly well, which is the bug this class was added for.
        for pair in (("audio/mp4", "audio/x-m4a"), ("audio/wav", "audio/x-wav")):
            for spelling in pair:
                assert spelling in AUDIO_CONTENT_TYPES, spelling
                assert spelling in self._client_accepted(), spelling
                assert spelling in self._picker_accepted(), spelling
        # …and both spellings of a container must store the same extension.
        assert AUDIO_CONTENT_TYPES["audio/mp4"] == AUDIO_CONTENT_TYPES["audio/x-m4a"]
        assert AUDIO_CONTENT_TYPES["audio/wav"] == AUDIO_CONTENT_TYPES["audio/x-wav"]


class TestTheStoredFileIsServedAsItself:
    """What `/uploads` says a file IS, which is not the same question as what it holds.

    On local disk the files are served by StaticFiles, which types them from Python's
    `mimetypes` table rather than from anything we recorded at upload time. That table
    answers `audio/mp4a-latm` for `.m4a` — MPEG-4 LATM streaming audio, not an M4A
    container — so a clip went out under a type no browser should trust, and Safari is
    strict enough about media types to refuse it. Every other extension we accept is
    already right, which is why this went unnoticed.

    Found by uploading a real macOS-encoded M4A and reading the response header back.

    Blob storage is unaffected: the content type travels with the object (see
    storage.save), so the CDN already serves what was declared.
    """

    def test_m4a_is_not_typed_as_latm_streaming_audio(self):
        # Importing server applies the correction; assert the outcome, not the call.
        import mimetypes
        import server  # noqa: F401  (import registers the type)
        assert mimetypes.guess_type("clip.m4a")[0] == "audio/mp4"

    @pytest.mark.parametrize("ext, expected", [
        (".mp3", "audio/mpeg"),
        (".ogg", "audio/ogg"),
        (".mp4", "video/mp4"),
        (".webm", "video/webm"),
    ])
    def test_the_rest_were_already_right_and_stay_that_way(self, ext, expected):
        import mimetypes
        import server  # noqa: F401
        assert mimetypes.guess_type(f"clip{ext}")[0] == expected

    def test_every_stored_extension_types_as_its_own_medium(self):
        """The general rule the case above is one instance of: a file stored from an audio
        upload must not be served as something other than audio."""
        import mimetypes
        import server  # noqa: F401
        for content_type, ext in AUDIO_CONTENT_TYPES.items():
            served = mimetypes.guess_type(f"clip{ext}")[0] or ""
            assert served.startswith("audio/"), f"{ext} (from {content_type}) serves as {served}"
