"""
Audit M7, M9 and M12, over HTTP — what the API actually accepts.

`test_input_bounds.py` asserts the models are configured correctly. This asserts the
configuration reaches the wire, which is a different claim: a ceiling that no request path
enforces is a comment.
"""
import uuid

import pytest
import requests

from support import API, TIMEOUT, db, mint_user, skip_if_rate_limited
import server
from models_base import DEFAULT_STR_MAX, LONG_TEXT, MAX_JSON_DOC_BYTES


# Runs on one worker, in order: the module's own xdist group. This is what
# `--dist loadgroup` needs in order to behave like the `loadscope` it replaced —
# see pytest.ini.
pytestmark = [pytest.mark.integration, pytest.mark.critical, pytest.mark.xdist_group("test_input_hardening")]  # pins M7, M9, M12


# --- M12: control characters in an address -------------------------------------------

class TestEmailsRejectControlCharacters:
    """The payload used to validate. `strip()` only removes leading and trailing
    whitespace, and the domain check reads `split("@")[-1]` — so
    `a@b.com\\r\\nBcc: attacker@evil.example` was checked against `evil.example`, a
    perfectly good domain, and passed."""

    INJECTIONS = [
        ("crlf", "a@b.com\r\nBcc: attacker@evil.example"),
        ("lf", "a@b.com\nBcc: attacker@evil.example"),
        ("cr", "a@b.com\rX-Header: x"),
        ("tab", "a\tb@example.com"),
        ("nul", "a@b.com\x00"),
    ]

    @pytest.mark.parametrize("label,email", INJECTIONS, ids=[i[0] for i in INJECTIONS])
    def test_the_validator_refuses_it(self, label, email):
        """The matrix runs against the function, not the endpoint.

        `/newsletter` allows 10 a minute for the whole suite and several tests already
        want it; spending six of those on a table of strings would make this file the
        reason another one skips. The validator is a pure function, so the matrix costs
        nothing — and one HTTP test below proves it is actually wired into the route,
        which is the part a unit test cannot claim.
        """
        assert server._valid_email(email) is False, f"{label} accepted: {email!r}"

    def test_an_ordinary_address_still_validates(self):
        assert server._valid_email("someone@example.com") is True
        assert server._valid_email("  someone@example.com  ") is True

    def test_the_endpoint_actually_calls_it(self):
        """The wiring, once. A validator nothing calls is a comment."""
        r = skip_if_rate_limited(
            requests.post(f"{API}/newsletter",
                          json={"email": "a@b.com\r\nBcc: attacker@evil.example"},
                          timeout=TIMEOUT),
            "newsletter")
        assert r.status_code == 400, f"{r.status_code}: {r.text[:120]}"
        assert db.newsletter_subscriptions.find_one(
            {"email": {"$regex": "evil.example"}}) is None, "stored despite the refusal"

    def test_the_mailer_refuses_a_control_character_recipient(self):
        """Second line of defence, at the boundary that builds headers. Reachable from any
        future caller, and the swallow-exceptions contract would otherwise turn a bad
        address into an unexplained non-delivery."""
        import asyncio
        import mailer
        result = asyncio.run(mailer.send_mail("verify_email", "a@b.com\r\nBcc: x@y.z", {}))
        assert result["ok"] is False
        assert result["reason"] == "invalid_recipient"


# --- M7: the client no longer chooses the Stripe redirect ----------------------------

class TestCheckoutRedirectIsServerSide:

    def test_a_hostile_origin_url_is_ignored(self, user_headers):
        """The field is gone from the model, so an extra key is dropped rather than used.
        Asserting on the returned URL is the point — that is what a buyer's browser
        follows after paying."""
        r = requests.post(f"{API}/checkout",
                          json={"reservation_id": "res_does_not_exist",
                                "origin_url": "https://evil.example"},
                          headers=user_headers, timeout=TIMEOUT)
        # No such reservation, so this 404s — but it must not 422 either, which would mean
        # the field is still required, nor echo the attacker's host anywhere.
        assert r.status_code in (400, 404), r.text
        assert "evil.example" not in r.text

    def test_the_field_is_not_required(self, user_headers):
        """If `origin_url` were still declared, omitting it would be a 422."""
        r = requests.post(f"{API}/checkout", json={"reservation_id": "res_does_not_exist"},
                          headers=user_headers, timeout=TIMEOUT)
        assert r.status_code != 422, f"origin_url still required: {r.text[:160]}"


