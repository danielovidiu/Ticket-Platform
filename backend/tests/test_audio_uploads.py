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

No server needed: these are the pure functions, called directly.
"""
import pytest

from fastapi import HTTPException

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
