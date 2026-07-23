"""
Iteration 4 refactor regression tests.
Covers the 5 new helpers extracted from create_reservation:
  _enforce_user_ticket_cap, _find_wave, _resolve_pricing_source,
  _apply_discount, _atomic_hold_wave_stock

Scenarios explicitly requested by main agent:
  - Max-per-user cap -> 400 "Ticket limit reached"
  - Wave not active (outside starts_at/ends_at) -> 400
  - Sold-out already covered by backend_test.py (no decrement)
  - Discount: invalid code / wrong event scope / expired / exhausted -> 400
  - Special link over-capacity -> 400 "Special link capacity exceeded"
  - Special link bypasses wave decrement + wave window checks
  - Happy-path expires_at ~10min in future
"""
import uuid
from datetime import datetime, timezone, timedelta

import pytest
import requests

from support import API, bearer as _bearer, mint_user, temp_discount, patient

# `admin_headers` now comes from conftest.py (a real registered+promoted account) rather
# than a UMB_ADMIN_TOKEN environment variable the Emergent runner used to inject.


def _mint_user(role="user"):
    """Token-only shim: these tests only ever want headers for a throwaway identity."""
    headers, _uid, _email = mint_user(role)
    return headers["Authorization"].split(" ", 1)[1]


@pytest.fixture(scope="module")
def obsidian(seeded):
    # The unauthenticated POST /api/seed this used to make has always been a 401; it only
    # appeared to work because the database was already populated. The `seeded` fixture
    # (conftest) does it properly with admin credentials.
    r = requests.get(f"{API}/events/obsidian-chapter-i", timeout=15)
    assert r.status_code == 200
    return r.json()


# ---------- Happy path: expires_at ~10 minutes ----------

def test_reservation_happy_path_expires_in_10_min(obsidian):
    user_h = _bearer(_mint_user())
    ev = requests.get(f"{API}/events/obsidian-chapter-i", timeout=15).json()
    gen = next(w for w in ev["waves"] if w["tier"] == "general")
    r = patient.post(f"{API}/reservations",
                      json={"event_id": ev["event_id"], "wave_id": gen["wave_id"], "quantity": 1},
                      headers=user_h, timeout=15)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "pending"
    assert body["hold_minutes"] == 10
    expires = datetime.fromisoformat(body["expires_at"])
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    delta = (expires - datetime.now(timezone.utc)).total_seconds()
    assert 8 * 60 < delta <= 10 * 60 + 5, f"expires_at not ~10min: delta={delta}s"
    # total math
    assert body["unit_price_ron"] == float(gen["price_ron"])
    assert body["total_ron"] == round(float(gen["price_ron"]) * 1, 2)


# ---------- Max-per-user cap ----------

def test_max_per_user_cap_enforced(admin_headers):
    """Create an event with max_tickets_per_user=2 and try to reserve 3 -> 400."""
    now = datetime.now(timezone.utc)
    payload = {
        "title": "TEST_CAP",
        "slug": f"cap-{uuid.uuid4().hex[:6]}",
        "description": "d", "venue": "V",
        "starts_at": (now + timedelta(days=5)).isoformat(),
        "ends_at": (now + timedelta(days=5, hours=3)).isoformat(),
        "doors_open_at": (now + timedelta(days=5) - timedelta(hours=1)).isoformat(),
        "image_url": "", "artist_ids": [],
        "max_tickets_per_user": 2, "is_published": True,
        "waves": [{"name": "GA", "price_ron": 10.0, "capacity": 20,
                   "starts_at": now.isoformat(),
                   "ends_at": (now + timedelta(days=4)).isoformat(),
                   "tier": "general"}],
    }
    r = requests.post(f"{API}/admin/events", json=payload, headers=admin_headers, timeout=15)
    assert r.status_code == 200
    ev = r.json()
    wid = ev["waves"][0]["wave_id"]

    user_h = _bearer(_mint_user())
    # 1st reservation of 2 succeeds
    r1 = patient.post(f"{API}/reservations",
                       json={"event_id": ev["event_id"], "wave_id": wid, "quantity": 2},
                       headers=user_h, timeout=15)
    assert r1.status_code == 200, r1.text
    # 2nd reservation of 1 -> already at cap, must 400
    r2 = patient.post(f"{API}/reservations",
                       json={"event_id": ev["event_id"], "wave_id": wid, "quantity": 1},
                       headers=user_h, timeout=15)
    assert r2.status_code == 400, r2.text
    assert "Ticket limit reached" in r2.text

    # cleanup
    requests.delete(f"{API}/admin/events/{ev['event_id']}", headers=admin_headers, timeout=15)


