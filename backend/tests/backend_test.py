"""
Supersanity — Backend regression + iteration-2 tests
Covers:
  - Wave-decrement regression ($elemMatch fix)
  - Sold-out edge (400, no decrement)
  - Discount code WELCOME10
  - Stripe checkout session creation
  - _finalize_paid_reservation idempotency
  - /my/tickets, invoice PDF
  - Door scan (valid, repeat, not-found, RBAC)
  - Admin CRUD for artists/projects/discounts/special-links/gallery/events
  - Special link flow (price override, wave preservation, used counter)
  - Event cancel + order refund
"""
import os
import sys
import asyncio
import time
import uuid
import subprocess

import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "http://localhost:8000").rstrip("/")
API = f"{BASE_URL}/api"

sys.path.insert(0, "/app/backend")

# Global tokens injected by conftest via env vars
ADMIN_TOKEN = os.environ.get("UMB_ADMIN_TOKEN")
DOOR_TOKEN = os.environ.get("UMB_DOOR_TOKEN")
USER_TOKEN = os.environ.get("UMB_USER_TOKEN")
USER2_TOKEN = os.environ.get("UMB_USER2_TOKEN")


def _bearer(token):
    return {"Authorization": f"Bearer {token}"}


def _mint_fresh_user_token(role="user"):
    """Insert a new user + session via mongosh and return the token."""
    import subprocess as _sp
    tok = f"test_{role}_{uuid.uuid4().hex[:12]}"
    uid = f"test-{role}-{uuid.uuid4().hex[:12]}"
    email = f"{role}.{uuid.uuid4().hex[:8]}@umbra.test"
    js = f"""
    use('test_database');
    db.users.insertOne({{user_id:'{uid}',email:'{email}',name:'{role} fresh',picture:'',phone:'',role:'{role}',created_at:new Date().toISOString()}});
    db.user_sessions.insertOne({{user_id:'{uid}',session_token:'{tok}',expires_at:new Date(Date.now()+7*24*3600*1000).toISOString(),created_at:new Date().toISOString()}});
    """
    p = _sp.run(["mongosh", "--quiet", "--eval", js], capture_output=True, text=True, timeout=15)
    assert p.returncode == 0, p.stderr
    return tok


def _fresh_user_headers(role="user"):
    return _bearer(_mint_fresh_user_token(role))


# ---------------- Fixtures ----------------

@pytest.fixture(scope="session")
def admin_headers():
    assert ADMIN_TOKEN, "Missing admin token"
    return _bearer(ADMIN_TOKEN)


@pytest.fixture(scope="session")
def door_headers():
    return _bearer(DOOR_TOKEN)


@pytest.fixture(scope="session")
def user_headers():
    return _bearer(USER_TOKEN)


@pytest.fixture(scope="session")
def user2_headers():
    return _bearer(USER2_TOKEN)


@pytest.fixture(scope="session")
def obsidian_event(admin_headers):
    """Get seeded OBSIDIAN event with 3 waves."""
    # Ensure seed
    requests.post(f"{API}/seed", timeout=15)
    r = requests.get(f"{API}/events/obsidian-chapter-i", timeout=15)
    assert r.status_code == 200, r.text
    ev = r.json()
    assert len(ev["waves"]) == 3
    return ev


# ---------------- 0. Sanity ----------------

def test_auth_me_admin(admin_headers):
    r = requests.get(f"{API}/auth/me", headers=admin_headers, timeout=15)
    assert r.status_code == 200
    assert r.json()["role"] == "admin"


def test_auth_me_user(user_headers):
    r = requests.get(f"{API}/auth/me", headers=user_headers, timeout=15)
    assert r.status_code == 200
    assert r.json()["role"] == "user"


# ---------------- 1. Wave-decrement REGRESSION ----------------

