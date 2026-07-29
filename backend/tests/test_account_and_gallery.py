"""
The mandatory-profile / verified-email account rules, and the sitewide gallery's
title + slug.

Covers:
  * Name, surname, email and phone are all required to register, and the phone is
    normalized rather than stored as typed.
  * Registration issues NO session — an account is inert until the emailed link is
    clicked — and login says so specifically rather than "invalid credentials".
  * PATCH /auth/profile is also the "finish your profile" route: it can fill a blank
    but can never empty one.
  * A profile-incomplete or unverified account cannot create a reservation, whatever
    the UI does.
  * The sitewide gallery's title/slug round-trip, and the slug is slugified.
  * Ticking the newsletter box actually puts the address on the subscriber list — it
    used to set a consent flag that no admin screen could see.

Registration is rate-limited to 5 per 5 minutes per IP, so this module registers
exactly ONCE (the module-scoped fixture below) and derives everything else from
mint_user, which writes the identity straight to the database.
"""
import uuid

import pytest
import requests

from support import (API, db, mint_user, patient, TEST_EMAIL_DOMAIN, TIMEOUT,
                     registered_user_doc, _created_user_ids)

PASSWORD = "pytest-passw0rd"


def _new_email():
    return f"pytest-{uuid.uuid4().hex[:12]}@{TEST_EMAIL_DOMAIN}"


def _skip_if_rate_limited(r, what):
    """/auth/register and /auth/login are rate-limited per IP, and this suite runs
    every test from one IP — TestRateLimitAuthLogin exists precisely to spend the login
    budget. Their windows are five minutes, too long for `patient` to wait out, so a
    collision is reported as "didn't run" rather than as a failure of the rule under
    test. Anything else is a real result and surfaces normally."""
    if r.status_code == 429:
        pytest.skip(f"{what}: rate-limit budget spent by another test in this window")
    return r


@pytest.fixture(scope="module")
def registered():
    """One real registration, tracked for teardown. Returns (email, response)."""
    email = _new_email()
    r = requests.post(f"{API}/auth/register", json={
        "email": email, "password": PASSWORD, "tos_accepted": True,
        "first_name": "Ana", "last_name": "Popescu", "phone": "+40 721 234 567",
        "news_opt_in": True,
    }, timeout=TIMEOUT)
    _skip_if_rate_limited(r, "registration")
    assert r.status_code == 200, r.text
    doc = registered_user_doc(email)
    if doc.get("user_id"):
        _created_user_ids.append(doc["user_id"])
    return email, r


def _verify_url_for(email):
    """Pull the verification link out of the dev outbox (no mail provider configured
    in a test environment, so send_mail persists the message instead)."""
    msg = db.outbox.find_one({"to": email, "kind": "verify_email"}, sort=[("created_at", -1)])
    assert msg, f"no verification email was sent to {email}"
    return msg["payload"]["verify_url"]


class TestRegistrationRequiresFullIdentity:
    """One registration, followed from signup to a usable session."""

    def test_all_four_fields_are_stored(self, registered):
        email, _ = registered
        doc = registered_user_doc(email)
        assert doc["first_name"] == "Ana"
        assert doc["last_name"] == "Popescu"
        # Display name stays derived from the parts, so the two can't drift.
        assert doc["name"] == "Ana Popescu"
        # Separators the user typed are stripped; the number is stored canonically.
        assert doc["phone"] == "+40721234567"

    def test_registration_issues_no_session(self, registered):
        _email, r = registered
        assert r.json() == {"ok": True, "verification_required": True, "email": _email}
        assert "session_token" not in r.cookies, "an unverified account was handed a session"

    def test_login_is_refused_until_the_link_is_clicked(self, registered):
        email, _ = registered
        r = requests.post(f"{API}/auth/login", json={"email": email, "password": PASSWORD}, timeout=TIMEOUT)
        _skip_if_rate_limited(r, "login")
        assert r.status_code == 403, r.text
        assert r.json()["detail"]["reason"] == "email_not_verified"

    def test_verifying_activates_the_account(self, registered):
        email, _ = registered
        # The link points at the frontend; the token is what the API needs.
        token = _verify_url_for(email).split("token=", 1)[1]
        v = requests.get(f"{API}/auth/verify", params={"token": token}, timeout=TIMEOUT)
        assert v.status_code == 200, v.text
        assert v.json()["profile_complete"] is True

        r = requests.post(f"{API}/auth/login", json={"email": email, "password": PASSWORD}, timeout=TIMEOUT)
        _skip_if_rate_limited(r, "login")
        assert r.status_code == 200, r.text
        assert r.json()["user"]["email_verified"] is True
        assert r.json()["user"]["profile_complete"] is True

    def test_signup_newsletter_optin_reaches_the_subscriber_list(self, registered):
        """The opt-in taken at registration is held pending, then confirmed by the same
        link that activates the account — it must not stay invisible to the admin."""
        email, _ = registered
        sub = db.newsletter_subscriptions.find_one({"email": email})
        assert sub, "registering with news_opt_in created no subscription row"
        assert sub["status"] == "confirmed", sub


