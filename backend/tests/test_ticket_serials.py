"""
Ticket serials, and the fiscal views built on them.

A serial is the number a tax return is written against, so the properties that matter are
not the format — they are that it never repeats, that it never moves once issued, and that
the summary's arithmetic can be recomputed by hand from what it prints.

The scannable `qr_code` is deliberately NOT any of this. It stays random, because a
predictable door credential is a forgeable one, and a serial has to be predictable to be
a series at all. Both live on the same ticket doing opposite jobs.
"""
import uuid

import pytest
import requests
from motor.motor_asyncio import AsyncIOMotorClient

import server
import support
from support import API, TIMEOUT, MONGO_URL, DB_NAME, db

# Runs on one worker, in order: motor's loop binding makes these unsafe to interleave.
pytestmark = [pytest.mark.xdist_group("test_ticket_serials")]


@pytest.fixture(scope="module")
def anyio_backend():
    """Pin to asyncio; left alone anyio would parametrize over trio, which motor is not."""
    return "asyncio"


@pytest.fixture
async def sell(anyio_backend):
    """Issue tickets through the real finalize path, on this test's own loop.

    `server` builds its Motor client at import time, outside any loop, and Motor binds a
    client to the loop current when it is made — so the module gets a fresh one for the
    duration of the test. Everything else about it is the real thing.

    Not over HTTP: /reservations is rate-limited to 20 a minute and these tests want more
    than that between them, so driving the handler directly spends no budget that a
    security control is meant to be enforcing.
    """
    client = AsyncIOMotorClient(MONGO_URL)
    original = server.db
    server.db = client[DB_NAME]

    async def _sell(event, wave_index, qty, buyer_id):
        wave = event["waves"][wave_index]
        rid = server.new_id("res")
        await server.db.reservations.insert_one({
            "reservation_id": rid, "user_id": buyer_id, "event_id": event["event_id"],
            "wave_id": wave["wave_id"], "quantity": qty,
            "unit_price_ron": wave["price_ron"], "total_ron": wave["price_ron"] * qty,
            "status": "pending", "created_at": server.now_utc().isoformat(),
        })
        await server._finalize_paid_reservation(rid)
        return rid

    try:
        yield _sell
    finally:
        server.db = original
        client.close()


@pytest.fixture()
def event(admin_headers):
    """A two-tier event, torn down with its tickets and its serial counters."""
    r = requests.post(f"{API}/admin/events", headers=admin_headers, timeout=TIMEOUT, json={
        "title": f"TEST_SERIAL {uuid.uuid4().hex[:4].upper()}",
        "slug": f"test-serial-{uuid.uuid4().hex[:8]}",
        "starts_at": "2027-01-01T20:00:00+00:00",
        "ends_at": "2027-01-02T04:00:00+00:00",
        "is_published": True,
        "waves": [
            {"name": "EARLY BIRD", "price_ron": 75, "capacity": 50,
             "starts_at": "2026-01-01T00:00:00+00:00", "ends_at": "2027-01-01T00:00:00+00:00",
             "tier": "early_bird"},
            {"name": "GENERAL", "price_ron": 100, "capacity": 50,
             "starts_at": "2026-01-01T00:00:00+00:00", "ends_at": "2027-01-01T00:00:00+00:00",
             "tier": "general"},
        ],
    })
    assert r.status_code == 200, r.text
    ev = r.json()
    yield ev
    db.tickets.delete_many({"event_id": ev["event_id"]})
    db.reservations.delete_many({"event_id": ev["event_id"]})
    db.serial_counters.delete_many({"_id": {"$regex": f"^{ev['event_id']}"}})
    requests.delete(f"{API}/admin/events/{ev['event_id']}", headers=admin_headers, timeout=TIMEOUT)


@pytest.fixture()
def buyer():
    _headers, user_id, _email = support.mint_user("user")
    return user_id