def test_reservation_decrements_correct_wave(obsidian_event):
    """Reserving on GENERAL must reduce ONLY GENERAL, not EARLY_BIRD."""
    user_headers = _fresh_user_headers()
    ev = obsidian_event

    # Capture 'before' state RIGHT NOW, not from the session-scoped fixture.
    # Parallel tests (via pytest-xdist) may have mutated inventory since the
    # fixture snapshot was taken.
    r0 = requests.get(f"{API}/events/obsidian-chapter-i", timeout=15)
    assert r0.status_code == 200
    ev_now = r0.json()
    waves_before = {w["tier"]: w["available"] for w in ev_now["waves"]}
    general_wave = next(w for w in ev_now["waves"] if w["tier"] == "general")

    payload = {
        "event_id": ev["event_id"],
        "wave_id": general_wave["wave_id"],
        "quantity": 2,
    }
    r = requests.post(f"{API}/reservations", json=payload, headers=user_headers, timeout=15)
    assert r.status_code == 200, r.text
    res = r.json()
    assert res["quantity"] == 2
    assert res["status"] == "pending"

    # Re-fetch event
    r2 = requests.get(f"{API}/events/obsidian-chapter-i", timeout=15)
    assert r2.status_code == 200
    ev2 = r2.json()
    waves_after = {w["tier"]: w["available"] for w in ev2["waves"]}

    assert waves_after["general"] == waves_before["general"] - 2, \
        f"GENERAL should decrement by 2. Before={waves_before}, After={waves_after}"
    assert waves_after["early_bird"] == waves_before["early_bird"], \
        f"EARLY_BIRD MUST NOT decrement. Before={waves_before}, After={waves_after}"
    assert waves_after["vip"] == waves_before["vip"], \
        f"VIP MUST NOT decrement. Before={waves_before}, After={waves_after}"

    # Save reservation for later cleanup / finalize test isn't needed here
    pytest.regression_res_id = res["reservation_id"]


# ---------------- 2. Sold-out edge ----------------

def test_reserve_more_than_available_returns_400(obsidian_event):
    user2_headers = _fresh_user_headers()
    ev = obsidian_event
    # Refresh event
    ev = requests.get(f"{API}/events/obsidian-chapter-i", timeout=15).json()
    vip_wave = next(w for w in ev["waves"] if w["tier"] == "vip")
    available_before = vip_wave["available"]

    # Request way more than available
    payload = {
        "event_id": ev["event_id"],
        "wave_id": vip_wave["wave_id"],
        "quantity": available_before + 100,
    }
    r = requests.post(f"{API}/reservations", json=payload, headers=user2_headers, timeout=15)
    assert r.status_code == 400, r.text

    # Verify no decrement
    ev2 = requests.get(f"{API}/events/obsidian-chapter-i", timeout=15).json()
    vip_after = next(w for w in ev2["waves"] if w["tier"] == "vip")
    assert vip_after["available"] == available_before, "wave.available must not decrement on sold-out"


# ---------------- 3. Discount code WELCOME10 ----------------

def test_discount_welcome10_applied(obsidian_event):
    user2_headers = _fresh_user_headers()
    ev = requests.get(f"{API}/events/obsidian-chapter-i", timeout=15).json()
    general = next(w for w in ev["waves"] if w["tier"] == "general")
    qty = 1
    payload = {
        "event_id": ev["event_id"],
        "wave_id": general["wave_id"],
        "quantity": qty,
        "discount_code": "WELCOME10",
    }
    r = requests.post(f"{API}/reservations", json=payload, headers=user2_headers, timeout=15)
    assert r.status_code == 200, r.text
    res = r.json()
    unit = float(general["price_ron"])
    expected_total = round(unit * qty * 0.9, 2)
    assert res["discount_percent"] == 10
    assert res["discount_code"] == "WELCOME10"
    assert abs(res["total_ron"] - expected_total) < 0.01, f"expected {expected_total}, got {res['total_ron']}"


# ---------------- 4. Stripe checkout ----------------

def _create_reservation_for(user_headers, quantity=1):
    ev = requests.get(f"{API}/events/obsidian-chapter-i", timeout=15).json()
    general = next(w for w in ev["waves"] if w["tier"] == "general")
    payload = {
        "event_id": ev["event_id"],
        "wave_id": general["wave_id"],
        "quantity": quantity,
    }
    r = requests.post(f"{API}/reservations", json=payload, headers=user_headers, timeout=15)
    assert r.status_code == 200, r.text
    return r.json()


