"""
Tests for migrate_newsletter_optins — the startup backfill that reconciles the
`news_opt_in` consent flag with the `newsletter_subscriptions` collection.

These run the migration in-process against the real database rather than over HTTP,
because it is a boot-time function with no endpoint of its own. Each test creates its
own Motor client inside a single asyncio.run and points server.db at it for the
duration: server.db is bound to whichever loop first used it, and asyncio.run closes
its loop on the way out, so reusing the module-level client across tests would fail
with a closed-loop error that has nothing to do with the code under test.

Run: venv/bin/python -m pytest tests/test_newsletter_backfill.py -q
"""
import asyncio
import uuid
from datetime import datetime, timezone

import pytest

import support

# Runs on one worker, in order: the module's own xdist group. This is what
# `--dist loadgroup` needs in order to behave like the `loadscope` it replaced —
# see pytest.ini.
pytestmark = pytest.mark.xdist_group("test_newsletter_backfill")


@pytest.fixture(scope="module")
def srv():
    """The server module. Imported as-is so it reads backend/.env itself.

    Deliberately does NOT set MONGO_URL/DB_NAME in os.environ — subprocess-based tests
    elsewhere in the suite inherit this process's environment and would then read a
    different database than the one they wrote to.
    """
    import server
    return server


def _email():
    return f"pytest-{uuid.uuid4().hex[:12]}@{support.TEST_EMAIL_DOMAIN}"


def run_backfill(srv, users, subs=()):
    """Seed users + subscription rows, run the migration, return the resulting rows.

    Returns {email: subscription_doc_or_None} for every seeded user, and always removes
    what it created — including on assertion failure, since the caller only sees the
    return value after cleanup has run.
    """
    from motor.motor_asyncio import AsyncIOMotorClient

    async def scenario():
        client = AsyncIOMotorClient(srv.MONGO_URL, serverSelectionTimeoutMS=5000)
        original = srv.db
        srv.db = client[srv.DB_NAME]
        emails = [u["email"] for u in users]
        try:
            now = datetime.now(timezone.utc).isoformat()
            for u in users:
                await srv.db.users.insert_one({
                    "user_id": f"user_pytest_{uuid.uuid4().hex[:12]}",
                    "email": u["email"],
                    "name": "pytest backfill",
                    "first_name": "Pytest", "last_name": "Backfill",
                    "role": "customer",
                    "created_at": now,
                    "news_opt_in": u["news_opt_in"],
                    "email_verified_at": now if u.get("verified") else None,
                })
            for s in subs:
                await srv.db.newsletter_subscriptions.insert_one(dict(s))

            await srv.migrate_newsletter_optins()

            return {
                e: await srv.db.newsletter_subscriptions.find_one({"email": e}, {"_id": 0})
                for e in emails
            }
        finally:
            await srv.db.users.delete_many({"email": {"$in": emails}})
            await srv.db.newsletter_subscriptions.delete_many({"email": {"$in": emails}})
            srv.db = original
            client.close()

    return asyncio.run(scenario())


class TestBackfillCreatesMissingRows:
    def test_verified_opt_in_lands_confirmed(self, srv):
        email = _email()
        rows = run_backfill(srv, [{"email": email, "news_opt_in": True, "verified": True}])

        row = rows[email]
        assert row is not None, "a verified opt-in with no row should be backfilled"
        assert row["status"] == "confirmed"
        assert row["confirmed_at"] is not None
        assert row["unsubscribed_at"] is None

    def test_unverified_opt_in_lands_pending(self, srv):
        email = _email()
        rows = run_backfill(srv, [{"email": email, "news_opt_in": True, "verified": False}])

        row = rows[email]
        assert row is not None
        assert row["status"] == "pending", "an unproved address still needs the double opt-in"
        assert row["confirmed_at"] is None

    def test_backfilled_rows_are_labelled(self, srv):
        """source distinguishes these from real signups in the admin CSV export."""
        email = _email()
        rows = run_backfill(srv, [{"email": email, "news_opt_in": True, "verified": True}])

        assert rows[email]["source"] == "backfill"

    def test_row_is_visible_to_the_admin_listing_query(self, srv):
        """The bug was invisibility, so assert the shape the tab actually reads."""
        email = _email()
        rows = run_backfill(srv, [{"email": email, "news_opt_in": True, "verified": True}])

        row = rows[email]
        assert row["email"] == email
        assert row["sub_id"], "the admin tab keys its delete button on sub_id"
        assert srv._newsletter_status(row) == "confirmed"