@pytest.mark.anyio
class TestTheSerialItself:

    async def test_an_event_gets_its_code_before_anything_is_sold(self, event):
        assert event.get("event_code"), "the admin has to be able to see the code up front"

    async def test_the_shape_is_prefix_event_type_series(self, event, buyer, sell):
        await sell(event, 0, 1, buyer)
        t = db.tickets.find_one({"event_id": event["event_id"]})
        parts = t["serial"].split("-")
        assert parts[0] == "SNTY"
        assert parts[1] == event["event_code"]
        assert parts[2] == "EB"
        assert parts[3] == "0001"

    async def test_each_type_counts_from_one_within_its_event(self, event, buyer, sell):
        await sell(event, 0, 3, buyer)
        await sell(event, 1, 2, buyer)
        serials = sorted(t["serial"] for t in db.tickets.find({"event_id": event["event_id"]}))
        eb = [s for s in serials if "-EB-" in s]
        general = [s for s in serials if "-G-" in s]
        # Contiguous per tier is what makes "Early Bird 0001-0003" checkable by counting.
        assert [s.split("-")[-1] for s in eb] == ["0001", "0002", "0003"]
        assert [s.split("-")[-1] for s in general] == ["0001", "0002"]

    async def test_a_serial_is_never_issued_twice(self, event, buyer, sell):
        for _ in range(4):
            await sell(event, 0, 2, buyer)
        serials = [t["serial"] for t in db.tickets.find({"event_id": event["event_id"]})]
        assert len(serials) == len(set(serials)) == 8

    async def test_the_scannable_code_is_untouched_by_all_this(self, event, buyer, sell):
        await sell(event, 0, 2, buyer)
        tickets = list(db.tickets.find({"event_id": event["event_id"]}))
        for t in tickets:
            # Still the random one. If a serial could open a door, the series would be a
            # list of working credentials.
            assert t["qr_code"].startswith("SNTY-") and len(t["qr_code"]) == 25
            assert t["qr_code"] != t["serial"]

    async def test_renaming_the_event_does_not_move_issued_serials(self, event, buyer, admin_headers, sell):
        await sell(event, 0, 1, buyer)
        before = db.tickets.find_one({"event_id": event["event_id"]})["serial"]
        requests.patch(f"{API}/admin/events/{event['event_id']}", headers=admin_headers,
                       json={"title": "TEST_SERIAL RENAMED"}, timeout=TIMEOUT)
        await sell(event, 0, 1, buyer)
        serials = sorted(t["serial"] for t in db.tickets.find({"event_id": event["event_id"]}))
        # Both tickets share the original code: a serial is printed and filed, so it
        # cannot follow a title edit made six months later.
        assert all(s.split("-")[1] == before.split("-")[1] for s in serials)


@pytest.mark.anyio
class TestTheExecutiveSummary:

    async def test_tickets_times_price_equals_the_line_total(self, event, buyer, admin_headers, sell):
        await sell(event, 0, 4, buyer)   # 4 x 75
        await sell(event, 1, 3, buyer)   # 3 x 100
        s = requests.get(f"{API}/admin/transactions/summary?event_id={event['event_id']}",
                         headers=admin_headers, timeout=TIMEOUT).json()

        by_type = {l["type_code"]: l for l in s["lines"]}
        assert by_type["EB"]["tickets_sold"] == 4
        assert by_type["EB"]["unit_price_ron"] == 75
        assert by_type["EB"]["total_ron"] == 300
        assert by_type["G"]["total_ron"] == 300
        # The point of the document: every line multiplies out, and the total is their sum.
        assert s["total_ron"] == 600
        assert sum(l["total_ron"] for l in s["lines"]) == s["total_ron"]

    async def test_each_line_states_the_series_range_it_covers(self, event, buyer, admin_headers, sell):
        await sell(event, 0, 5, buyer)
        s = requests.get(f"{API}/admin/transactions/summary?event_id={event['event_id']}",
                         headers=admin_headers, timeout=TIMEOUT).json()
        line = s["lines"][0]
        assert line["serial_first"].endswith("0001")
        assert line["serial_last"].endswith("0005")
        assert line["serials_present"] == line["tickets_sold"]
        assert s["serials_missing"] == 0

    async def test_a_tier_sold_at_two_prices_is_two_lines(self, event, buyer, admin_headers, sell):
        """One line whose count times whose price equals nothing that was ever charged is
        worse than no line at all."""
        await sell(event, 1, 2, buyer)
        db.tickets.update_one({"event_id": event["event_id"]}, {"$set": {"price_ron": 50}})
        s = requests.get(f"{API}/admin/transactions/summary?event_id={event['event_id']}",
                         headers=admin_headers, timeout=TIMEOUT).json()
        general = [l for l in s["lines"] if l["type_code"] == "G"]
        assert len(general) == 2, [l["unit_price_ron"] for l in general]
        assert s["total_ron"] == 150

    async def test_the_status_filter_is_the_one_stats_uses(self, event, buyer, admin_headers, sell):
        await sell(event, 0, 3, buyer)
        db.tickets.update_one({"event_id": event["event_id"]}, {"$set": {"status": "refunded"}})

        issued = requests.get(
            f"{API}/admin/transactions/summary?event_id={event['event_id']}&status=issued",
            headers=admin_headers, timeout=TIMEOUT).json()
        stats = requests.get(
            f"{API}/admin/stats?event_id={event['event_id']}&status=issued",
            headers=admin_headers, timeout=TIMEOUT).json()
        # A figure checked on the stats screen is the figure that gets declared here.
        assert issued["tickets_sold"] == stats["total_tickets"] == 2

    async def test_an_unknown_status_is_refused(self, admin_headers):
        r = requests.get(f"{API}/admin/transactions/summary?status=nonsense",
                         headers=admin_headers, timeout=TIMEOUT)
        assert r.status_code == 400