# --- M9: strings and documents have ceilings -----------------------------------------

class TestStringsAreBounded:
    """Asserted against an admin route rather than `/contact`.

    `/contact` allows 5 a minute for the whole suite, and the test that proves the 6th is
    refused lives in `test_security_hardening.py`. Three more callers there is how a
    limiter test starts failing for reasons that have nothing to do with limiters — it
    happened once while writing this. Admin routes carry the same bounded fields and no
    rate limit, so the ceiling can be asserted without competing for a budget.
    """

    @pytest.fixture
    def event(self, admin_headers):
        body = {"title": f"TEST_bounds {uuid.uuid4().hex[:6]}",
                "slug": f"test-bounds-{uuid.uuid4().hex[:8]}",
                "starts_at": "2030-01-01T20:00:00+00:00", "waves": []}
        r = requests.post(f"{API}/admin/events", json=body, headers=admin_headers,
                          timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        e = r.json()
        yield e
        db.events.delete_many({"event_id": e["event_id"]})

    def test_a_string_past_the_default_ceiling_is_refused(self, admin_headers, event):
        r = requests.patch(f"{API}/admin/events/{event['event_id']}",
                           json={"venue": "x" * (DEFAULT_STR_MAX + 1)},
                           headers=admin_headers, timeout=TIMEOUT)
        assert r.status_code == 422, r.text
        assert db.events.find_one({"event_id": event["event_id"]})["venue"] != "x" * (DEFAULT_STR_MAX + 1)

    def test_prose_gets_more_room_but_not_unlimited(self, admin_headers, event):
        """`description` is raised to LONG_TEXT explicitly; the override wins upward, and
        still stops somewhere."""
        ok = requests.patch(f"{API}/admin/events/{event['event_id']}",
                            json={"description": "x" * (DEFAULT_STR_MAX + 1)},
                            headers=admin_headers, timeout=TIMEOUT)
        assert ok.status_code == 200, ok.text

        too_much = requests.patch(f"{API}/admin/events/{event['event_id']}",
                                  json={"description": "x" * (LONG_TEXT + 1)},
                                  headers=admin_headers, timeout=TIMEOUT)
        assert too_much.status_code == 422, too_much.text

    def test_ordinary_content_is_untouched(self, admin_headers, event):
        r = requests.patch(f"{API}/admin/events/{event['event_id']}",
                           json={"venue": "Hala 3", "description": "Doors at 21:00."},
                           headers=admin_headers, timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        assert db.events.find_one({"event_id": event["event_id"]})["venue"] == "Hala 3"


class TestFreeFormDocumentsAreBounded:
    """`str_max_length` reaches typed fields. A CMS draft is `Optional[dict]` — a block
    tree whose shape belongs to the block set, not to Pydantic — so nothing bounded it."""

    @pytest.fixture
    def page(self, editor_headers):
        slug = f"test-bounds-{uuid.uuid4().hex[:8]}"
        r = requests.post(f"{API}/admin/cms/pages",
                          json={"slug": slug, "title": "TEST_bounds", "in_nav": False},
                          headers=editor_headers, timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        p = r.json()
        yield p
        db.cms_pages.delete_many({"page_id": p["page_id"]})

    def test_an_oversized_draft_is_refused(self, editor_headers, page):
        blocks = [{"type": "custom_html", "props": {"html": "x" * (MAX_JSON_DOC_BYTES + 10_000)}}]
        r = requests.patch(f"{API}/admin/cms/pages/{page['page_id']}",
                           json={"draft": {"blocks": blocks}},
                           headers=editor_headers, timeout=TIMEOUT)
        assert r.status_code == 413, f"{r.status_code}: {r.text[:160]}"

        stored = db.cms_pages.find_one({"page_id": page["page_id"]}, {"_id": 0, "draft": 1})
        assert not (stored.get("draft") or {}).get("blocks"), "the oversized draft was stored"

    def test_a_realistic_page_still_saves(self, editor_headers, page):
        """The largest real page is 3.6 KB. A ceiling that catches ordinary content is a
        ceiling that gets raised until it means nothing."""
        blocks = [{"type": "custom_html", "props": {"html": "<p>" + "word " * 500 + "</p>"}}]
        r = requests.patch(f"{API}/admin/cms/pages/{page['page_id']}",
                           json={"draft": {"blocks": blocks}},
                           headers=editor_headers, timeout=TIMEOUT)
        assert r.status_code == 200, r.text
