"""
The routes no test named: password reset, the ticket QR image, the newsletter export.

Found by listing every `@api.<method>` against the test corpus. Six routes had no test
that so much as mentioned them, and three of those were the whole password-reset flow —
four security properties (no account enumeration, single-use tokens, a minimum length,
and global logout on reset) resting on nothing but the code being right the day it was
written.

**Why the reset tests call the handler instead of the endpoint.** `/auth/reset-password`
allows 5 requests per 15 minutes per IP, and the whole suite runs from one. Driving these
properties over HTTP would need more than that budget, so the file would have spent its
life skipping — the exact failure mode this batch of work exists to remove. The rate limit
is a *route dependency*, so calling `server.reset_password` directly runs the real handler
against the real database while bypassing only the counter. The endpoint's own wiring is
covered separately, once, over HTTP.

Passwords are asserted against `bcrypt` rather than by logging in: `/auth/login` is
rate-limited too, and a login would prove strictly less than reading the stored hash.
"""
import csv
import io
import uuid
from datetime import datetime, timezone, timedelta

import bcrypt
import pytest
import requests
from motor.motor_asyncio import AsyncIOMotorClient

import support
from support import (API, TIMEOUT, MONGO_URL, DB_NAME, db, mint_user,
                     skip_if_rate_limited, TEST_EMAIL_DOMAIN)

import server


pytestmark = pytest.mark.integration


@pytest.fixture(scope="module")
def anyio_backend():
    """Pin to asyncio; left alone anyio would parametrize over trio, which motor is not."""
    return "asyncio"


@pytest.fixture
async def handler(anyio_backend):
    """`server` with its database bound to the loop this test is running on.

    Motor binds a client to the loop that is current when the client is built, and
    `server` builds its own at import time — outside any loop. Handing the module a
    freshly-made client for the duration of the test is what makes calling its coroutines
    from pytest work at all; everything else about the module is the real thing.
    """
    client = AsyncIOMotorClient(MONGO_URL)
    original = server.db
    server.db = client[DB_NAME]
    try:
        yield server
    finally:
        server.db = original
        client.close()


def _iso(**delta):
    return (datetime.now(timezone.utc) + timedelta(**delta)).isoformat()


def _hash(pw: str) -> str:
    """Same scheme as the server, at the cheapest cost bcrypt allows.

    The cost is stored in the hash, so the server verifies a rounds=4 hash perfectly well
    — and a fixture spending 300ms per identity at rounds=12 would dominate this file.
    """
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt(rounds=4)).decode()


def _verifies(pw: str, hashed: str) -> bool:
    return bcrypt.checkpw(pw.encode(), hashed.encode())


@pytest.fixture
def password_user():
    """An account with a real password, plus the live session a reset has to invalidate."""
    headers, user_id, email = mint_user()
    db.users.update_one({"user_id": user_id},
                        {"$set": {"password_hash": _hash("original-passw0rd")}})
    yield {"headers": headers, "user_id": user_id, "email": email}
    db.outbox.delete_many({"to": email})


def _stored_hash(user_id: str) -> str:
    return db.users.find_one({"user_id": user_id}, {"_id": 0, "password_hash": 1})["password_hash"]


def _mint_reset_token(user_id: str) -> str:
    """Exactly what `forgot_password` mints: the token carries the tail of the password
    hash it was issued against, which is the whole single-use mechanism."""
    return server.make_token("pwd-reset", user_id, {"ph": _stored_hash(user_id)[-12:]})


async def _reset(handler, token: str, new_password: str):
    """Call the handler; return the HTTPException status instead of raising it."""
    body = handler.ResetPasswordIn(token=token, new_password=new_password)
    try:
        return 200, await handler.reset_password(body, handler.Response())
    except handler.HTTPException as e:
        return e.status_code, e.detail


def _reset_mail(email: str):
    return db.outbox.find_one({"to": email, "kind": "password_reset"}, sort=[("created_at", -1)])


# --- POST /auth/forgot-password ------------------------------------------------------
# Over HTTP, sparingly: 5 per 15 minutes per IP is the budget for the whole suite.