class TestBackfillLeavesExistingRowsAlone:
    def test_an_unsubscribe_is_never_resurrected(self, srv):
        """The case that rules out calling _sync_newsletter_subscription here.

        Unsubscribing marks the subscription and does not clear news_opt_in, so a stale
        true on the user document must not put someone back on a list they left.
        """
        email = _email()
        rows = run_backfill(
            srv,
            [{"email": email, "news_opt_in": True, "verified": True}],
            [{"sub_id": "sub_pytest_unsub", "email": email, "source": "home hero",
              "status": "unsubscribed", "created_at": "2026-01-01T00:00:00+00:00",
              "confirmed_at": "2026-01-01T00:00:00+00:00",
              "unsubscribed_at": "2026-02-01T00:00:00+00:00"}],
        )

        row = rows[email]
        assert row["status"] == "unsubscribed"
        assert row["unsubscribed_at"] == "2026-02-01T00:00:00+00:00"
        assert row["source"] == "home hero", "the original row must be untouched"

    def test_a_pending_row_is_not_promoted(self, srv):
        """Only verify_email promotes pending; the backfill has no standing to."""
        email = _email()
        rows = run_backfill(
            srv,
            [{"email": email, "news_opt_in": True, "verified": True}],
            [{"sub_id": "sub_pytest_pending", "email": email, "source": "footer",
              "status": "pending", "created_at": "2026-01-01T00:00:00+00:00",
              "confirmed_at": None, "unsubscribed_at": None}],
        )

        assert rows[email]["status"] == "pending"
        assert rows[email]["source"] == "footer"


class TestBackfillScope:
    def test_users_who_did_not_opt_in_are_skipped(self, srv):
        email = _email()
        rows = run_backfill(srv, [{"email": email, "news_opt_in": False, "verified": True}])

        assert rows[email] is None

    def test_running_twice_adds_nothing(self, srv):
        """Cold starts race through the init gate; the second must be a no-op."""
        from motor.motor_asyncio import AsyncIOMotorClient

        email = _email()

        async def scenario():
            client = AsyncIOMotorClient(srv.MONGO_URL, serverSelectionTimeoutMS=5000)
            original = srv.db
            srv.db = client[srv.DB_NAME]
            try:
                now = datetime.now(timezone.utc).isoformat()
                await srv.db.users.insert_one({
                    "user_id": f"user_pytest_{uuid.uuid4().hex[:12]}",
                    "email": email, "name": "pytest backfill", "role": "customer",
                    "created_at": now, "news_opt_in": True, "email_verified_at": now,
                })
                await srv.migrate_newsletter_optins()
                first = await srv.db.newsletter_subscriptions.find_one({"email": email}, {"_id": 0})
                await srv.migrate_newsletter_optins()
                second = await srv.db.newsletter_subscriptions.find_one({"email": email}, {"_id": 0})
                count = await srv.db.newsletter_subscriptions.count_documents({"email": email})
                return first, second, count
            finally:
                await srv.db.users.delete_many({"email": email})
                await srv.db.newsletter_subscriptions.delete_many({"email": email})
                srv.db = original
                client.close()

        first, second, count = asyncio.run(scenario())
        assert count == 1
        assert first == second, "the second run must not rewrite the row it already made"