@pytest.mark.anyio
class TestTheCsv:

    async def test_one_row_per_ticket_led_by_its_serial(self, event, buyer, admin_headers, sell):
        await sell(event, 0, 3, buyer)
        r = requests.get(f"{API}/admin/transactions.csv?event_id={event['event_id']}",
                         headers=admin_headers, timeout=TIMEOUT)
        assert r.status_code == 200
        assert "attachment; filename=transactions.csv" in r.headers.get("Content-Disposition", "")
        rows = r.text.strip().split("\n")
        assert rows[0].startswith("serial,")
        assert len(rows) == 4  # header + 3
        assert rows[1].startswith("SNTY-")

    async def test_it_is_admin_only(self, event, user_headers):
        r = requests.get(f"{API}/admin/transactions.csv", headers=user_headers, timeout=TIMEOUT)
        assert r.status_code == 403


@pytest.mark.anyio
class TestMultipleFilterValues:
    """A filter row takes several answers, and several means OR.

    Ticking `issued` and `used` asks for tickets that are either — not tickets that are
    somehow both, which is what a naive merge of the two query fragments would ask for
    and which matches nothing.
    """

    async def test_several_statuses_are_an_or(self, event, buyer, admin_headers, sell):
        await sell(event, 0, 3, buyer)
        ids = [t["ticket_id"] for t in db.tickets.find({"event_id": event["event_id"]})]
        db.tickets.update_one({"ticket_id": ids[0]}, {"$set": {"status": "used"}})
        db.tickets.update_one({"ticket_id": ids[1]}, {"$set": {"status": "refunded"}})

        both = requests.get(
            f"{API}/admin/stats?event_id={event['event_id']}&status=issued,used",
            headers=admin_headers, timeout=TIMEOUT).json()
        assert both["total_tickets"] == 2, "one issued + one used"

    async def test_a_history_status_ors_with_a_plain_one(self, event, buyer, admin_headers, sell):
        """`denied` matches on a timestamp, `issued` on the status field. Merged into one
        document they would AND together and match nothing."""
        await sell(event, 0, 2, buyer)
        one = db.tickets.find_one({"event_id": event["event_id"]})
        db.tickets.update_one({"ticket_id": one["ticket_id"]},
                              {"$set": {"status": "denied", "denied_at": "2026-01-01T00:00:00+00:00"}})

        r = requests.get(
            f"{API}/admin/stats?event_id={event['event_id']}&status=issued,denied",
            headers=admin_headers, timeout=TIMEOUT).json()
        assert r["total_tickets"] == 2

    async def test_several_events_are_an_or(self, event, buyer, admin_headers, sell):
        await sell(event, 0, 2, buyer)
        # A second id that matches nothing must widen the result, never narrow it.
        r = requests.get(
            f"{API}/admin/transactions/summary?event_id={event['event_id']},evt_nonexistent",
            headers=admin_headers, timeout=TIMEOUT).json()
        assert r["tickets_sold"] == 2

    async def test_one_value_still_works(self, event, buyer, admin_headers, sell):
        """Every caller that predates multi-select keeps working unchanged."""
        await sell(event, 0, 2, buyer)
        r = requests.get(f"{API}/admin/stats?event_id={event['event_id']}&status=issued",
                         headers=admin_headers, timeout=TIMEOUT).json()
        assert r["total_tickets"] == 2

    async def test_one_bad_value_in_a_list_is_refused(self, admin_headers):
        r = requests.get(f"{API}/admin/stats?status=issued,nonsense",
                         headers=admin_headers, timeout=TIMEOUT)
        assert r.status_code == 400
