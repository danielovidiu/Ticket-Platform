"""
How far text sits from the edge of the screen, as a setting rather than a constant.

Some screens curve, and a letter that reaches the glass loses a sliver of itself to the
bend. A photograph loses the same two pixels and nobody can tell, so the rule is
asymmetric: media bleeds, type does not. The distance is one pair of numbers, written
into the render-blocking stylesheet so a page paints at the right inset rather than
shifting sideways once JavaScript arrives.

The clamp is the part worth testing. This value is the gap between every word on the site
and the edge of the display: at 0 the problem it exists to solve comes straight back, and
past 64 the text column collapses on a phone.
"""
import pytest
import requests

from support import API, TIMEOUT

pytestmark = [pytest.mark.integration, pytest.mark.xdist_group("test_text_inset")]


def _css() -> str:
    r = requests.get(f"{API}/cms/theme.css", timeout=TIMEOUT)
    assert r.status_code == 200, r.text
    return r.text


def _set(admin_headers, **patch):
    """Read, merge, PUT — which is what the editor does.

    The endpoint takes the whole settings object rather than a partial one, so sending
    only the changed key would blank the wordmarks and the footer along with it.
    """
    current = requests.get(f"{API}/admin/cms/site", headers=admin_headers, timeout=TIMEOUT).json()
    current.pop("pages", None)  # returned for convenience, not part of the document
    r = requests.put(f"{API}/admin/cms/site", json={**current, **patch},
                     headers=admin_headers, timeout=TIMEOUT)
    assert r.status_code == 200, r.text
    return r.json()


class TestTheSettingReachesTheStylesheet:
    def test_defaults_are_present(self, admin_headers):
        # 16 and 24 are the shipped values, and index.css declares the same pair. They
        # are a default, not a fallback for something missing.
        body = requests.get(f"{API}/admin/cms/site", headers=admin_headers, timeout=TIMEOUT).json()
        assert body["text_inset_sm"] is not None
        assert body["text_inset_lg"] is not None

    def test_a_saved_value_is_emitted_as_css(self, admin_headers):
        try:
            _set(admin_headers, text_inset_sm=20, text_inset_lg=36)
            css = _css()
            assert "--text-inset-sm: 20px;" in css
            assert "--text-inset-lg: 36px;" in css
        finally:
            _set(admin_headers, text_inset_sm=16, text_inset_lg=24)

    def test_zero_is_honoured_rather_than_dropped(self, admin_headers):
        # 0 is a legitimate choice — someone may genuinely want type at the edge — and it
        # is exactly the value a truthiness test would silently discard, leaving the
        # slider at 0 and the site at 16.
        try:
            _set(admin_headers, text_inset_sm=0)
            assert "--text-inset-sm: 0px;" in _css()
        finally:
            _set(admin_headers, text_inset_sm=16)


class TestTheClampHolds:
    @pytest.mark.parametrize("sent,expected", [
        (-40, 0),      # no negative padding; it would pull text off-screen
        (9999, 64),    # a column with nothing left in it
    ])
    def test_out_of_range_is_clamped_not_refused(self, admin_headers, sent, expected):
        # Clamped rather than rejected: this arrives from a slider that cannot produce
        # these, so a value out of range means a hand-edited request, and the useful
        # answer is the nearest sane one rather than a 4xx nobody sees.
        try:
            body = _set(admin_headers, text_inset_sm=sent)
            assert body["text_inset_sm"] == expected
            assert f"--text-inset-sm: {expected}px;" in _css()
        finally:
            _set(admin_headers, text_inset_sm=16)

    def test_junk_does_not_land_in_the_stylesheet(self, admin_headers):
        # Whatever happens to the value, it must not reach a stylesheet every visitor
        # loads as something that could end the rule early.
        try:
            _set(admin_headers, text_inset_sm="16px; } body { display:none")
        except AssertionError:
            pass  # refused outright is a fine answer; the stylesheet is what matters
        css = _css()
        assert "display:none" not in css
        _set(admin_headers, text_inset_sm=16)

    def test_it_needs_an_admin(self):
        r = requests.put(f"{API}/admin/cms/site", json={"text_inset_sm": 40}, timeout=TIMEOUT)
        assert r.status_code in (401, 403), r.text
