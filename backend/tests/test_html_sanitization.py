"""
CMS HTML is cleaned on the way into the database, not only on the way out (audit M10).

The sanitizer used to live entirely in the React component that renders the block. That
left the raw string in MongoDB, which meant every consumer that is not that component —
an email, a direct `GET /api/cms/pages`, an export, a future SSR pass — received the
attacker's markup, and the whole guarantee rested on the DOMPurify version in whichever
browser happened to load the page. Not hypothetical: the pinned DOMPurify was 3.4.12,
which has a published bypass.

Asserted through the API and read back out of Mongo, because "what is stored" is the
actual claim. A test that only checked the response body would pass against a server that
sanitized on read and still kept live payloads on disk.
"""
import uuid

import pytest
import requests

from support import API, TIMEOUT, db


pytestmark = [pytest.mark.integration, pytest.mark.critical]  # pins audit M10


PAYLOADS = [
    ("script tag", "<p>hi</p><script>alert(1)</script>", "<script"),
    ("event handler", '<p onclick="steal()">hi</p>', "onclick"),
    ("img onerror", "<img src=x onerror=alert(1)>", "onerror"),
    ("javascript: href", '<a href="javascript:alert(1)">x</a>', "javascript:"),
    ("data: href", '<a href="data:text/html,<script>alert(1)</script>">x</a>', "data:text/html"),
    ("iframe", '<iframe src="https://evil.example"></iframe>', "<iframe"),
    ("svg script", "<svg><script>alert(1)</script></svg>", "<script"),
    ("object", '<object data="evil.swf"></object>', "<object"),
    ("form", '<form action="https://evil.example"><input name="p"></form>', "<form"),
    ("style tag", "<style>body{display:none}</style>", "<style"),
]


@pytest.fixture
def page(editor_headers):
    slug = f"test-sanitize-{uuid.uuid4().hex[:8]}"
    r = requests.post(f"{API}/admin/cms/pages",
                      json={"slug": slug, "title": "TEST_sanitize", "in_nav": False},
                      headers=editor_headers, timeout=TIMEOUT)
    assert r.status_code == 200, r.text
    p = r.json()
    yield p
    db.cms_pages.delete_many({"page_id": p["page_id"]})


def _save(headers, page_id, html):
    return requests.patch(
        f"{API}/admin/cms/pages/{page_id}",
        json={"draft": {"blocks": [{"type": "custom_html", "props": {"html": html}}]}},
        headers=headers, timeout=TIMEOUT)


def _stored_draft_html(page_id):
    doc = db.cms_pages.find_one({"page_id": page_id}, {"_id": 0, "draft": 1})
    blocks = (doc.get("draft") or {}).get("blocks") or []
    return blocks[0]["props"]["html"] if blocks else ""


class TestDraftsAreSanitizedOnWrite:

    @pytest.mark.parametrize("label,payload,marker", PAYLOADS,
                             ids=[p[0] for p in PAYLOADS])
    def test_payload_never_reaches_the_database(self, editor_headers, page, label, payload, marker):
        r = _save(editor_headers, page["page_id"], payload)
        assert r.status_code == 200, r.text

        stored = _stored_draft_html(page["page_id"])
        assert marker.lower() not in stored.lower(), (
            f"{label}: {marker!r} survived into the stored draft: {stored!r}"
        )

    def test_ordinary_formatting_survives(self, editor_headers, page):
        """A sanitizer that eats legitimate markup gets turned off, so this matters."""
        html = ('<h2>Line-up</h2><p>Doors at <strong>21:00</strong>, '
                '<em>sharp</em>.</p><ul><li>One</li><li>Two</li></ul>'
                '<a href="https://example.com">tickets</a>')
        r = _save(editor_headers, page["page_id"], html)
        assert r.status_code == 200, r.text

        stored = _stored_draft_html(page["page_id"])
        for fragment in ("<h2>", "<strong>", "<em>", "<ul>", "<li>", 'href="https://example.com"'):
            assert fragment in stored, f"{fragment} was stripped: {stored!r}"

    def test_the_api_returns_what_was_stored(self, editor_headers, page):
        """No sanitize-on-read fig leaf: the response and the database agree."""
        _save(editor_headers, page["page_id"], '<p onclick="x()">hi</p>')
        r = requests.get(f"{API}/admin/cms/pages", headers=editor_headers, timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        served = next(p for p in r.json() if p["page_id"] == page["page_id"])
        assert served["draft"]["blocks"][0]["props"]["html"] == _stored_draft_html(page["page_id"])
        assert "onclick" not in served["draft"]["blocks"][0]["props"]["html"]


class TestPublishIsAlsoAGate:

    def test_publishing_cleans_a_draft_written_before_the_fix(self, editor_headers, page):
        """Drafts stored before M10 was fixed still hold raw markup. Writing one behind
        the API's back is the only way to reproduce that state now."""
        db.cms_pages.update_one(
            {"page_id": page["page_id"]},
            {"$set": {"draft": {"blocks": [
                {"type": "custom_html", "props": {"html": "<p>hi</p><script>alert(1)</script>"}}
            ]}}},
        )
        r = requests.post(f"{API}/admin/cms/pages/{page['page_id']}/publish",
                          headers=editor_headers, timeout=TIMEOUT)
        assert r.status_code == 200, r.text

        doc = db.cms_pages.find_one({"page_id": page["page_id"]}, {"_id": 0, "published": 1})
        published = doc["published"]["blocks"][0]["props"]["html"]
        assert "<script" not in published.lower(), f"published raw: {published!r}"
        assert "<p>hi</p>" in published


class TestSanitizerUnit:
    """Direct calls, for the cases that are awkward to route through the API."""

    def test_non_string_html_is_not_crashed_on(self):
        from sanitize import sanitize_blocks
        blocks = [{"type": "custom_html", "props": {"html": None}},
                  {"type": "spacer", "props": {"height": "4rem"}},
                  "not-a-dict", {"no": "props"}]
        assert sanitize_blocks(blocks) == blocks, "well-formed input was mangled"

    def test_blocks_that_are_not_a_list_pass_through(self):
        from sanitize import sanitize_blocks
        assert sanitize_blocks(None) is None
        assert sanitize_blocks({"a": 1}) == {"a": 1}

    def test_it_keys_on_the_prop_name_not_the_block_type(self):
        """So a new HTML-rendering block is covered the day it is added."""
        from sanitize import sanitize_blocks
        out = sanitize_blocks([{"type": "some_future_block",
                                "props": {"html": "<script>alert(1)</script><b>x</b>"}}])
        assert out[0]["props"]["html"] == "<b>x</b>"

    def test_the_input_is_not_mutated(self):
        from sanitize import sanitize_blocks
        original = [{"type": "custom_html", "props": {"html": "<script>x</script>"}}]
        sanitize_blocks(original)
        assert original[0]["props"]["html"] == "<script>x</script>"
