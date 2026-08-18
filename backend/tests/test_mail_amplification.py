"""
The mail-sending endpoints are limited per *recipient*, not only per caller.

`/auth/forgot-password` and `/newsletter` both send an email to an address the caller
names, and both were IP-keyed only. An IP bucket limits one attacker; it does nothing
about many hosts pointed at one victim, and every request that gets through is a genuine
delivery from this domain. That is a mail-bomb carrying our sending reputation — the same
impact audit H1 described, reached by *having* many keys rather than faking them, which is
why closing H1 did not close this.

`/auth/login` and `/auth/resend-verification` already had identity-keyed siblings; these
two are now consistent with them.

**These tests call the handlers rather than the endpoints.** The route-level IP limiter
allows 5 per 15 minutes for the whole suite, and three other tests need that budget — an
HTTP test here would take the endpoint's allowance to prove a limit that is not the one
under test, and make some other file skip. Calling the handler runs the real
`_email_rate_check` against the real in-process bucket and bypasses only the outer
counter, which is the same split used for the password-reset tests.
"""
import uuid

import pytest
from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorClient

from support import MONGO_URL, DB_NAME, db, TEST_EMAIL_DOMAIN

import server
import mailer


pytestmark = pytest.mark.critical  # pins the mail-amplification limits


@pytest.fixture(scope="module")
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def handler(anyio_backend):
    """`server` AND the mailer bound to this test's loop.

    Motor binds a client to the loop that is current when it is constructed, and both
    modules build theirs at import time, outside any loop. Rebinding `server.db` alone was
    not enough and quietly mattered: `mailer` keeps its own handle, so every outbox write
    failed with a cross-loop error that `send_mail` swallows by design. The
    "a refused signup sends no mail" assertion was then comparing zero to zero — it passed
    against a mailer that could not have sent anything either way.
    """
    client = AsyncIOMotorClient(MONGO_URL)
    original_db, original_mailer_db = server.db, mailer._db
    server.db = client[DB_NAME]
    mailer.init_mailer(client[DB_NAME])
    try:
        yield server
    finally:
        server.db = original_db
        mailer._db = original_mailer_db
        client.close()


def _address():
    return f"pytest-amp-{uuid.uuid4().hex[:10]}@{TEST_EMAIL_DOMAIN}"


async def _forgot(handler, email):
    """Returns the status code, or 200 when it was accepted."""
    try:
        await handler.forgot_password(handler.ForgotPasswordIn(email=email))
        return 200
    except HTTPException as e:
        return e.status_code


async def _subscribe(handler, email):
    try:
        await handler.newsletter_subscribe(handler.NewsletterIn(email=email, source="pytest"))
        return 200
    except HTTPException as e:
        return e.status_code


@pytest.mark.anyio
class TestForgotPasswordIsLimitedPerAddress:

    async def test_the_fourth_request_for_one_address_is_refused(self, handler):
        email = _address()
        codes = [await _forgot(handler, email) for _ in range(4)]
        assert codes[:3] == [200, 200, 200], codes
        assert codes[3] == 429, f"a fourth reset mail was allowed to the same address: {codes}"

    async def test_another_address_is_unaffected(self, handler):
        """Keyed on the recipient, so exhausting one victim's budget must not deny
        everybody else the ability to reset their password."""
        victim = _address()
        for _ in range(4):
            await _forgot(handler, victim)
        assert await _forgot(handler, _address()) == 200

    async def test_it_stays_silent_about_whether_the_account_exists(self, handler):
        """The bucket is keyed before the user lookup, so a 429 says "asked recently",
        never "this address is real" — the endpoint's whole design is non-enumeration."""
        unknown = _address()
        codes_unknown = [await _forgot(handler, unknown) for _ in range(4)]

        real = _address()
        db.users.insert_one({
            "user_id": f"user_amp_{uuid.uuid4().hex[:10]}", "email": real,
            "name": "pytest amp", "first_name": "p", "last_name": "a",
            "phone": "+40721000000", "role": "user",
            "password_hash": "$2b$04$abcdefghijklmnopqrstuvwxyz012345678901234567890123",
            "created_at": server.now_utc().isoformat(),
        })
        try:
            codes_real = [await _forgot(handler, real) for _ in range(4)]
            assert codes_unknown == codes_real, (
                f"an unknown address behaves differently from a real one: "
                f"{codes_unknown} vs {codes_real}"
            )
        finally:
            db.users.delete_many({"email": real})
            db.outbox.delete_many({"to": real})


@pytest.mark.anyio
class TestNewsletterIsLimitedPerAddress:

    async def test_the_fourth_signup_for_one_address_is_refused(self, handler):
        email = _address()
        try:
            codes = [await _subscribe(handler, email) for _ in range(4)]
            assert codes[:3] == [200, 200, 200], codes
            assert codes[3] == 429, f"a fourth confirmation mail was allowed: {codes}"
        finally:
            db.newsletter_subscriptions.delete_many({"email": email})
            db.outbox.delete_many({"to": email})

    async def test_another_address_is_unaffected(self, handler):
        victim = _address()
        try:
            for _ in range(4):
                await _subscribe(handler, victim)
            other = _address()
            try:
                assert await _subscribe(handler, other) == 200
            finally:
                db.newsletter_subscriptions.delete_many({"email": other})
                db.outbox.delete_many({"to": other})
        finally:
            db.newsletter_subscriptions.delete_many({"email": victim})
            db.outbox.delete_many({"to": victim})

    async def test_a_refused_signup_sends_no_mail(self, handler):
        """The point of the limit. A 429 that still mailed would be decoration."""
        email = _address()
        try:
            for _ in range(3):
                await _subscribe(handler, email)
            sent_before = db.outbox.count_documents({"to": email})
            assert await _subscribe(handler, email) == 429
            assert db.outbox.count_documents({"to": email}) == sent_before, \
                "the refused request still sent a confirmation"
        finally:
            db.newsletter_subscriptions.delete_many({"email": email})
            db.outbox.delete_many({"to": email})


class TestBothEndpointsAreCovered:
    """A source-level check, so the pair cannot drift apart. The behaviour above proves
    the limit works; this proves it is still attached to both places that need it."""

    def test_every_endpoint_that_mails_a_caller_named_address_is_identity_keyed(self):
        import pathlib
        src = (pathlib.Path(__file__).resolve().parent.parent / "server.py").read_text()
        for bucket in ("auth_login_email", "auth_verify_resend_email",
                       "auth_forgot_email", "newsletter_email"):
            assert f'_email_rate_check("{bucket}"' in src, (
                f"{bucket} is gone — an endpoint that mails an address the caller chose "
                "is back to being limited by IP alone"
            )
