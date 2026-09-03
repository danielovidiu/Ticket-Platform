"""
Retiring a tier, and selling several tickets as one.

Two changes to ticket tiering land here, and they meet in the same place: what a tier
leaves behind once it is no longer the thing being sold.

**Deleting a tier.** A tier that has never sold is free to go. One that has sold even a
single ticket is not, because a wave row is what the door reads an access window from and
what an export reads a tier name from, and those sales stay valid and indexed long after
the tier stops being offered. So a sold tier is ARCHIVED instead: hidden from the event
page, refused at checkout, kept in the admin with its count — and reversible, because an
archive undone costs nothing and a delete undone does not exist. The PATCH that used to
drop an omitted wave silently is what these tests hold shut.

**Group tickets.** A tier can sell in packs — four for the price of three — where the
price is the pack's and the capacity is still in individual tickets. Buying one pack
issues four separate tickets, and each carries its own quarter of what was paid. That
last part is the whole point: refunds are settled per ticket, so a guest turned away at
the door on a 300 RON four-pack is owed 75, and a ticket carrying the 100 RON headline
price would hand back money nobody paid.
"""
import uuid

import pytest
import requests
from motor.motor_asyncio import AsyncIOMotorClient

import server
import support
from support import API, TIMEOUT, MONGO_URL, DB_NAME, db

pytestmark = [pytest.mark.integration, pytest.mark.xdist_group("test_tier_lifecycle")]


@pytest.fixture(scope="module")
def anyio_backend():
    return "asyncio"


def _wave(name, **extra):
    w = {"name": name, "price_ron": 100.0, "capacity": 40,
         "starts_at": "2026-01-01T00:00:00+00:00", "ends_at": "2027-12-01T00:00:00+00:00"}
    w.update(extra)
    return w