def test_checkout_returns_url_and_creates_txn():
    user_headers = _fresh_user_headers()
    res = _create_reservation_for(user_headers, quantity=1)
    payload = {
        "reservation_id": res["reservation_id"],
        "origin_url": BASE_URL,
    }
    r = requests.post(f"{API}/checkout", json=payload, headers=user_headers, timeout=30)
    assert r.status_code == 200, r.text
    data = r.json()
    assert "url" in data and data["url"].startswith("http"), data
    assert "session_id" in data and data["session_id"]

    # Verify persistence
    from motor.motor_asyncio import AsyncIOMotorClient
    mongo_url = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
    dbname = os.environ.get("DB_NAME", "test_database")

    async def check():
        c = AsyncIOMotorClient(mongo_url)
        d = c[dbname]
        tx = await d.payment_transactions.find_one({"session_id": data["session_id"]}, {"_id": 0})
        r_doc = await d.reservations.find_one({"reservation_id": res["reservation_id"]}, {"_id": 0})
        c.close()
        return tx, r_doc

    tx, r_doc = asyncio.run(check())
    assert tx is not None, "payment_transactions row missing"
    assert tx["payment_status"] == "initiated"
    assert r_doc["stripe_session_id"] == data["session_id"]


# ---------------- 5. Finalize idempotency ----------------

def _mint_fresh_user_token(role="user"):
    """Insert a new user + session via mongosh and return the token."""
    tok = f"test_{role}_{uuid.uuid4().hex[:12]}"
    uid = f"test-{role}-{uuid.uuid4().hex[:12]}"
    email = f"{role}.{uuid.uuid4().hex[:8]}@umbra.test"
    js = f"""
    use('test_database');
    db.users.insertOne({{user_id:'{uid}',email:'{email}',name:'{role} fresh',picture:'',phone:'',role:'{role}',created_at:new Date().toISOString()}});
    db.user_sessions.insertOne({{user_id:'{uid}',session_token:'{tok}',expires_at:new Date(Date.now()+7*24*3600*1000).toISOString(),created_at:new Date().toISOString()}});
    """
    p = subprocess.run(["mongosh", "--quiet", "--eval", js], capture_output=True, text=True, timeout=15)
    assert p.returncode == 0, p.stderr
    return tok


def test_finalize_idempotency():
    """Create pending reservation as fresh user, call _finalize_paid_reservation twice."""
    fresh_headers = _fresh_user_headers()
    res = _create_reservation_for(fresh_headers, quantity=2)
    pytest.finalize_user_headers = fresh_headers
    rid = res["reservation_id"]

    # Call finalize twice via subprocess (fresh event loop each call)
    def finalize(rid):
        code = (
            "import asyncio, sys; sys.path.insert(0,'/app/backend'); "
            "from server import _finalize_paid_reservation; "
            f"asyncio.run(_finalize_paid_reservation('{rid}'))"
        )
        return subprocess.run(["python3", "-c", code], capture_output=True, text=True, timeout=30)

    p1 = finalize(rid)
    assert p1.returncode == 0, f"finalize 1 failed: {p1.stderr}"
    p2 = finalize(rid)
    assert p2.returncode == 0, f"finalize 2 failed: {p2.stderr}"

    # Verify
    from motor.motor_asyncio import AsyncIOMotorClient
    mongo_url = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
    dbname = os.environ.get("DB_NAME", "test_database")

    async def check():
        c = AsyncIOMotorClient(mongo_url)
        d = c[dbname]
        r_doc = await d.reservations.find_one({"reservation_id": rid}, {"_id": 0})
        tickets = await d.tickets.find({"reservation_id": rid}, {"_id": 0}).to_list(100)
        invoices = await d.invoices.find({"reservation_id": rid}, {"_id": 0}).to_list(100)
        c.close()
        return r_doc, tickets, invoices

    r_doc, tickets, invoices = asyncio.run(check())
    assert r_doc["status"] == "paid"
    assert len(tickets) == 2, f"expected 2 tickets, got {len(tickets)}"
    qrs = {t["qr_code"] for t in tickets}
    assert len(qrs) == 2, "QR codes must be unique"
    assert len(invoices) == 1, f"expected 1 invoice, got {len(invoices)}"
    assert invoices[0]["number"] >= 1000

    pytest.finalized_rid = rid
    pytest.finalized_ticket_qr = tickets[0]["qr_code"]
    pytest.finalized_invoice_id = invoices[0]["invoice_id"]


