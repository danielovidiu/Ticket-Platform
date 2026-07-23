"""
Role-based access control across the admin surface.

Replaces test_daniel_admin_rbac.py, which encoded a one-off incident: it asserted that
one specific personal Gmail address had role='admin', that it was "the only non-test real
user", and minted sessions for it by inserting rows with mongosh against a hardcoded
'test_database'. That tested one machine's data, not the authorization rules, and it
became actively wrong once admin stopped being granted by registration order (audit H3).

The rules it should have been testing:

  * no credentials            -> 401 on every admin route
  * an ordinary user          -> 403
  * an editor                 -> 200 on CMS/newsletter routes, 403 on admin-only ones
  * a door user               -> 200 on /scan, 403 on admin routes
  * an admin                  -> 200

Every identity here is created for the test and removed afterwards.
"""
import pytest
import requests

from support import API, TIMEOUT

# (path, method) pairs. Admin-only routes reject editors as well as users.
ADMIN_ONLY = [
    ("/admin/stats", "get"),
    ("/admin/events", "get"),
    ("/admin/users", "get"),
    ("/admin/orders", "get"),
    ("/admin/discounts", "get"),
    ("/admin/audit", "get"),
]

# Routes an editor may reach in addition to an admin.
EDITOR_ALLOWED = [
    ("/admin/cms/pages", "get"),
    ("/admin/newsletter", "get"),
]


def _call(path, method, headers=None):
    return getattr(requests, method)(f"{API}{path}", headers=headers or {}, timeout=TIMEOUT)


@pytest.mark.parametrize("path,method", ADMIN_ONLY + EDITOR_ALLOWED)
def test_anonymous_is_rejected(path, method):
    assert _call(path, method).status_code == 401


@pytest.mark.parametrize("path,method", ADMIN_ONLY + EDITOR_ALLOWED)
def test_plain_user_is_forbidden(path, method, user_headers):
    assert _call(path, method, user_headers).status_code == 403


@pytest.mark.parametrize("path,method", ADMIN_ONLY + EDITOR_ALLOWED)
def test_admin_is_allowed(path, method, admin_headers):
    r = _call(path, method, admin_headers)
    assert r.status_code == 200, f"{path}: {r.status_code} {r.text[:200]}"


@pytest.mark.parametrize("path,method", EDITOR_ALLOWED)
def test_editor_is_allowed_on_content_routes(path, method, editor_headers):
    r = _call(path, method, editor_headers)
    assert r.status_code == 200, f"{path}: {r.status_code} {r.text[:200]}"


@pytest.mark.parametrize("path,method", ADMIN_ONLY)
def test_editor_is_forbidden_on_admin_only_routes(path, method, editor_headers):
    assert _call(path, method, editor_headers).status_code == 403


def test_door_role_can_scan_but_not_administer(door_headers):
    # A door user reaches /scan (the ticket is bogus, so the answer is a clean
    # "not found" rather than an authorization failure).
    r = requests.post(f"{API}/scan", json={"qr_code": "SNTY-NO-SUCH-TICKET"},
                      headers=door_headers, timeout=TIMEOUT)
    assert r.status_code == 200, r.text
    assert r.json()["valid"] is False
    # ...but not admin routes.
    assert _call("/admin/stats", "get", door_headers).status_code == 403


def test_plain_user_cannot_scan(user_headers):
    r = requests.post(f"{API}/scan", json={"qr_code": "SNTY-NO-SUCH-TICKET"},
                      headers=user_headers, timeout=TIMEOUT)
    assert r.status_code == 403


def test_auth_me_reports_the_granted_role(admin_headers, user_headers):
    a = requests.get(f"{API}/auth/me", headers=admin_headers, timeout=TIMEOUT)
    u = requests.get(f"{API}/auth/me", headers=user_headers, timeout=TIMEOUT)
    assert a.status_code == 200 and a.json()["role"] == "admin"
    assert u.status_code == 200 and u.json()["role"] == "user"
    # The password hash must never cross the wire.
    assert "password_hash" not in a.json()
    assert "password_hash" not in u.json()


def test_admin_stats_shape(admin_headers):
    d = requests.get(f"{API}/admin/stats", headers=admin_headers, timeout=TIMEOUT).json()
    for key in ("revenue_ron", "total_orders", "total_tickets", "scanned", "events"):
        assert key in d, f"missing {key} in {d}"