@pytest.fixture
def make_event(admin_headers):
    made = []

    def factory(waves, **overrides):
        body = {
            "title": f"TEST_lifecycle_{uuid.uuid4().hex[:8]}",
            "slug": f"test-lifecycle-{uuid.uuid4().hex[:10]}",
            "description": "", "venue": "Club Pytest", "city": "Bucharest",
            "starts_at": "2028-01-01T20:00:00+00:00",
            "ends_at": "2028-01-02T04:00:00+00:00",
            "doors_open_at": "2028-01-01T20:00:00+00:00",
            "image_url": "", "artist_ids": [], "max_tickets_per_user": 20,
            "is_published": True, "sold_out_message": "", "waves": waves,
        }
        body.update(overrides)
        r = requests.post(f"{API}/admin/events", headers=admin_headers, json=body, timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        made.append(r.json()["event_id"])
        return r.json()

    yield factory
    for event_id in made:
        db.tickets.delete_many({"event_id": event_id})
        db.reservations.delete_many({"event_id": event_id})
        db.serial_counters.delete_many({"_id": {"$regex": f"^{event_id}"}})
        requests.delete(f"{API}/admin/events/{event_id}", headers=admin_headers, timeout=TIMEOUT)


@pytest.fixture
def patch_waves(admin_headers):
    """Send a tier list exactly as the editor does — the shape the delete guard reads."""
    def _patch(event_id, waves):
        return requests.patch(f"{API}/admin/events/{event_id}", headers=admin_headers,
                              json={"waves": waves}, timeout=TIMEOUT)
    return _patch


@pytest.fixture
async def sell(anyio_backend):
    """Issue tickets through the real finalize path, on this test's own loop.

    Driving the handler rather than /reservations for the same reason the serial tests do:
    the endpoint is rate-limited to 20 a minute, and these tests should not be spending a
    budget that exists to enforce a security control.
    """
    client = AsyncIOMotorClient(MONGO_URL)
    original = server.db
    server.db = client[DB_NAME]

    async def _sell(event, wave_index, pack_count, buyer_id, discount_percent=0):
        wave = event["waves"][wave_index]
        pack_size = int(wave.get("pack_size") or 1)
        rid = server.new_id("res")
        subtotal = wave["price_ron"] * pack_count
        await server.db.reservations.insert_one({
            "reservation_id": rid, "user_id": buyer_id, "event_id": event["event_id"],
            "wave_id": wave["wave_id"],
            "quantity": pack_count * pack_size,
            "pack_size": pack_size, "pack_count": pack_count,
            "unit_price_ron": wave["price_ron"],
            "subtotal_ron": subtotal,
            "discount_percent": discount_percent,
            "total_ron": round(subtotal * (1 - discount_percent / 100.0), 2),
            "status": "pending", "created_at": server.now_utc().isoformat(),
        })
        await server._finalize_paid_reservation(rid)
        return rid

    try:
        yield _sell
    finally:
        server.db = original
        client.close()


@pytest.fixture
def buyer():
    _headers, user_id, _email = support.mint_user("user")
    return user_id


# ---------------------------------------------------------------- deleting


class TestATierWithNothingBehindItCanGo:

    def test_an_unsold_tier_is_deleted_by_leaving_it_out(self, make_event, patch_waves):
        e = make_event([_wave("EARLY", tier_id=1), _wave("GENERAL", tier_id=2)])
        keep = [w for w in e["waves"] if w["name"] == "GENERAL"]
        r = patch_waves(e["event_id"], keep)
        assert r.status_code == 200, r.text
        assert [w["name"] for w in r.json()["waves"]] == ["GENERAL"]

    def test_the_admin_list_says_a_fresh_tier_has_sold_nothing(self, make_event, admin_headers):
        e = make_event([_wave("EARLY", tier_id=1)])
        r = requests.get(f"{API}/admin/events", headers=admin_headers, timeout=TIMEOUT)
        mine = next(x for x in r.json() if x["event_id"] == e["event_id"])
        assert mine["waves"][0]["sold"] == 0
        assert mine["waves"][0]["held"] == 0


@pytest.mark.anyio
class TestATierThatHasSoldCannotBeDeleted:

    async def test_dropping_a_sold_tier_is_refused(self, make_event, patch_waves, buyer, sell):
        e = make_event([_wave("EARLY", tier_id=1), _wave("GENERAL", tier_id=2)])
        await sell(e, 0, 1, buyer)
        keep = [w for w in e["waves"] if w["name"] == "GENERAL"]
        r = patch_waves(e["event_id"], keep)
        assert r.status_code == 400, r.text
        assert "EARLY" in r.text and "rchive" in r.text

    async def test_the_tier_and_its_sale_are_both_still_there_afterwards(
            self, make_event, patch_waves, buyer, sell, admin_headers):
        e = make_event([_wave("EARLY", tier_id=1), _wave("GENERAL", tier_id=2)])
        await sell(e, 0, 1, buyer)
        patch_waves(e["event_id"], [w for w in e["waves"] if w["name"] == "GENERAL"])

        r = requests.get(f"{API}/admin/events", headers=admin_headers, timeout=TIMEOUT)
        mine = next(x for x in r.json() if x["event_id"] == e["event_id"])
        assert [w["name"] for w in mine["waves"]] == ["EARLY", "GENERAL"]
        assert db.tickets.count_documents({"event_id": e["event_id"]}) == 1

    async def test_the_count_survives_a_refund(self, make_event, patch_waves, buyer, sell,
                                               admin_headers):
        """A refunded ticket still carries a serial allocated against this tier."""
        e = make_event([_wave("EARLY", tier_id=1)])
        await sell(e, 0, 1, buyer)
        t = db.tickets.find_one({"event_id": e["event_id"]})
        requests.post(f"{API}/admin/tickets/{t['ticket_id']}/refund",
                      headers=admin_headers, timeout=TIMEOUT)
        assert patch_waves(e["event_id"], []).status_code == 400


# ---------------------------------------------------------------- archiving


@pytest.mark.anyio
class TestArchivingIsWhatReplacesDeleting:

    async def test_an_archived_tier_leaves_the_event_page(self, make_event, patch_waves,
                                                          buyer, sell):
        e = make_event([_wave("EARLY", tier_id=1), _wave("GENERAL", tier_id=2)])
        await sell(e, 0, 1, buyer)
        waves = [{**w, "status": "archived" if w["name"] == "EARLY" else "active"}
                 for w in e["waves"]]
        assert patch_waves(e["event_id"], waves).status_code == 200

        public = requests.get(f"{API}/events/{e['slug']}", timeout=TIMEOUT).json()
        assert [w["name"] for w in public["waves"]] == ["GENERAL"]

    async def test_but_stays_in_the_admin_with_its_count(self, make_event, patch_waves,
                                                         buyer, sell, admin_headers):
        e = make_event([_wave("EARLY", tier_id=1)])
        await sell(e, 0, 2, buyer)
        patch_waves(e["event_id"], [{**w, "status": "archived"} for w in e["waves"]])

        r = requests.get(f"{API}/admin/events", headers=admin_headers, timeout=TIMEOUT)
        mine = next(x for x in r.json() if x["event_id"] == e["event_id"])
        assert mine["waves"][0]["status"] == "archived"
        assert mine["waves"][0]["sold"] == 2

    async def test_its_tickets_still_scan(self, make_event, patch_waves, buyer, sell,
                                          admin_headers):
        """The sale outliving the tier is the entire promise. A ticket whose tier was
        archived is a ticket somebody paid for."""
        e = make_event([_wave("EARLY", tier_id=1)],
                       starts_at="2026-01-02T20:00:00+00:00",
                       ends_at="2099-01-01T00:00:00+00:00",
                       doors_open_at="2026-01-02T20:00:00+00:00")
        await sell(e, 0, 1, buyer)
        patch_waves(e["event_id"], [{**w, "status": "archived"} for w in e["waves"]])

        t = db.tickets.find_one({"event_id": e["event_id"]})
        r = requests.post(f"{API}/scan", headers=admin_headers, timeout=TIMEOUT,
                          json={"qr_code": t["qr_code"]})
        assert r.json().get("valid") is True, r.text

    def test_an_archived_tier_cannot_be_bought(self, make_event, patch_waves, user_headers):
        e = make_event([_wave("EARLY", tier_id=1, status="archived")])
        r = requests.post(f"{API}/reservations", headers=user_headers, timeout=TIMEOUT,
                          json={"event_id": e["event_id"], "wave_id": e["waves"][0]["wave_id"],
                                "quantity": 1})
        support.skip_if_rate_limited(r, "reservations")
        assert r.status_code == 400 and "no longer on sale" in r.text

    def test_archiving_is_undone_by_setting_it_back(self, make_event, patch_waves):
        """The reason a sold tier is archived rather than deleted: archiving an
        event's last tier by mistake is a two-click mistake, not a permanent one."""
        e = make_event([_wave("EARLY", tier_id=1)])
        patch_waves(e["event_id"], [{**w, "status": "archived"} for w in e["waves"]])
        assert requests.get(f"{API}/events/{e['slug']}", timeout=TIMEOUT).json()["waves"] == []

        back = patch_waves(e["event_id"], [{**w, "status": "active"} for w in e["waves"]])
        assert back.status_code == 200, back.text
        public = requests.get(f"{API}/events/{e['slug']}", timeout=TIMEOUT).json()
        assert [w["name"] for w in public["waves"]] == ["EARLY"]
        assert public["waves"][0]["is_active"] is True

    def test_reactivating_finds_the_stock_where_it_was_left(self, make_event, patch_waves):
        e = make_event([_wave("EARLY", tier_id=1, capacity=40)])
        patch_waves(e["event_id"], [{**w, "status": "archived"} for w in e["waves"]])
        patch_waves(e["event_id"], [{**w, "status": "active"} for w in e["waves"]])
        public = requests.get(f"{API}/events/{e['slug']}", timeout=TIMEOUT).json()
        assert public["waves"][0]["available"] == 40


class TestPausingStopsSalesWithoutHiding:

    def test_a_paused_tier_is_still_listed(self, make_event):
        e = make_event([_wave("VIP", tier_id=1, status="paused")])
        public = requests.get(f"{API}/events/{e['slug']}", timeout=TIMEOUT).json()
        assert [w["name"] for w in public["waves"]] == ["VIP"]

    def test_but_is_not_offered_as_buyable(self, make_event):
        e = make_event([_wave("VIP", tier_id=1, status="paused")])
        public = requests.get(f"{API}/events/{e['slug']}", timeout=TIMEOUT).json()
        assert public["waves"][0]["is_active"] is False

    def test_and_is_refused_at_checkout(self, make_event, user_headers):
        e = make_event([_wave("VIP", tier_id=1, status="paused")])
        r = requests.post(f"{API}/reservations", headers=user_headers, timeout=TIMEOUT,
                          json={"event_id": e["event_id"], "wave_id": e["waves"][0]["wave_id"],
                                "quantity": 1})
        support.skip_if_rate_limited(r, "reservations")
        assert r.status_code == 400 and "not on sale right now" in r.text

    def test_an_unknown_state_is_refused_by_name(self, admin_headers, make_event):
        e = make_event([_wave("VIP", tier_id=1)])
        r = requests.patch(f"{API}/admin/events/{e['event_id']}", headers=admin_headers,
                           json={"waves": [{**e["waves"][0], "status": "retired"}]},
                           timeout=TIMEOUT)
        assert r.status_code == 400 and "VIP" in r.text


# ---------------------------------------------------------------- group tickets


class TestThePackSplit:
    """The arithmetic on its own, before anything is sold with it."""

    def test_four_for_the_price_of_three_is_four_equal_shares(self):
        assert server._pack_ticket_prices(300, 4) == [75.0, 75.0, 75.0, 75.0]

    def test_a_single_is_just_the_price(self):
        assert server._pack_ticket_prices(100, 1) == [100.0]

    def test_cents_that_do_not_divide_land_on_the_earliest_tickets(self):
        assert server._pack_ticket_prices(100, 3) == [33.34, 33.33, 33.33]

    def test_and_the_shares_always_add_back_up_to_the_pack(self):
        for price in (100, 150.5, 99.99, 300, 12.01):
            for size in range(1, 9):
                shares = server._pack_ticket_prices(price, size)
                assert round(sum(shares), 2) == round(price, 2), (price, size, shares)


class TestAPackTierIsEditable:

    def test_capacity_has_to_be_a_whole_number_of_packs(self, admin_headers):
        r = requests.post(f"{API}/admin/events", headers=admin_headers, timeout=TIMEOUT, json={
            "title": "TEST_lifecycle_bad", "slug": f"test-bad-{uuid.uuid4().hex[:8]}",
            "starts_at": "2028-01-01T20:00:00+00:00", "is_published": False,
            "waves": [_wave("GROUP", pack_size=3, capacity=50)],
        })
        assert r.status_code == 400 and "divide by 3" in r.text

    def test_a_nonsense_pack_size_is_refused(self, admin_headers):
        r = requests.post(f"{API}/admin/events", headers=admin_headers, timeout=TIMEOUT, json={
            "title": "TEST_lifecycle_bad2", "slug": f"test-bad-{uuid.uuid4().hex[:8]}",
            "starts_at": "2028-01-01T20:00:00+00:00", "is_published": False,
            "waves": [_wave("GROUP", pack_size=0)],
        })
        assert r.status_code in (400, 422), r.text


class TestBuyingAPack:

    def test_one_pack_draws_its_whole_size_off_the_stock(self, make_event, user_headers):
        e = make_event([_wave("GROUP", tier_id=1, pack_size=4, price_ron=300.0, capacity=40)])
        r = requests.post(f"{API}/reservations", headers=user_headers, timeout=TIMEOUT,
                          json={"event_id": e["event_id"], "wave_id": e["waves"][0]["wave_id"],
                                "quantity": 1})
        support.skip_if_rate_limited(r, "reservations")
        assert r.status_code == 200, r.text
        res = r.json()
        # One pack bought, four tickets held, 300 RON charged.
        assert res["pack_count"] == 1
        assert res["pack_size"] == 4
        assert res["quantity"] == 4
        assert res["unit_price_ron"] == 300.0
        assert res["subtotal_ron"] == 300.0

        public = requests.get(f"{API}/events/{e['slug']}", timeout=TIMEOUT).json()
        assert public["waves"][0]["available"] == 36
        db.reservations.delete_many({"reservation_id": res["reservation_id"]})

    def test_the_per_user_cap_counts_people_not_packs(self, make_event, user_headers):
        """A cap of 4 and a pack of 4 is one pack per buyer — the cap is a headcount."""
        e = make_event([_wave("GROUP", tier_id=1, pack_size=4, price_ron=300.0, capacity=40)],
                       max_tickets_per_user=4)
        r = requests.post(f"{API}/reservations", headers=user_headers, timeout=TIMEOUT,
                          json={"event_id": e["event_id"], "wave_id": e["waves"][0]["wave_id"],
                                "quantity": 2})
        support.skip_if_rate_limited(r, "reservations")
        assert r.status_code == 400 and "limit" in r.text.lower()


@pytest.mark.anyio
class TestWhatAPackIssues:

    async def test_a_four_pack_issues_four_tickets(self, make_event, buyer, sell):
        e = make_event([_wave("GROUP", tier_id=1, pack_size=4, price_ron=300.0, capacity=40)])
        await sell(e, 0, 1, buyer)
        assert db.tickets.count_documents({"event_id": e["event_id"]}) == 4

    async def test_each_one_carries_its_own_quarter_of_what_was_paid(
            self, make_event, buyer, sell):
        """The requirement in one line: 4 at the price of 3 is 75 a ticket, not 100."""
        e = make_event([_wave("GROUP", tier_id=1, pack_size=4, price_ron=300.0, capacity=40)])
        await sell(e, 0, 1, buyer)
        prices = [t["price_ron"] for t in db.tickets.find({"event_id": e["event_id"]})]
        assert prices == [75.0, 75.0, 75.0, 75.0]
        assert round(sum(prices), 2) == 300.0

    async def test_every_ticket_gets_its_own_serial_and_qr(self, make_event, buyer, sell):
        e = make_event([_wave("GROUP", tier_id=1, pack_size=4, price_ron=300.0, capacity=40)])
        await sell(e, 0, 1, buyer)
        rows = list(db.tickets.find({"event_id": e["event_id"]}))
        assert len({t["serial"] for t in rows}) == 4
        assert len({t["qr_code"] for t in rows}) == 4

    async def test_the_four_are_marked_as_one_pack(self, make_event, buyer, sell):
        e = make_event([_wave("GROUP", tier_id=1, pack_size=4, price_ron=300.0, capacity=40)])
        await sell(e, 0, 2, buyer)
        rows = list(db.tickets.find({"event_id": e["event_id"]}))
        assert len(rows) == 8
        packs = {}
        for t in rows:
            packs.setdefault(t["pack_id"], []).append(t["pack_index"])
        assert len(packs) == 2, "two packs bought, two pack ids"
        assert all(sorted(v) == [1, 2, 3, 4] for v in packs.values())

    async def test_an_ordinary_tier_is_untouched_by_any_of_it(self, make_event, buyer, sell):
        e = make_event([_wave("GENERAL", tier_id=1, price_ron=100.0)])
        await sell(e, 0, 3, buyer)
        rows = list(db.tickets.find({"event_id": e["event_id"]}))
        assert [t["price_ron"] for t in rows] == [100.0, 100.0, 100.0]
        assert all("pack_id" not in t for t in rows)


@pytest.mark.anyio
class TestRefundingOneOfAPack:

    async def test_one_seat_refunds_its_own_share(self, make_event, buyer, sell,
                                                  admin_headers):
        """A guest refused admission on a 300 RON four-pack is owed 75."""
        e = make_event([_wave("GROUP", tier_id=1, pack_size=4, price_ron=300.0, capacity=40)])
        await sell(e, 0, 1, buyer)
        t = db.tickets.find_one({"event_id": e["event_id"], "pack_index": 2})
        r = requests.post(f"{API}/admin/tickets/{t['ticket_id']}/refund",
                          headers=admin_headers, timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        assert r.json()["refund_amount_ron"] == 75.0

    async def test_the_other_three_are_untouched(self, make_event, buyer, sell, admin_headers):
        e = make_event([_wave("GROUP", tier_id=1, pack_size=4, price_ron=300.0, capacity=40)])
        await sell(e, 0, 1, buyer)
        t = db.tickets.find_one({"event_id": e["event_id"], "pack_index": 2})
        requests.post(f"{API}/admin/tickets/{t['ticket_id']}/refund",
                      headers=admin_headers, timeout=TIMEOUT)
        rest = list(db.tickets.find({"event_id": e["event_id"], "status": "issued"}))
        assert len(rest) == 3
        assert all(x["price_ron"] == 75.0 for x in rest)

    async def test_the_amount_is_written_onto_the_ticket(self, make_event, buyer, sell,
                                                         admin_headers):
        e = make_event([_wave("GROUP", tier_id=1, pack_size=4, price_ron=300.0, capacity=40)])
        await sell(e, 0, 1, buyer)
        t = db.tickets.find_one({"event_id": e["event_id"], "pack_index": 1})
        requests.post(f"{API}/admin/tickets/{t['ticket_id']}/refund",
                      headers=admin_headers, timeout=TIMEOUT)
        after = db.tickets.find_one({"ticket_id": t["ticket_id"]})
        assert after["refund_amount_ron"] == 75.0

    async def test_a_discounted_order_refunds_what_was_actually_charged(
            self, make_event, buyer, sell, admin_headers):
        """20% off a 300 pack is 240 paid, so one of its four seats is worth 60 back —
        not the 75 the ticket lists."""
        e = make_event([_wave("GROUP", tier_id=1, pack_size=4, price_ron=300.0, capacity=40)])
        await sell(e, 0, 1, buyer, discount_percent=20)
        t = db.tickets.find_one({"event_id": e["event_id"], "pack_index": 1})
        r = requests.post(f"{API}/admin/tickets/{t['ticket_id']}/refund",
                          headers=admin_headers, timeout=TIMEOUT)
        assert r.json()["refund_amount_ron"] == 60.0


@pytest.mark.anyio
class TestWhatTheFiscalViewsSay:

    async def test_the_summary_multiplies_out_to_the_pack_price(self, make_event, buyer,
                                                                sell, admin_headers):
        e = make_event([_wave("GROUP", tier_id=1, pack_size=4, price_ron=300.0, capacity=40)])
        await sell(e, 0, 1, buyer)
        r = requests.get(f"{API}/admin/transactions/summary",
                         headers=admin_headers, params={"event_id": e["event_id"]},
                         timeout=TIMEOUT)
        lines = r.json()["lines"]
        assert len(lines) == 1
        assert lines[0]["tickets_sold"] == 4
        assert lines[0]["unit_price_ron"] == 75.0
        assert lines[0]["total_ron"] == 300.0

    async def test_the_csv_says_which_sale_the_four_rows_came_from(
            self, make_event, buyer, sell, admin_headers):
        e = make_event([_wave("GROUP", tier_id=1, pack_size=4, price_ron=300.0, capacity=40)])
        await sell(e, 0, 1, buyer)
        r = requests.get(f"{API}/admin/transactions.csv", headers=admin_headers,
                         params={"event_id": e["event_id"]}, timeout=TIMEOUT)
        header, *rows = [ln for ln in r.text.splitlines() if ln.strip()]
        assert header.endswith("pack_size,pack_id")
        assert len(rows) == 4
        pack_ids = {ln.rsplit(",", 1)[-1] for ln in rows}
        assert len(pack_ids) == 1, "four rows, one sale"