# ---------------- 6. /my/tickets ----------------

def test_my_tickets_returns_caller_only():
    other_headers = _fresh_user_headers()
    fresh_headers = pytest.finalize_user_headers
    r = requests.get(f"{API}/my/tickets", headers=fresh_headers, timeout=15)
    assert r.status_code == 200
    tickets = r.json()
    assert len(tickets) >= 2, f"user should have >= 2 tickets, got {len(tickets)}"
    for t in tickets:
        assert "event" in t and t["event"] is not None, "must embed event"
        assert t["event"].get("title")

    # Other user should not see these
    r2 = requests.get(f"{API}/my/tickets", headers=other_headers, timeout=15)
    assert r2.status_code == 200
    tickets2 = r2.json()
    my_qrs = {t["qr_code"] for t in tickets}
    other_qrs = {t["qr_code"] for t in tickets2}
    assert my_qrs.isdisjoint(other_qrs), "ticket leak between users"


# ---------------- 7. Invoice PDF ----------------

def test_invoice_pdf():
    inv_id = pytest.finalized_invoice_id
    fresh_headers = pytest.finalize_user_headers
    r = requests.get(f"{API}/invoices/{inv_id}/pdf", headers=fresh_headers, timeout=15)
    assert r.status_code == 200, r.text
    assert r.headers.get("content-type", "").startswith("application/pdf")
    assert r.content[:4] == b"%PDF", f"bad pdf header: {r.content[:8]}"


# ---------------- 8. Door scan ----------------

@pytest.fixture(scope="session")
def scannable_event(admin_headers):
    """Create a fresh event with doors_open_at in the past, then reserve+finalize a ticket."""
    user_headers = _fresh_user_headers()
    from datetime import datetime, timezone, timedelta
    now = datetime.now(timezone.utc)
    starts = (now - timedelta(hours=1)).isoformat()
    ends = (now + timedelta(hours=6)).isoformat()
    doors = (now - timedelta(hours=2)).isoformat()
    wave_start = (now - timedelta(hours=3)).isoformat()
    wave_end = (now + timedelta(days=2)).isoformat()

    payload = {
        "title": "SCAN TEST EVENT",
        "slug": f"scan-test-{uuid.uuid4().hex[:6]}",
        "description": "scan test",
        "venue": "Test Venue",
        "starts_at": starts,
        "ends_at": ends,
        "doors_open_at": doors,
        "image_url": "",
        "artist_ids": [],
        "max_tickets_per_user": 4,
        "is_published": True,
        "waves": [{
            "name": "GENERAL", "price_ron": 50.0, "capacity": 10,
            "starts_at": wave_start, "ends_at": wave_end, "tier": "general",
        }],
    }
    r = requests.post(f"{API}/admin/events", json=payload, headers=admin_headers, timeout=15)
    assert r.status_code == 200, r.text
    ev = r.json()
    assert ev["event_id"]
    assert len(ev["waves"]) == 1
    wave = ev["waves"][0]
    assert wave.get("wave_id"), "wave_id must be assigned"
    assert wave.get("available") == wave["capacity"], "available must be initialized to capacity"

    # Reserve 1 ticket
    rp = {"event_id": ev["event_id"], "wave_id": wave["wave_id"], "quantity": 1}
    rr = requests.post(f"{API}/reservations", json=rp, headers=user_headers, timeout=15)
    assert rr.status_code == 200, rr.text
    rid = rr.json()["reservation_id"]

    # Finalize
    code = (
        "import asyncio, sys; sys.path.insert(0,'/app/backend'); "
        "from server import _finalize_paid_reservation; "
        f"asyncio.run(_finalize_paid_reservation('{rid}'))"
    )
    p = subprocess.run(["python3", "-c", code], capture_output=True, text=True, timeout=30)
    assert p.returncode == 0, p.stderr

    # Fetch ticket
    tr = requests.get(f"{API}/my/tickets", headers=user_headers, timeout=15)
    tickets = [t for t in tr.json() if t["event_id"] == ev["event_id"]]
    assert len(tickets) == 1
    return {"event": ev, "ticket": tickets[0], "reservation_id": rid}