class TestForgotPasswordDoesNotEnumerate:
    """The response must be identical whether or not the address has an account. For a
    ticketing platform, "does this person have an account here?" is a question about who
    attends what, and this endpoint would answer it for anyone who asked."""

    def test_an_unknown_address_gets_ok_and_no_mail(self):
        email = f"pytest-nobody-{uuid.uuid4().hex[:10]}@{TEST_EMAIL_DOMAIN}"
        r = skip_if_rate_limited(
            requests.post(f"{API}/auth/forgot-password", json={"email": email}, timeout=TIMEOUT),
            "forgot-password")
        assert r.status_code == 200, r.text
        assert r.json() == {"ok": True}
        assert _reset_mail(email) is None, "a reset mail went to an address with no account"

    def test_an_oauth_only_account_gets_ok_and_no_mail(self):
        """`mint_user` leaves `password_hash` None — a Google/Apple account. There is no
        password to reset, and saying so would leak which sign-in method the address uses."""
        _headers, _uid, email = mint_user()
        r = skip_if_rate_limited(
            requests.post(f"{API}/auth/forgot-password", json={"email": email}, timeout=TIMEOUT),
            "forgot-password")
        assert r.status_code == 200, r.text
        assert r.json() == {"ok": True}
        assert _reset_mail(email) is None
        db.outbox.delete_many({"to": email})

    def test_a_password_account_gets_the_same_reply_and_a_real_link(self, password_user):
        """The end-to-end half: a genuine token, minted by the server, reaching the mail.
        Everything the token then *does* is covered below without spending this budget."""
        r = skip_if_rate_limited(
            requests.post(f"{API}/auth/forgot-password",
                          json={"email": password_user["email"]}, timeout=TIMEOUT),
            "forgot-password")
        assert r.status_code == 200, r.text
        assert r.json() == {"ok": True}, "the reply differs from the unknown-address reply"

        msg = _reset_mail(password_user["email"])
        assert msg, "no reset mail for an account that has a password"
        token = msg["payload"]["reset_url"].split("token=", 1)[1]

        # Read without verifying: SESSION_SECRET is unset in development, so the running
        # server minted this with an ephemeral key that only it holds. Claims are still
        # worth asserting — audience, subject, and the hash binding are what make the
        # token a *reset* token for *this* user, and they are all in the payload.
        import jwt as _jwt
        claims = _jwt.decode(token, options={"verify_signature": False, "verify_aud": False})
        assert claims["aud"] == "ss:pwd-reset"
        assert claims["sub"] == password_user["user_id"]
        assert claims["ph"] == _stored_hash(password_user["user_id"])[-12:], \
            "the token is not bound to the current password hash — single use is broken"


# --- POST /auth/reset-password -------------------------------------------------------

