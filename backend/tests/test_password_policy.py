"""
What may be used as a password.

The policy used to be `len(pw) < 8`, written out twice — once at registration and once at
reset. Two copies of a rule is a rule that eventually disagrees with itself, and the
direction nobody notices is the one where signup accepts what reset refuses, so the policy
binds only the people who forgot theirs. There is one validator now and both call it.

Two properties matter more than any individual rule:

  * a refused password must not burn the reset token. The check that enforces this used
    to cover only length; it has to cover everything the policy now rejects, or a user
    who picks a breached password loses their link as well as their attempt.
  * the local rules must run before the network one. HIBP is a third party on the far
    side of a timeout, and the common rejection should not wait on it.
"""
import asyncio
import uuid

import pytest
import requests

from motor.motor_asyncio import AsyncIOMotorClient

import server
import password_policy as policy
from support import (API, TIMEOUT, MONGO_URL, DB_NAME, db, mint_user, register_user,
                     skip_if_rate_limited, registered_user_doc, TEST_EMAIL_DOMAIN)

pytestmark = pytest.mark.xdist_group("password_policy")

GOOD = "Fixture-Str0ng-Pass!"
# Passes length, composition and the offline list, and is nonetheless in the breach
# corpus — which is the entire reason the two layers are not one layer.
BREACHED = "Tr0ub4dour&3"


def problems_for(pw, **kw):
    return policy.local_problems(pw, **kw)


@pytest.fixture
def anyio_backend():
    """Pin to asyncio; left alone anyio would parametrize over trio, which motor is not."""
    return "asyncio"


@pytest.fixture
async def handler(anyio_backend):
    """`server` with its database bound to the loop this test runs on.

    Reset is exercised in-process rather than over HTTP for two reasons, and the first is
    not a convenience: SESSION_SECRET is unset in development, so the running server
    minted an ephemeral one at startup and a token signed here would never verify there.
    The second is that calling the coroutine skips the rate-limit dependency, so these
    tests do not have to ration a shared 5-per-15-minute budget to assert a policy.
    """
    client = AsyncIOMotorClient(MONGO_URL)
    original = server.db
    server.db = client[DB_NAME]
    try:
        yield server
    finally:
        server.db = original
        client.close()


@pytest.fixture
def reset_user():
    """An account with a password and a live reset link.

    The token is minted the way `forgot_password` mints it — bound to a fingerprint of
    the hash it was issued against, which is the single-use mechanism. Building it with
    the server's own helper rather than reimplementing it means these tests cannot drift
    from the thing they are testing.
    """
    _headers, user_id, email = mint_user()
    db.users.update_one({"user_id": user_id},
                        {"$set": {"password_hash": server.hash_password("Original-Str0ng!9")}})
    stored = db.users.find_one({"user_id": user_id}, {"_id": 0, "password_hash": 1})["password_hash"]
    token = server.make_token("pwd-reset", user_id,
                              {"ph": server._password_fingerprint(stored)})
    yield {"user_id": user_id, "email": email, "token": token}
    db.outbox.delete_many({"to": email})


class TestLength:
    def test_eleven_is_refused_and_twelve_is_not(self):
        assert "be at least 12 characters" in problems_for("Aa1!aaaaaaa")      # 11
        assert problems_for("Aa1!aaaaaaaa") == []                              # 12

    def test_the_ceiling_is_bcrypts_own(self):
        """bcrypt hashes 72 bytes and silently drops the rest, so two long passphrases
        sharing a prefix would be the same password. Refusing is the honest option."""
        assert problems_for("Aa1!" + "x" * 68) == []                           # 72 bytes
        assert any("at most 72" in p for p in problems_for("Aa1!" + "x" * 69))

    def test_the_ceiling_counts_bytes_not_characters(self):
        # 68 emoji are 272 bytes, and bcrypt would keep about eighteen of them.
        assert any("at most 72" in p for p in problems_for("Aa1!" + "😀" * 68))