def test_single_request_over_cap_rejected(admin_headers):
    """Single request qty=3 with cap=2 -> 400."""
    now = datetime.now(timezone.utc)
    payload = {
        "title": "TEST_CAP2",
        "slug": f"cap2-{uuid.uuid4().hex[:6]}",
        "description": "d", "venue": "V",
        "starts_at": (now + timedelta(days=5)).isoformat(),
        "ends_at": (now + timedelta(days=5, hours=3)).isoformat(),
        "doors_open_at": (now + timedelta(days=5) - timedelta(hours=1)).isoformat(),
        "image_url": "", "artist_ids": [],
        "max_tickets_per_user": 2, "is_published": True,
        "waves": [{"name": "GA", "price_ron": 10.0, "capacity": 20,
                   "starts_at": now.isoformat(),
                   "ends_at": (now + timedelta(days=4)).isoformat(),
                   "tier": "general"}],
    }
    r = requests.post(f"{API}/admin/events", json=payload, headers=admin_headers, timeout=15)
    ev = r.json()
    wid = ev["waves"][0]["wave_id"]
    user_h = _bearer(_mint_user())
    r2 = patient.post(f"{API}/reservations",
                       json={"event_id": ev["event_id"], "wave_id": wid, "quantity": 3},
                       headers=user_h, timeout=15)
    assert r2.status_code == 400, r2.text
    assert "Ticket limit reached" in r2.text
    requests.delete(f"{API}/admin/events/{ev['event_id']}", headers=admin_headers, timeout=15)


# ---------- Wave not active (window) ----------

def test_wave_not_active_before_window(admin_headers):
    """Wave starts_at in the future -> 400 'Wave not active'."""
    now = datetime.now(timezone.utc)
    payload = {
        "title": "TEST_WAVE_FUTURE",
        "slug": f"wf-{uuid.uuid4().hex[:6]}",
        "description": "d", "venue": "V",
        "starts_at": (now + timedelta(days=10)).isoformat(),
        "ends_at": (now + timedelta(days=10, hours=3)).isoformat(),
        "doors_open_at": (now + timedelta(days=10) - timedelta(hours=1)).isoformat(),
        "image_url": "", "artist_ids": [],
        "max_tickets_per_user": 4, "is_published": True,
        "waves": [{"name": "GA", "price_ron": 10.0, "capacity": 20,
                   "starts_at": (now + timedelta(days=5)).isoformat(),  # future
                   "ends_at": (now + timedelta(days=8)).isoformat(),
                   "tier": "general"}],
    }
    r = requests.post(f"{API}/admin/events", json=payload, headers=admin_headers, timeout=15)
    ev = r.json()
    wid = ev["waves"][0]["wave_id"]

    user_h = _bearer(_mint_user())
    r2 = patient.post(f"{API}/reservations",
                       json={"event_id": ev["event_id"], "wave_id": wid, "quantity": 1},
                       headers=user_h, timeout=15)
    assert r2.status_code == 400, r2.text
    assert "Wave not active" in r2.text
    requests.delete(f"{API}/admin/events/{ev['event_id']}", headers=admin_headers, timeout=15)


def test_wave_not_active_after_window(admin_headers):
    """Wave ends_at in the past -> 400 'Wave not active'."""
    now = datetime.now(timezone.utc)
    payload = {
        "title": "TEST_WAVE_PAST",
        "slug": f"wp-{uuid.uuid4().hex[:6]}",
        "description": "d", "venue": "V",
        "starts_at": (now + timedelta(days=10)).isoformat(),
        "ends_at": (now + timedelta(days=10, hours=3)).isoformat(),
        "doors_open_at": (now + timedelta(days=10) - timedelta(hours=1)).isoformat(),
        "image_url": "", "artist_ids": [],
        "max_tickets_per_user": 4, "is_published": True,
        "waves": [{"name": "GA", "price_ron": 10.0, "capacity": 20,
                   "starts_at": (now - timedelta(days=5)).isoformat(),
                   "ends_at": (now - timedelta(days=1)).isoformat(),  # past
                   "tier": "general"}],
    }
    r = requests.post(f"{API}/admin/events", json=payload, headers=admin_headers, timeout=15)
    ev = r.json()
    wid = ev["waves"][0]["wave_id"]

    user_h = _bearer(_mint_user())
    r2 = patient.post(f"{API}/reservations",
                       json={"event_id": ev["event_id"], "wave_id": wid, "quantity": 1},
                       headers=user_h, timeout=15)
    assert r2.status_code == 400, r2.text
    assert "Wave not active" in r2.text
    requests.delete(f"{API}/admin/events/{ev['event_id']}", headers=admin_headers, timeout=15)