def test_scan_valid_then_already_scanned(scannable_event, door_headers):
    qr = scannable_event["ticket"]["qr_code"]
    r1 = requests.post(f"{API}/scan", json={"qr_code": qr}, headers=door_headers, timeout=15)
    assert r1.status_code == 200, r1.text
    d = r1.json()
    assert d["valid"] is True, d
    assert d["ticket"]["status"] == "used"

    # Repeat
    r2 = requests.post(f"{API}/scan", json={"qr_code": qr}, headers=door_headers, timeout=15)
    assert r2.status_code == 200
    d2 = r2.json()
    assert d2["valid"] is False
    assert "ALREADY" in d2["reason"] or "USED" in d2["reason"]


def test_scan_unknown_qr(door_headers):
    r = requests.post(f"{API}/scan", json={"qr_code": "UMB-NOPE-NOPE"}, headers=door_headers, timeout=15)
    assert r.status_code == 200
    d = r.json()
    assert d["valid"] is False
    assert "NOT FOUND" in d["reason"]


def test_scan_forbidden_for_user(user_headers):
    r = requests.post(f"{API}/scan", json={"qr_code": "anything"}, headers=user_headers, timeout=15)
    assert r.status_code == 403


# ---------------- 9. Admin CRUD ----------------

def test_admin_artists_crud(admin_headers):
    body = {"name": "TEST_Artist", "slug": f"test-artist-{uuid.uuid4().hex[:6]}", "bio": "b"}
    r = requests.post(f"{API}/admin/artists", json=body, headers=admin_headers, timeout=15)
    assert r.status_code == 200, r.text
    a = r.json()
    aid = a["artist_id"]

    r2 = requests.get(f"{API}/admin/artists", headers=admin_headers, timeout=15)
    assert r2.status_code == 200
    assert any(x["artist_id"] == aid for x in r2.json())

    r3 = requests.delete(f"{API}/admin/artists/{aid}", headers=admin_headers, timeout=15)
    assert r3.status_code == 200


def test_admin_projects_crud(admin_headers):
    body = {"title": "TEST_Project", "slug": f"tp-{uuid.uuid4().hex[:6]}", "description": "d"}
    r = requests.post(f"{API}/admin/projects", json=body, headers=admin_headers, timeout=15)
    assert r.status_code == 200
    pid = r.json()["project_id"]
    r2 = requests.get(f"{API}/admin/projects", headers=admin_headers, timeout=15)
    assert any(x["project_id"] == pid for x in r2.json())
    r3 = requests.delete(f"{API}/admin/projects/{pid}", headers=admin_headers, timeout=15)
    assert r3.status_code == 200


def test_admin_discounts_crud(admin_headers):
    body = {"code": f"TEST{uuid.uuid4().hex[:4].upper()}", "percent_off": 15, "max_uses": 5}
    r = requests.post(f"{API}/admin/discounts", json=body, headers=admin_headers, timeout=15)
    assert r.status_code == 200
    did = r.json()["discount_id"]
    r2 = requests.get(f"{API}/admin/discounts", headers=admin_headers, timeout=15)
    assert any(x["discount_id"] == did for x in r2.json())
    r3 = requests.delete(f"{API}/admin/discounts/{did}", headers=admin_headers, timeout=15)
    assert r3.status_code == 200


def test_admin_gallery_crud(admin_headers):
    body = {"image_url": "https://example.com/x.jpg", "caption": "TEST_gallery"}
    r = requests.post(f"{API}/admin/gallery", json=body, headers=admin_headers, timeout=15)
    assert r.status_code == 200
    gid = r.json()["gallery_id"]
    r2 = requests.get(f"{API}/admin/gallery", headers=admin_headers, timeout=15)
    assert any(x["gallery_id"] == gid for x in r2.json())
    r3 = requests.delete(f"{API}/admin/gallery/{gid}", headers=admin_headers, timeout=15)
    assert r3.status_code == 200