class TestComposition:
    @pytest.mark.parametrize("pw,missing", [
        ("AA1!AAAAAAAA", "include a lowercase letter"),
        ("aa1!aaaaaaaa", "include an uppercase letter"),
        ("Aaa!aaaaaaaa", "include a number"),
        ("Aa1aaaaaaaaa", "include a symbol"),
    ])
    def test_each_missing_class_is_named(self, pw, missing):
        assert missing in problems_for(pw)

    def test_a_symbol_is_anything_that_is_not_a_letter_or_digit(self):
        """Defined by exclusion so an unusual but perfectly good character counts,
        rather than only the ones on a US keyboard."""
        for sym in ["!", "£", "§", "—", "字", "😀"]:
            assert "include a symbol" not in problems_for(f"Aa1{sym}aaaaaaaa")

    def test_every_failure_is_reported_at_once(self):
        """A form that reveals one rule per submission is a form people submit five
        times, and the fifth is when they give up and pick something worse."""
        assert len(problems_for("aaaa")) >= 4


class TestTheBlocklist:
    def test_a_bare_common_word_is_refused(self):
        assert "not be a commonly used password" in problems_for("Password!123")

    @pytest.mark.parametrize("pw", ["P@ssw0rd123!", "!!Letmein2024", "Adm1n!!!!2020",
                                    "$unshine-1234", "Qwerty!!!!!99"])
    def test_dressing_a_common_word_up_does_not_hide_it(self, pw):
        """A blocklist that only matches the literal string is one people walk around by
        holding down shift."""
        assert "not be a commonly used password" in problems_for(pw), pw

    def test_normalisation_strips_decoration_before_undoing_leet(self):
        """Order matters and getting it wrong is silent: leet applied first turns the
        trailing "123!" of P@ssw0rd123! into letters, after which nothing removes them
        and the word comes out as "passwordizei" — matching nothing."""
        assert policy.normalise("P@ssw0rd123!") == "password"
        assert policy.normalise("!!Letmein2024") == "letmein"

    def test_a_real_passphrase_is_not_caught_by_it(self):
        assert problems_for("Correct-Horse-9!") == []
        assert problems_for("Tr0ubad0ur-Ripe!") == []


class TestItCannotBeBuiltFromTheAccount:
    def test_the_email_local_part_is_refused(self):
        assert "not contain your name or email address" in \
            problems_for("Danieltest-99!", email="danieltest@example.com")

    def test_a_name_is_refused(self):
        assert "not contain your name or email address" in \
            problems_for("Teodorescu-9!", name="Daniel Teodorescu")

    def test_a_short_fragment_does_not_trip_it(self):
        """Two- and three-letter names would refuse half the dictionary."""
        assert problems_for("Correct-Horse-9!", name="Al Bo") == []

    def test_it_is_case_insensitive(self):
        assert "not contain your name or email address" in \
            problems_for("DANIELTEST-99!", email="danieltest@example.com")