class TestRegistrationValidation:
    """Exactly one case, because the rate limiter counts rejected attempts too and the
    budget is five per five minutes for the whole suite. The per-field rules behind it
    are exhaustively unit-tested in test_profile_rules.py."""

    def test_a_missing_mandatory_field_creates_no_account(self):
        body = {"email": _new_email(), "password": PASSWORD, "tos_accepted": True,
                "first_name": "Ana", "last_name": "", "phone": "+40721234567"}
        r = requests.post(f"{API}/auth/register", json=body, timeout=TIMEOUT)
        _skip_if_rate_limited(r, "registration")
        assert r.status_code == 400, r.text
        assert not registered_user_doc(body["email"]), "a rejected registration created an account"


class TestPhoneIsOptionalByDefault:
    """The deployment-level switch, seen from the outside. REQUIRE_PHONE is a server
    setting, so these assert the shipped default (off) rather than trying to toggle it
    against a running process — the flag's own logic is unit-tested."""

    def test_the_signup_form_is_told_the_rule(self):
        r = requests.get(f"{API}/auth/methods", timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        assert r.json()["require_phone"] is False, "this deployment has REQUIRE_PHONE=1 set"

    def test_an_account_without_a_phone_is_complete_and_can_reserve(self):
        headers, user_id, _email = mint_user("user")
        db.users.update_one({"user_id": user_id}, {"$set": {"phone": ""}})

        me = requests.get(f"{API}/auth/me", headers=headers, timeout=TIMEOUT).json()
        assert me["profile_complete"] is True

        # 404 for the made-up event, not the 403 the profile gate would raise.
        r = patient.post(f"{API}/reservations", headers=headers,
                         json={"event_id": "evt_does_not_exist", "wave_id": "w", "quantity": 1})
        assert r.status_code == 404, r.text

    def test_a_typed_number_is_still_validated(self):
        headers, _uid, _email = mint_user("user")
        r = requests.patch(f"{API}/auth/profile", headers=headers,
                           json={"phone": "not-a-number"}, timeout=TIMEOUT)
        assert r.status_code == 400, r.text

    def test_the_phone_can_be_cleared(self):
        headers, uid, _email = mint_user("user")
        r = requests.patch(f"{API}/auth/profile", headers=headers, json={"phone": ""}, timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        assert db.users.find_one({"user_id": uid})["phone"] == ""


class TestProfileCompletion:
    """PATCH /auth/profile doubles as the completion form the frontend gate sends
    OAuth sign-ups to."""

    @pytest.fixture()
    def incomplete(self):
        """An identity missing a surname — what a legacy single-word `name` splits into,
        and what an OAuth provider that sends only a given name leaves behind. (A missing
        phone no longer counts: it is optional unless REQUIRE_PHONE is set.)"""
        headers, user_id, email = mint_user("user")
        db.users.update_one({"user_id": user_id}, {"$set": {"last_name": "", "phone": ""}})
        return headers, user_id, email

    def test_me_reports_an_incomplete_profile(self, incomplete):
        headers, _uid, _email = incomplete
        me = requests.get(f"{API}/auth/me", headers=headers, timeout=TIMEOUT).json()
        assert me["profile_complete"] is False

    def test_completing_it_normalizes_and_derives_the_name(self, incomplete):
        headers, uid, _email = incomplete
        r = requests.patch(f"{API}/auth/profile", headers=headers, timeout=TIMEOUT,
                           json={"first_name": "Ion", "last_name": "Ionescu", "phone": "0721 234 567"})
        assert r.status_code == 200, r.text
        assert r.json()["profile_complete"] is True
        doc = db.users.find_one({"user_id": uid})
        assert doc["phone"] == "0721234567"
        assert doc["name"] == "Ion Ionescu"

    def test_a_mandatory_field_cannot_be_blanked(self, incomplete):
        headers, uid, _email = incomplete
        requests.patch(f"{API}/auth/profile", headers=headers, timeout=TIMEOUT,
                       json={"first_name": "Ion", "last_name": "Ionescu", "phone": "0721234567"})
        r = requests.patch(f"{API}/auth/profile", headers=headers, json={"last_name": ""}, timeout=TIMEOUT)
        assert r.status_code == 400, r.text
        assert db.users.find_one({"user_id": uid})["last_name"] == "Ionescu", "a blank patch emptied the field"

    def test_an_invalid_phone_is_refused(self, incomplete):
        headers, _uid, _email = incomplete
        r = requests.patch(f"{API}/auth/profile", headers=headers, json={"phone": "not-a-number"}, timeout=TIMEOUT)
        assert r.status_code == 400, r.text


class TestReservationGate:
    """The server-side half of the rule. The UI redirects long before this, but a
    session predating the rule — or a direct API caller — reaches checkout without it."""

    def _reserve(self, headers):
        # `patient` waits out a 429: /reservations allows 20 per minute per IP and
        # TestRateLimitReservations deliberately spends that budget from the same IP.
        return patient.post(f"{API}/reservations", headers=headers,
                            json={"event_id": "evt_does_not_exist", "wave_id": "w", "quantity": 1})

    def test_incomplete_profile_cannot_reserve(self):
        headers, user_id, _email = mint_user("user")
        db.users.update_one({"user_id": user_id}, {"$set": {"last_name": ""}})
        r = self._reserve(headers)
        assert r.status_code == 403, r.text
        assert r.json()["detail"]["reason"] == "profile_incomplete"

    def test_unverified_account_cannot_reserve(self):
        headers, user_id, _email = mint_user("user")
        db.users.update_one({"user_id": user_id}, {"$set": {"email_verified_at": None}})
        r = self._reserve(headers)
        assert r.status_code == 403, r.text
        assert r.json()["detail"]["reason"] == "email_not_verified"

    def test_a_complete_account_gets_past_the_gate(self):
        """404 for the made-up event, not 403 — proving the gate let it through rather
        than the reservation happening to fail for the same reason every time."""
        headers, _uid, _email = mint_user("user")
        r = self._reserve(headers)
        assert r.status_code == 404, r.text


class TestResendVerification:
    def test_unknown_address_still_returns_ok(self):
        """No account enumeration: the response is identical either way."""
        r = requests.post(f"{API}/auth/resend-verification",
                          json={"email": f"nobody-{uuid.uuid4().hex[:8]}@{TEST_EMAIL_DOMAIN}"}, timeout=TIMEOUT)
        assert r.status_code in (200, 429), r.text
        if r.status_code == 200:
            assert r.json() == {"ok": True}


class TestGalleryIdentity:
    """Title + slug for the sitewide gallery."""

    @pytest.fixture()
    def restore_settings(self, admin_headers):
        before = requests.get(f"{API}/admin/gallery/settings", headers=admin_headers, timeout=TIMEOUT).json()
        yield
        requests.patch(f"{API}/admin/gallery/settings", headers=admin_headers, json=before, timeout=TIMEOUT)

    def test_defaults_are_served_before_anything_is_configured(self):
        r = requests.get(f"{API}/gallery/settings", timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        assert set(r.json()) == {"title", "slug", "description"}
        assert r.json()["slug"], "the gallery must always have a slug to live at"

    def test_title_and_slug_round_trip(self, admin_headers, restore_settings):
        r = requests.patch(f"{API}/admin/gallery/settings", headers=admin_headers, timeout=TIMEOUT,
                           json={"title": "TEST_Live Documentation", "slug": "TEST Live Documentation!"})
        assert r.status_code == 200, r.text
        # Whatever the editor typed, the stored slug is URL-shaped.
        assert r.json()["slug"] == "test-live-documentation"
        assert r.json()["title"] == "TEST_Live Documentation"

        public = requests.get(f"{API}/gallery/clusters", timeout=TIMEOUT).json()
        assert public["settings"]["slug"] == "test-live-documentation"

    def test_a_blank_title_is_refused(self, admin_headers, restore_settings):
        r = requests.patch(f"{API}/admin/gallery/settings", headers=admin_headers,
                           json={"title": "   "}, timeout=TIMEOUT)
        assert r.status_code == 400, r.text

    def test_settings_are_admin_only(self, user_headers):
        r = requests.patch(f"{API}/admin/gallery/settings", headers=user_headers,
                           json={"title": "TEST_nope"}, timeout=TIMEOUT)
        assert r.status_code == 403, r.text


class TestGalleryItemUrls:
    """Items can be added by URL as well as by upload, so the value is checked."""

    def test_a_pasted_http_url_is_accepted(self, admin_headers):
        r = requests.post(f"{API}/admin/gallery", headers=admin_headers, timeout=TIMEOUT,
                          json={"image_url": "https://example.com/TEST_x.jpg", "caption": "TEST_url_item"})
        assert r.status_code == 200, r.text
        item = r.json()
        # No bytes of ours to thumbnail, so the item stands in as its own thumbnail.
        assert item["thumbnail_url"] == "https://example.com/TEST_x.jpg"
        requests.delete(f"{API}/admin/gallery/{item['gallery_id']}", headers=admin_headers, timeout=TIMEOUT)

    @pytest.mark.parametrize("bad", ["javascript:alert(1)", "data:text/html,<script>", "//evil.example.com/x.jpg", ""])
    def test_non_media_urls_are_refused(self, admin_headers, bad):
        r = requests.post(f"{API}/admin/gallery", headers=admin_headers,
                          json={"image_url": bad}, timeout=TIMEOUT)
        assert r.status_code == 400, f"{bad!r} was accepted"


class TestUploadPermissions:
    """The CMS is an editor-role tool and its image blocks upload through /admin/uploads,
    so that route cannot be admin-only. A 1x1 PNG is the smallest real image bytes that
    Pillow will open for the thumbnail step."""

    # 1x1 transparent PNG.
    PIXEL = bytes.fromhex(
        "89504e470d0a1a0a0000000d494844520000000100000001080600000"
        "01f15c4890000000a49444154789c636000000200010005fe02fea7f6"
        "d1e40000000049454e44ae426082"
    )

    def _upload(self, headers):
        return requests.post(f"{API}/admin/uploads", headers=headers, timeout=TIMEOUT,
                             files={"file": ("TEST_pixel.png", self.PIXEL, "image/png")})

    def test_an_editor_can_upload(self, editor_headers):
        r = self._upload(editor_headers)
        assert r.status_code == 200, r.text
        assert r.json()["media_type"] == "image"

    def test_an_admin_can_upload(self, admin_headers):
        assert self._upload(admin_headers).status_code == 200

    def test_a_plain_user_cannot(self, user_headers):
        assert self._upload(user_headers).status_code == 403


class TestNewsletterConsentIsVisible:
    """The reported gap: ticking Newsletter in Settings set a flag on the user document
    and nothing else, so the address never appeared under Admin → Newsletter."""

    def test_opting_in_creates_a_confirmed_subscription(self, admin_headers):
        headers, _uid, email = mint_user("user")
        try:
            r = requests.post(f"{API}/auth/consents", headers=headers,
                              json={"news_opt_in": True}, timeout=TIMEOUT)
            assert r.status_code == 200, r.text

            listed = requests.get(f"{API}/admin/newsletter", headers=admin_headers, timeout=TIMEOUT).json()
            row = next((s for s in listed if s["email"] == email), None)
            assert row, "an opted-in user is missing from the admin newsletter list"
            # The address was verified before the session existed, so there is nothing
            # for a double opt-in mail to prove.
            assert row["status"] == "confirmed", row
            assert row["source"] == "settings"
        finally:
            db.newsletter_subscriptions.delete_many({"email": email})

    def test_opting_out_marks_the_row_unsubscribed(self):
        headers, _uid, email = mint_user("user")
        try:
            requests.post(f"{API}/auth/consents", headers=headers, json={"news_opt_in": True}, timeout=TIMEOUT)
            requests.post(f"{API}/auth/consents", headers=headers, json={"news_opt_in": False}, timeout=TIMEOUT)
            sub = db.newsletter_subscriptions.find_one({"email": email})
            assert sub and sub["status"] == "unsubscribed", sub
        finally:
            db.newsletter_subscriptions.delete_many({"email": email})