@pytest.mark.anyio
class TestResetPassword:

    async def test_a_valid_token_changes_the_password(self, handler, password_user):
        status, _ = await _reset(handler, _mint_reset_token(password_user["user_id"]),
                                 "brand-new-passw0rd")
        assert status == 200

        stored = _stored_hash(password_user["user_id"])
        assert _verifies("brand-new-passw0rd", stored), "the new password does not verify"
        assert not _verifies("original-passw0rd", stored), "the old password still works"

    async def test_the_token_is_single_use(self, handler, password_user):
        """Not by recording spent tokens — the token carries the tail of the hash it was
        minted against, so any password change invalidates it by construction. Worth
        pinning: that is exactly the kind of cleverness a refactor drops quietly."""
        token = _mint_reset_token(password_user["user_id"])

        assert (await _reset(handler, token, "first-new-passw0rd"))[0] == 200
        status, _ = await _reset(handler, token, "second-new-passw0rd")
        assert status == 400

        assert _verifies("first-new-passw0rd", _stored_hash(password_user["user_id"])), \
            "the replayed token took effect"

    async def test_an_older_token_dies_when_a_newer_one_is_used(self, handler, password_user):
        """Two links in flight — using the newer must kill the older."""
        older = _mint_reset_token(password_user["user_id"])
        newer = _mint_reset_token(password_user["user_id"])

        assert (await _reset(handler, newer, "newer-passw0rd"))[0] == 200
        assert (await _reset(handler, older, "older-passw0rd"))[0] == 400
        assert _verifies("newer-passw0rd", _stored_hash(password_user["user_id"]))

    async def test_a_garbage_token_is_refused(self, handler, password_user):
        status, _ = await _reset(handler, "not-a-real-token", "brand-new-passw0rd")
        assert status == 400
        assert _verifies("original-passw0rd", _stored_hash(password_user["user_id"]))

    async def test_a_token_for_another_purpose_is_refused(self, handler, password_user):
        """Signed by the same key — the audience claim is what separates them. Without
        that check a verification link would double as a password reset."""
        wrong = server.make_token("email-verify", password_user["user_id"])
        status, _ = await _reset(handler, wrong, "brand-new-passw0rd")
        assert status == 400
        assert _verifies("original-passw0rd", _stored_hash(password_user["user_id"]))

    async def test_an_expired_token_is_refused(self, handler, password_user):
        import jwt as _jwt
        expired = _jwt.encode(
            {"aud": "ss:pwd-reset", "sub": password_user["user_id"],
             "ph": _stored_hash(password_user["user_id"])[-12:],
             "iat": datetime.now(timezone.utc) - timedelta(hours=3),
             "exp": datetime.now(timezone.utc) - timedelta(hours=2),
             "jti": uuid.uuid4().hex},
            server.SESSION_SECRET, algorithm="HS256")
        status, _ = await _reset(handler, expired, "brand-new-passw0rd")
        assert status == 400
        assert _verifies("original-passw0rd", _stored_hash(password_user["user_id"]))

    async def test_a_short_password_does_not_burn_the_token(self, handler, password_user):
        """Order matters: rejecting the length after consuming the token would strand the
        user with a dead link and the password they could not remember."""
        token = _mint_reset_token(password_user["user_id"])

        assert (await _reset(handler, token, "sh0rt"))[0] == 400
        assert _verifies("original-passw0rd", _stored_hash(password_user["user_id"]))
        assert (await _reset(handler, token, "a-proper-passw0rd"))[0] == 200, \
            "the rejected attempt burned the token"

    async def test_reset_logs_every_session_out(self, handler, password_user):
        """The usual reason to reset a password is that somebody else is in the account."""
        assert db.user_sessions.count_documents({"user_id": password_user["user_id"]}) >= 1, \
            "fixture should have a live session to invalidate"

        assert (await _reset(handler, _mint_reset_token(password_user["user_id"]),
                             "brand-new-passw0rd"))[0] == 200

        assert db.user_sessions.count_documents({"user_id": password_user["user_id"]}) == 0
        r = requests.get(f"{API}/auth/me", headers=password_user["headers"], timeout=TIMEOUT)
        assert r.status_code == 401, "the old session still authenticates after a reset"

    async def test_reset_does_not_log_anybody_else_out(self, handler, password_user):
        bystander_headers, bystander_id, _email = mint_user()
        assert (await _reset(handler, _mint_reset_token(password_user["user_id"]),
                             "brand-new-passw0rd"))[0] == 200

        assert db.user_sessions.count_documents({"user_id": bystander_id}) == 1
        r = requests.get(f"{API}/auth/me", headers=bystander_headers, timeout=TIMEOUT)
        assert r.status_code == 200, "an unrelated user was logged out by someone else's reset"


class TestResetPasswordEndpointIsWired:
    """One HTTP call, to prove the handler above is actually reachable at that path with
    that shape. Everything it *does* is asserted at handler level."""

    def test_the_route_exists_and_validates_its_body(self):
        r = requests.post(f"{API}/auth/reset-password", json={"token": "x"}, timeout=TIMEOUT)
        assert r.status_code in (422, 429), r.text


# --- POST /auth/request-verify -------------------------------------------------------