class TestTheBreachCheck:
    def test_a_breached_password_that_passes_every_local_rule_is_still_refused(self):
        """The reason the offline list is not the whole policy."""
        assert problems_for(BREACHED) == [], "this fixture must pass the local rules"
        try:
            hit = asyncio.run(policy.breached(BREACHED))
        except Exception:
            pytest.skip("no network for the HIBP lookup")
        if not hit:
            pytest.skip("HIBP unreachable or the corpus changed")
        assert asyncio.run(policy.validate(BREACHED)) is not None

    def test_a_password_nobody_has_leaked_is_accepted(self):
        unique = f"Zx-{uuid.uuid4().hex[:16]}-Q9!"
        assert asyncio.run(policy.validate(unique)) is None

    def test_it_fails_open_when_the_service_is_unreachable(self, monkeypatch):
        """An outage of somebody else's service must not stop people resetting their own
        password. The local rules have already run, so this falls back to a policy."""
        monkeypatch.setattr(policy, "_HIBP_URL", "https://127.0.0.1:1/range/{prefix}")
        assert asyncio.run(policy.breached("anything-at-all")) is False

    def test_it_can_be_switched_off(self, monkeypatch):
        monkeypatch.setenv("PASSWORD_HIBP", "0")
        assert asyncio.run(policy.breached(BREACHED)) is False

    def test_only_five_characters_of_the_hash_would_leave(self):
        """k-anonymity is the whole reason this is acceptable at all — assert the shape
        rather than the traffic."""
        import hashlib
        digest = hashlib.sha1(BREACHED.encode()).hexdigest().upper()
        assert policy._HIBP_URL.format(prefix=digest[:5]).endswith(digest[:5])
        assert digest[5:] not in policy._HIBP_URL.format(prefix=digest[:5])


class TestBothEndpointsEnforceIt:

    def test_registration_refuses_a_weak_password(self):
        r = skip_if_rate_limited(register_user(password="short1"), "registration")
        assert r.status_code == 400, r.text
        assert "Password must" in r.json()["detail"]

    def test_registration_accepts_a_strong_one(self):
        email = f"pytest-{uuid.uuid4().hex[:12]}@{TEST_EMAIL_DOMAIN}"
        r = skip_if_rate_limited(register_user(email), "registration")
        assert r.status_code == 200, r.text
        assert registered_user_doc(email)


@pytest.mark.anyio
class TestResetEnforcesIt:

    @staticmethod
    async def _reset(handler, token, pw):
        body = handler.ResetPasswordIn(token=token, new_password=pw)
        try:
            return 200, await handler.reset_password(body, handler.Response())
        except handler.HTTPException as e:
            return e.status_code, e.detail

    async def test_it_refuses_what_registration_refuses_and_says_why(self, handler, reset_user):
        status, detail = await self._reset(handler, reset_user["token"], "aaaaaaaaaaaa")
        assert status == 400
        # Every failure at once: a form that reveals one rule per submission is a form
        # people submit five times, and the fifth is when they pick something worse.
        assert "uppercase" in detail and "number" in detail and "symbol" in detail

    async def test_a_common_password_is_refused(self, handler, reset_user):
        status, detail = await self._reset(handler, reset_user["token"], "P@ssw0rd123!")
        assert status == 400
        assert "commonly used" in detail

    async def test_a_password_built_from_the_account_is_refused(self, handler, reset_user):
        """This rule needs the account, so it runs after the token is read — and still
        before the update, which is what actually burns the link."""
        local = reset_user["email"].split("@")[0]
        status, detail = await self._reset(handler, reset_user["token"], f"{local.title()}-9xQ!")
        assert status == 400
        assert "name or email" in detail

    async def test_a_refused_password_does_not_burn_the_token(self, handler, reset_user):
        """The invariant that used to cover only length. A user who picks a common
        password must not lose the link as well as the attempt."""
        token = reset_user["token"]
        assert (await self._reset(handler, token, "P@ssw0rd123!"))[0] == 400
        assert (await self._reset(handler, token, "sh0rt"))[0] == 400
        local = reset_user["email"].split("@")[0]
        assert (await self._reset(handler, token, f"{local.title()}-9xQ!"))[0] == 400

        good = f"Zx-{uuid.uuid4().hex[:16]}-Q9!"
        status, _ = await self._reset(handler, token, good)
        assert status == 200, "a rejected attempt burned the token"

    async def test_a_good_password_still_gets_through(self, handler, reset_user):
        good = f"Zx-{uuid.uuid4().hex[:16]}-Q9!"
        assert (await self._reset(handler, reset_user["token"], good))[0] == 200
        stored = db.users.find_one({"user_id": reset_user["user_id"]})["password_hash"]
        assert server.verify_password(good, stored)