# ---------- Discount error paths ----------

def test_discount_invalid_code(obsidian):
    user_h = _bearer(_mint_user())
    ev = requests.get(f"{API}/events/obsidian-chapter-i", timeout=15).json()
    gen = next(w for w in ev["waves"] if w["tier"] == "general")
    r = patient.post(f"{API}/reservations",
                      json={"event_id": ev["event_id"], "wave_id": gen["wave_id"], "quantity": 1,
                            "discount_code": "NOPE_" + uuid.uuid4().hex[:6]},
                      headers=user_h, timeout=15)
    assert r.status_code == 400
    assert "Invalid discount code" in r.text


def test_discount_wrong_event_scope(admin_headers, obsidian):
    """Create a code scoped to a DIFFERENT event, then try it on obsidian -> 400."""
    now = datetime.now(timezone.utc)
    payload = {
        "title": "TEST_DISC_EV",
        "slug": f"disc-ev-{uuid.uuid4().hex[:6]}",
        "description": "d", "venue": "V",
        "starts_at": (now + timedelta(days=5)).isoformat(),
        "ends_at": (now + timedelta(days=5, hours=3)).isoformat(),
        "doors_open_at": (now + timedelta(days=5) - timedelta(hours=1)).isoformat(),
        "image_url": "", "artist_ids": [],
        "max_tickets_per_user": 4, "is_published": True,
        "waves": [{"name": "GA", "price_ron": 10.0, "capacity": 5,
                   "starts_at": now.isoformat(),
                   "ends_at": (now + timedelta(days=4)).isoformat(),
                   "tier": "general"}],
    }
    other_ev = requests.post(f"{API}/admin/events", json=payload, headers=admin_headers, timeout=15).json()

    code = f"TEST{uuid.uuid4().hex[:5].upper()}"
    body = {"code": code, "percent_off": 20, "max_uses": 10, "event_id": other_ev["event_id"]}
    d = requests.post(f"{API}/admin/discounts", json=body, headers=admin_headers, timeout=15).json()

    user_h = _bearer(_mint_user())
    ev = requests.get(f"{API}/events/obsidian-chapter-i", timeout=15).json()
    gen = next(w for w in ev["waves"] if w["tier"] == "general")
    r = patient.post(f"{API}/reservations",
                      json={"event_id": ev["event_id"], "wave_id": gen["wave_id"], "quantity": 1, "discount_code": code},
                      headers=user_h, timeout=15)
    assert r.status_code == 400, r.text
    assert "not valid for this event" in r.text.lower() or "Discount not valid" in r.text

    # cleanup
    requests.delete(f"{API}/admin/discounts/{d['discount_id']}", headers=admin_headers, timeout=15)
    requests.delete(f"{API}/admin/events/{other_ev['event_id']}", headers=admin_headers, timeout=15)


def test_discount_expired(admin_headers, obsidian):
    """Insert a discount with expires_at in the past directly in Mongo -> 400."""
    code = f"TESTEXP{uuid.uuid4().hex[:4].upper()}"
    past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    with temp_discount(code=code, percent_off=15, expires_at=past,
                       created_at=datetime.now(timezone.utc).isoformat()):
        user_h = _bearer(_mint_user())
        ev = requests.get(f"{API}/events/obsidian-chapter-i", timeout=15).json()
        gen = next(w for w in ev["waves"] if w["tier"] == "general")
        r = patient.post(f"{API}/reservations",
                          json={"event_id": ev["event_id"], "wave_id": gen["wave_id"], "quantity": 1,
                                "discount_code": code},
                          headers=user_h, timeout=15)
        assert r.status_code == 400, r.text
        assert "expired" in r.text.lower()