def test_admin_event_create_patch_delete(admin_headers):
    from datetime import datetime, timezone, timedelta
    now = datetime.now(timezone.utc)
    payload = {
        "title": "TEST_EVENT",
        "slug": f"test-event-{uuid.uuid4().hex[:6]}",
        "description": "d",
        "venue": "V",
        "starts_at": (now + timedelta(days=30)).isoformat(),
        "ends_at": (now + timedelta(days=30, hours=4)).isoformat(),
        "doors_open_at": (now + timedelta(days=30) - timedelta(hours=1)).isoformat(),
        "image_url": "",
        "artist_ids": [],
        "max_tickets_per_user": 2,
        "is_published": False,
        "waves": [{
            "name": "GA", "price_ron": 100.0, "capacity": 50,
            "starts_at": now.isoformat(), "ends_at": (now + timedelta(days=25)).isoformat(),
            "tier": "general",
        }],
    }
    r = requests.post(f"{API}/admin/events", json=payload, headers=admin_headers, timeout=15)
    assert r.status_code == 200
    ev = r.json()
    eid = ev["event_id"]
    w = ev["waves"][0]
    assert w["wave_id"] and w["available"] == 50

    # PATCH
    r2 = requests.patch(f"{API}/admin/events/{eid}", json={"is_published": True}, headers=admin_headers, timeout=15)
    assert r2.status_code == 200
    assert r2.json()["is_published"] is True

    # CANCEL
    r3 = requests.post(f"{API}/admin/events/{eid}/cancel", headers=admin_headers, timeout=15)
    assert r3.status_code == 200

    # DELETE
    r4 = requests.delete(f"{API}/admin/events/{eid}", headers=admin_headers, timeout=15)
    assert r4.status_code == 200


# ---------------- 10. Special link flow ----------------

def test_special_link_flow(admin_headers):
    user2_headers = _fresh_user_headers()
    # Get scannable event? No, use obsidian
    ev = requests.get(f"{API}/events/obsidian-chapter-i", timeout=15).json()
    general = next(w for w in ev["waves"] if w["tier"] == "general")
    avail_before = general["available"]

    # Create special link
    body = {"event_id": ev["event_id"], "label": "TEST_special", "price_ron": 5.0, "capacity": 3}
    r = requests.post(f"{API}/admin/special-links", json=body, headers=admin_headers, timeout=15)
    assert r.status_code == 200
    sl = r.json()
    token = sl["token"]

    # GET /special-links/{token}
    r2 = requests.get(f"{API}/special-links/{token}", timeout=15)
    assert r2.status_code == 200
    d = r2.json()
    assert d["link"]["token"] == token
    assert d["event"]["event_id"] == ev["event_id"]

    # Reserve with special_link_token
    payload = {
        "event_id": ev["event_id"],
        "wave_id": general["wave_id"],
        "quantity": 2,
        "special_link_token": token,
    }
    rr = requests.post(f"{API}/reservations", json=payload, headers=user2_headers, timeout=15)
    assert rr.status_code == 200, rr.text
    res = rr.json()
    assert res["unit_price_ron"] == 5.0, f"price should be from special link: {res}"
    assert res["total_ron"] == 10.0

    # Wave should NOT decrement
    ev2 = requests.get(f"{API}/events/obsidian-chapter-i", timeout=15).json()
    gen2 = next(w for w in ev2["waves"] if w["tier"] == "general")
    assert gen2["available"] == avail_before, "special link must NOT decrement wave"

    # Finalize
    rid = res["reservation_id"]
    code = (
        "import asyncio, sys; sys.path.insert(0,'/app/backend'); "
        "from server import _finalize_paid_reservation; "
        f"asyncio.run(_finalize_paid_reservation('{rid}'))"
    )
    p = subprocess.run(["python3", "-c", code], capture_output=True, text=True, timeout=30)
    assert p.returncode == 0, p.stderr

    # Verify special_links.used incremented by quantity
    r3 = requests.get(f"{API}/special-links/{token}", timeout=15)
    assert r3.json()["link"]["used"] == 2

    # Cleanup
    requests.delete(f"{API}/admin/special-links/{sl['link_id']}", headers=admin_headers, timeout=15)


# ---------------- 11. Event cancel + Order refund ----------------