class TestRequestVerify:
    """The authenticated resend. Its unauthenticated sibling `/auth/resend-verification`
    is what an unverified account has to use, having no session to present."""

    def test_it_needs_a_session(self):
        r = requests.post(f"{API}/auth/request-verify", timeout=TIMEOUT)
        assert r.status_code == 401

    def test_an_already_verified_account_is_told_so_and_gets_no_mail(self):
        headers, _uid, email = mint_user()  # mint_user sets email_verified_at
        r = skip_if_rate_limited(
            requests.post(f"{API}/auth/request-verify", headers=headers, timeout=TIMEOUT),
            "request-verify")
        assert r.status_code == 200, r.text
        assert r.json().get("already_verified") is True
        assert db.outbox.find_one({"to": email, "kind": "verify_email"}) is None
        db.outbox.delete_many({"to": email})

    def test_an_unverified_account_gets_a_link(self):
        headers, user_id, email = mint_user()
        db.users.update_one({"user_id": user_id}, {"$set": {"email_verified_at": None}})
        r = skip_if_rate_limited(
            requests.post(f"{API}/auth/request-verify", headers=headers, timeout=TIMEOUT),
            "request-verify")
        assert r.status_code == 200, r.text
        assert r.json().get("already_verified") is not True
        assert db.outbox.find_one({"to": email, "kind": "verify_email"}), "no verification mail"
        db.outbox.delete_many({"to": email})


# --- GET /tickets/{qr_code}/qr.png ---------------------------------------------------

@pytest.fixture
def ticket():
    """A ticket belonging to a specific user, with the event it names."""
    owner_headers, owner_id, _email = mint_user()
    event_id = f"evt_pytest_qr_{uuid.uuid4().hex[:10]}"
    db.events.insert_one({
        "event_id": event_id, "title": f"TEST_qr {uuid.uuid4().hex[:6]}",
        "slug": f"test-qr-{uuid.uuid4().hex[:8]}", "description": "",
        "venue": "Club Pytest", "city": "Bucharest",
        "starts_at": _iso(days=3), "ends_at": None, "doors_open_at": None,
        "image_url": "", "artist_ids": [], "max_tickets_per_user": 4,
        "is_published": True, "sold_out_message": "", "waves": [], "created_at": _iso(),
    })
    qr = f"SNTY-PYTEST-{uuid.uuid4().hex[:12].upper()}"
    db.tickets.insert_one({
        "ticket_id": f"tkt_pytest_{uuid.uuid4().hex[:12]}", "qr_code": qr,
        "reservation_id": None, "user_id": owner_id, "event_id": event_id,
        "wave_id": None, "price_ron": 100.0, "status": "issued",
        "scanned_at": None, "scanned_by": None, "created_at": _iso(),
    })
    yield {"qr": qr, "owner_headers": owner_headers, "event_id": event_id}
    db.tickets.delete_many({"event_id": event_id})
    db.events.delete_many({"event_id": event_id})


def _qr_png(qr, headers=None):
    return requests.get(f"{API}/tickets/{qr}/qr.png", headers=headers or {}, timeout=TIMEOUT)


class TestTicketQrImage:
    """The image *is* the ticket — whoever can fetch it can be admitted on it."""

    def test_the_owner_gets_a_png(self, ticket):
        r = _qr_png(ticket["qr"], ticket["owner_headers"])
        assert r.status_code == 200, r.text
        assert r.headers["content-type"] == "image/png"
        assert r.content[:8] == b"\x89PNG\r\n\x1a\n", "not actually a PNG"

    def test_anonymous_is_refused(self, ticket):
        assert _qr_png(ticket["qr"]).status_code == 401

    def test_another_user_is_refused(self, ticket):
        stranger, _uid, _email = mint_user()
        assert _qr_png(ticket["qr"], stranger).status_code == 403

    def test_door_staff_may_fetch_it(self, ticket, door_headers):
        """Door staff scan for a living; rendering the code is part of that job."""
        assert _qr_png(ticket["qr"], door_headers).status_code == 200

    def test_admin_may_fetch_it(self, ticket, admin_headers):
        assert _qr_png(ticket["qr"], admin_headers).status_code == 200

    def test_an_unknown_code_is_404(self, ticket):
        r = _qr_png(f"SNTY-PYTEST-{uuid.uuid4().hex[:12].upper()}", ticket["owner_headers"])
        assert r.status_code == 404, r.text