def test_discount_exhausted(admin_headers, obsidian):
    """Discount with uses>=max_uses -> 400."""
    code = f"TESTEXH{uuid.uuid4().hex[:4].upper()}"
    with temp_discount(code=code, percent_off=15, max_uses=2, uses=2,
                       created_at=datetime.now(timezone.utc).isoformat()):
        user_h = _bearer(_mint_user())
        ev = requests.get(f"{API}/events/obsidian-chapter-i", timeout=15).json()
        gen = next(w for w in ev["waves"] if w["tier"] == "general")
        r = patient.post(f"{API}/reservations",
                          json={"event_id": ev["event_id"], "wave_id": gen["wave_id"], "quantity": 1,
                                "discount_code": code},
                          headers=user_h, timeout=15)
        assert r.status_code == 400, r.text
        assert "exhausted" in r.text.lower()


# ---------- Special link over-capacity ----------

def test_special_link_over_capacity(admin_headers, obsidian):
    ev = requests.get(f"{API}/events/obsidian-chapter-i", timeout=15).json()
    gen = next(w for w in ev["waves"] if w["tier"] == "general")

    body = {"event_id": ev["event_id"], "label": "TEST_over_cap", "price_ron": 1.0, "capacity": 2}
    r = requests.post(f"{API}/admin/special-links", json=body, headers=admin_headers, timeout=15)
    assert r.status_code == 200
    sl = r.json()
    token = sl["token"]

    user_h = _bearer(_mint_user())
    # Ask for 3 tickets — special link capacity is 2 -> must 400
    payload = {"event_id": ev["event_id"], "wave_id": gen["wave_id"], "quantity": 3, "special_link_token": token}
    rr = patient.post(f"{API}/reservations", json=payload, headers=user_h, timeout=15)
    assert rr.status_code == 400, rr.text
    assert "Special link capacity exceeded" in rr.text

    requests.delete(f"{API}/admin/special-links/{sl['link_id']}", headers=admin_headers, timeout=15)


# ---------- Special link bypasses wave window ----------

def test_special_link_bypasses_wave_window(admin_headers):
    """Wave with ends_at in the past. Special link on that event should still allow reservation."""
    now = datetime.now(timezone.utc)
    payload = {
        "title": "TEST_SL_BYPASS",
        "slug": f"slb-{uuid.uuid4().hex[:6]}",
        "description": "d", "venue": "V",
        "starts_at": (now + timedelta(days=10)).isoformat(),
        "ends_at": (now + timedelta(days=10, hours=3)).isoformat(),
        "doors_open_at": (now + timedelta(days=10) - timedelta(hours=1)).isoformat(),
        "image_url": "", "artist_ids": [],
        "max_tickets_per_user": 4, "is_published": True,
        "waves": [{"name": "GA", "price_ron": 100.0, "capacity": 10,
                   "starts_at": (now - timedelta(days=10)).isoformat(),
                   "ends_at": (now - timedelta(days=1)).isoformat(),  # past
                   "tier": "general"}],
    }
    r = requests.post(f"{API}/admin/events", json=payload, headers=admin_headers, timeout=15)
    ev = r.json()
    wid = ev["waves"][0]["wave_id"]
    avail_before = ev["waves"][0]["available"]

    sl = requests.post(f"{API}/admin/special-links",
                       json={"event_id": ev["event_id"], "label": "TEST_bypass", "price_ron": 5.0, "capacity": 3},
                       headers=admin_headers, timeout=15).json()

    user_h = _bearer(_mint_user())
    rr = patient.post(f"{API}/reservations",
                       json={"event_id": ev["event_id"], "wave_id": wid, "quantity": 1,
                             "special_link_token": sl["token"]},
                       headers=user_h, timeout=15)
    assert rr.status_code == 200, rr.text
    res = rr.json()
    assert res["unit_price_ron"] == 5.0

    # wave.available unchanged
    ev2 = requests.get(f"{API}/events/{ev['slug']}", timeout=15).json()
    assert ev2["waves"][0]["available"] == avail_before

    # special.used stays 0 until finalize
    sl_get = requests.get(f"{API}/special-links/{sl['token']}", timeout=15).json()
    assert sl_get["link"]["used"] == 0, sl_get

    # cleanup
    requests.delete(f"{API}/admin/special-links/{sl['link_id']}", headers=admin_headers, timeout=15)
    requests.delete(f"{API}/admin/events/{ev['event_id']}", headers=admin_headers, timeout=15)