def test_event_cancel_refunds_tickets(admin_headers):
    """Create event, buy ticket, finalize, cancel event -> ticket refunded."""
    user_headers = _fresh_user_headers()
    from datetime import datetime, timezone, timedelta
    now = datetime.now(timezone.utc)
    payload = {
        "title": "TEST_CANCEL_EVENT",
        "slug": f"cancel-{uuid.uuid4().hex[:6]}",
        "description": "d", "venue": "V",
        "starts_at": (now + timedelta(days=10)).isoformat(),
        "ends_at": (now + timedelta(days=10, hours=3)).isoformat(),
        "doors_open_at": (now + timedelta(days=10) - timedelta(hours=1)).isoformat(),
        "image_url": "", "artist_ids": [],
        "max_tickets_per_user": 4, "is_published": True,
        "waves": [{
            "name": "GA", "price_ron": 20.0, "capacity": 5,
            "starts_at": now.isoformat(), "ends_at": (now + timedelta(days=9)).isoformat(),
            "tier": "general",
        }],
    }
    r = requests.post(f"{API}/admin/events", json=payload, headers=admin_headers, timeout=15)
    assert r.status_code == 200
    ev = r.json()
    wid = ev["waves"][0]["wave_id"]

    # Reserve
    rp = {"event_id": ev["event_id"], "wave_id": wid, "quantity": 1}
    rr = requests.post(f"{API}/reservations", json=rp, headers=user_headers, timeout=15)
    assert rr.status_code == 200
    rid = rr.json()["reservation_id"]
    code = (
        "import asyncio, sys; sys.path.insert(0,'/app/backend'); "
        "from server import _finalize_paid_reservation; "
        f"asyncio.run(_finalize_paid_reservation('{rid}'))"
    )
    subprocess.run(["python3", "-c", code], capture_output=True, text=True, timeout=30)

    # Cancel event
    rc = requests.post(f"{API}/admin/events/{ev['event_id']}/cancel", headers=admin_headers, timeout=15)
    assert rc.status_code == 200

    # Verify tickets marked refunded
    from motor.motor_asyncio import AsyncIOMotorClient
    mongo_url = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
    dbname = os.environ.get("DB_NAME", "test_database")

    async def check():
        c = AsyncIOMotorClient(mongo_url)
        d = c[dbname]
        tickets = await d.tickets.find({"reservation_id": rid}, {"_id": 0}).to_list(10)
        ev_doc = await d.events.find_one({"event_id": ev["event_id"]}, {"_id": 0})
        c.close()
        return tickets, ev_doc

    tickets, ev_doc = asyncio.run(check())
    assert all(t["status"] == "refunded" for t in tickets), tickets
    assert ev_doc.get("cancelled") is True
    assert ev_doc.get("is_published") is False

    requests.delete(f"{API}/admin/events/{ev['event_id']}", headers=admin_headers, timeout=15)


def test_order_refund(admin_headers):
    """Create pending reservation, finalize, then admin refund -> reservation + tickets refunded."""
    user_headers = _fresh_user_headers()
    res = _create_reservation_for(user_headers, quantity=1)
    rid = res["reservation_id"]
    code = (
        "import asyncio, sys; sys.path.insert(0,'/app/backend'); "
        "from server import _finalize_paid_reservation; "
        f"asyncio.run(_finalize_paid_reservation('{rid}'))"
    )
    subprocess.run(["python3", "-c", code], capture_output=True, text=True, timeout=30)

    rr = requests.post(f"{API}/admin/orders/{rid}/refund", headers=admin_headers, timeout=15)
    assert rr.status_code == 200

    from motor.motor_asyncio import AsyncIOMotorClient
    mongo_url = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
    dbname = os.environ.get("DB_NAME", "test_database")

    async def check():
        c = AsyncIOMotorClient(mongo_url)
        d = c[dbname]
        r_doc = await d.reservations.find_one({"reservation_id": rid}, {"_id": 0})
        tks = await d.tickets.find({"reservation_id": rid}, {"_id": 0}).to_list(10)
        c.close()
        return r_doc, tks

    r_doc, tks = asyncio.run(check())
    assert r_doc["status"] == "refunded"
    assert all(t["status"] == "refunded" for t in tks)