# --- GET /admin/newsletter.csv -------------------------------------------------------

@pytest.fixture
def subscription():
    email = f"pytest-nl-{uuid.uuid4().hex[:10]}@{TEST_EMAIL_DOMAIN}"
    db.newsletter_subscriptions.insert_one({
        "sub_id": f"sub_pytest_{uuid.uuid4().hex[:10]}", "email": email,
        "source": "=cmd|'/c calc'!A1",  # a formula, if a spreadsheet is ever allowed to see it
        "status": "confirmed", "created_at": _iso(),
        "confirmed_at": _iso(), "unsubscribed_at": None,
    })
    yield email
    db.newsletter_subscriptions.delete_many({"email": email})


def _csv(headers=None):
    return requests.get(f"{API}/admin/newsletter.csv", headers=headers or {}, timeout=TIMEOUT)


class TestNewsletterExport:
    """The largest single pile of personal data the API will hand over in one response."""

    def test_anonymous_is_refused(self):
        assert _csv().status_code == 401

    def test_a_plain_user_is_refused(self, user_headers):
        assert _csv(user_headers).status_code == 403

    def test_an_admin_gets_the_list(self, admin_headers, subscription):
        r = _csv(admin_headers)
        assert r.status_code == 200, r.text
        rows = list(csv.reader(io.StringIO(r.text)))
        assert rows[0] == ["email", "source", "status", "created_at", "confirmed_at",
                           "unsubscribed_at"]
        assert any(row and row[0] == subscription for row in rows[1:])

    def test_an_editor_also_gets_the_list(self, editor_headers):
        """Pinning what the route does today, not endorsing it: `require_admin_or_editor`
        means the CMS-editor role can export every subscriber address. If that is not
        intended, this is the test that should change first."""
        assert _csv(editor_headers).status_code == 200

    def test_a_formula_in_the_source_field_is_neutralised(self, admin_headers, subscription):
        """The export exists to be opened in a spreadsheet, which makes a leading =/+/-/@
        executable content. The fixture stores one; it must come back defused."""
        r = _csv(admin_headers)
        assert r.status_code == 200, r.text
        row = next(row for row in csv.reader(io.StringIO(r.text))
                   if row and row[0] == subscription)
        assert row[1].startswith("'="), f"formula left live in the export: {row[1]!r}"

    def test_it_is_served_as_a_download(self, admin_headers):
        assert "attachment" in _csv(admin_headers).headers.get("content-disposition", "")


# --- GET /shop/categories ------------------------------------------------------------

class TestShopCategories:

    def test_it_is_public_and_sorted(self):
        r = requests.get(f"{API}/shop/categories", timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        body = r.json()
        assert isinstance(body, list)
        assert body == sorted(body)
        assert all(isinstance(c, str) and c for c in body), "blank categories leaked in"

    def test_an_unpublished_product_does_not_advertise_its_category(self):
        slug = f"test-cat-{uuid.uuid4().hex[:8]}"
        category = f"TEST_hidden_{uuid.uuid4().hex[:6]}"
        db.products.insert_one({
            "product_id": f"prd_pytest_{uuid.uuid4().hex[:10]}", "slug": slug,
            "name": "TEST_hidden", "description": "", "images": [],
            "price_ron": 100.0, "category": category, "gender": "unisex",
            "is_published": False, "sort_order": 0, "variants": [], "created_at": _iso(),
        })
        try:
            r = requests.get(f"{API}/shop/categories", timeout=TIMEOUT)
            assert r.status_code == 200, r.text
            assert category not in r.json(), "an unpublished product advertised its category"
        finally:
            db.products.delete_many({"slug": slug})
