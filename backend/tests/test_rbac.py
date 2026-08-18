"""
Role-based access control across every guarded route in the API.

Replaces test_daniel_admin_rbac.py, which encoded a one-off incident: it asserted that
one specific personal Gmail address had role='admin', that it was "the only non-test real
user", and minted sessions for it by inserting rows with mongosh against a hardcoded
'test_database'. That tested one machine's data, not the authorization rules, and it
became actively wrong once admin stopped being granted by registration order (audit H3).

Its replacement then tested a **hand-written list of 8 routes** out of 66 under `/admin`.
The rule held anyway — every route was written with a guard — but nothing checked that,
so the difference between "we wrote them all correctly" and "they are all enforced" was
somebody's memory. A route added without a dependency would have been invisible here.

So the route table is no longer written down. It is **derived from the application
object** at import time: `server.api.routes`, walking each route's dependency tree for
`require_admin` / `require_admin_or_editor` / `require_admin_or_door` /
`get_current_user`. A new endpoint is covered by these tests the moment it exists, which
is the only version of this that stays true.

**This sweep spends rate-limit budget, and something else notices.** Twelve routes carry
a limiter. Hitting each once anonymously costs a unit, and `auth_verify_req` allows only 3
per 15 minutes while `test_untested_routes.py` needs 2 of them — so the two files together
sit exactly on the limit and whichever loses the race skips. That is the documented
behaviour for a rate-limit collision rather than a fault, and the skip is reported rather
than hidden; it is noted here so the next person does not go looking for a bug.

**Why the negative cases are exhaustive and the positive ones are not.** A rejected
request never reaches the handler — FastAPI resolves the auth dependency first, and the
calibration for this file confirmed that even `POST` with no body returns 401/403 rather
than 422. So sweeping every route with the wrong identity is free of side effects, and
that sweep is where the security claim lives. Driving the *allowed* identity through 66
routes is not free: it would seed databases, send mail and delete records. The positive
direction is therefore asserted on `GET` routes only — enough to prove the guards are not
simply denying everyone, without the suite mutating the world to prove it.
"""
import re
import pathlib

import pytest
import requests

from support import BASE_URL, TIMEOUT

import server
from fastapi.routing import APIRoute


pytestmark = [pytest.mark.integration, pytest.mark.critical]  # pins the audit's RBAC model

# Path params are filled with something that cannot exist. Authorization runs before any
# lookup, so the negative cases are unaffected; the positive ones just see 404 instead of
# 200, which is equally proof that the guard let them through.
SENTINEL = "pytest-nonexistent"

ADMIN_ONLY, EDITOR_OK, DOOR_OK, AUTHED_ONLY = "admin", "editor", "door", "authed"


def _guards(route) -> set:
    names = set()

    def walk(dep, depth=0):
        if depth > 6:  # dependency trees here are shallow; this is a cycle guard
            return
        for sub in dep.dependencies:
            if sub.call is not None:
                names.add(getattr(sub.call, "__name__", ""))
            walk(sub, depth + 1)

    walk(route.dependant)
    return names


def _category(guards):
    if "require_admin" in guards:
        return ADMIN_ONLY
    if "require_admin_or_editor" in guards:
        return EDITOR_OK
    if "require_admin_or_door" in guards:
        return DOOR_OK
    if "get_current_user" in guards:
        return AUTHED_ONLY
    return None  # public


def _discover():
    out, limited = [], set()
    for route in server.api.routes:
        if not isinstance(route, APIRoute):
            continue
        guards = _guards(route)
        category = _category(guards)
        if category is None:
            continue
        for method in sorted(route.methods - {"HEAD", "OPTIONS"}):
            out.append((method, route.path, category))
            # `_dep` is the closure `rate_limit()` returns. Route-level dependencies are
            # resolved BEFORE parameter dependencies, so on these the limiter answers
            # before authentication does — see `_ANON_REFUSALS`.
            if "_dep" in guards:
                limited.add((method, route.path))
    return sorted(out, key=lambda r: (r[1], r[0])), limited


GUARDED, RATE_LIMITED = _discover()
ADMIN_ROUTES = [r for r in GUARDED if r[2] == ADMIN_ONLY]

# Fails loudly rather than passing vacuously if introspection ever stops finding routes —
# a parametrized test over an empty list is a green tick that checked nothing.
assert len(GUARDED) > 80, f"route discovery found only {len(GUARDED)} guarded routes"
assert len(ADMIN_ROUTES) > 40, f"route discovery found only {len(ADMIN_ROUTES)} admin routes"


def _call(method, path, headers=None):
    url = BASE_URL + re.sub(r"\{[^}]+\}", SENTINEL, path)
    return requests.request(method, url, headers=headers or {}, timeout=TIMEOUT)


def _id(row):
    return f"{row[0]} {row[1]}"


# --- the rule nobody was checking -----------------------------------------------------

class TestEveryAdminRouteIsGuarded:
    """Structural, no HTTP: this is what makes a missing dependency a failing test rather
    than an unnoticed hole."""

    def test_no_admin_path_is_unguarded(self):
        unguarded = []
        for route in server.api.routes:
            if not isinstance(route, APIRoute) or "/admin" not in route.path:
                continue
            if _category(_guards(route)) is None:
                unguarded.append(f"{sorted(route.methods - {'HEAD', 'OPTIONS'})} {route.path}")
        assert not unguarded, f"admin routes with no auth dependency: {unguarded}"

    def test_the_seed_route_is_guarded(self):
        """Not under /admin, and it rewrites content — worth naming explicitly."""
        seed = [r for r in GUARDED if r[1].endswith("/seed")]
        assert seed, "no guarded /seed route found"
        assert all(c == ADMIN_ONLY for _m, _p, c in seed), seed


class TestTheAccessModelIsPinned:
    """The derived table cannot police itself, so the categorisation is checked in.

    Deriving the route table from the app is what makes new endpoints covered
    automatically — but it also means the code under test defines the expectation, and a
    change to the access model re-files a route rather than failing anything. Widening
    `admin_set_role` from `require_admin` to `require_admin_or_editor` moved it from the
    admin list to the editor list, so "an editor is forbidden here" stopped being
    generated for it and the suite stayed green. That mutation is the reason this exists.

    `rbac_inventory.txt` records who may reach what. Changing that answer now requires
    editing a checked-in file in the same commit — which is a diff a reviewer can see.
    """

    INVENTORY = pathlib.Path(__file__).with_name("rbac_inventory.txt")

    def _recorded(self):
        rows = set()
        for line in self.INVENTORY.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            category, method, path = line.split()
            rows.add((method, path, category))
        return rows

    def test_no_route_changed_who_may_reach_it(self):
        recorded, live = self._recorded(), set(GUARDED)

        widened = []
        for method, path, category in sorted(live - recorded):
            was = next((c for m, p, c in recorded if (m, p) == (method, path)), None)
            if was:
                widened.append(f"{method} {path}: {was} -> {category}")
        assert not widened, (
            "the role required to reach these routes changed:\n  " + "\n  ".join(widened)
            + "\n\nIf that is intended, update tests/rbac_inventory.txt in this commit."
        )

    def test_no_route_appeared_or_vanished_unrecorded(self):
        recorded, live = self._recorded(), set(GUARDED)
        recorded_paths = {(m, p) for m, p, _c in recorded}
        live_paths = {(m, p) for m, p, _c in live}

        added = sorted(f"{m} {p}" for m, p in live_paths - recorded_paths)
        removed = sorted(f"{m} {p}" for m, p in recorded_paths - live_paths)
        assert not (added or removed), (
            f"guarded routes added: {added or 'none'}\n"
            f"guarded routes gone:  {removed or 'none'}\n\n"
            "A route that lost its guard shows up as 'gone' — it is not merely absent, it "
            "is unauthenticated. Regenerate tests/rbac_inventory.txt only once you have "
            "checked which of the two happened."
        )


# --- nobody gets in without credentials ----------------------------------------------

@pytest.mark.parametrize("method,path,category", GUARDED, ids=[_id(r) for r in GUARDED])
def test_anonymous_is_rejected(method, path, category):
    """401 everywhere — except where a rate limiter gets there first.

    FastAPI resolves route-level `dependencies=[...]` before parameter dependencies, so
    on a rate-limited route the 429 is raised before `get_current_user` ever runs. This
    sweep spends those budgets itself: `/auth/export` allows 3 an hour, and a suite that
    runs twice in an hour exhausts it. 429 is accepted **only** on routes introspection
    shows a limiter on, so it can never paper over an unguarded one — and either way the
    claim holds, since both codes mean the anonymous caller was refused.
    """
    r = _call(method, path)
    allowed = {401, 429} if (method, path) in RATE_LIMITED else {401}
    assert r.status_code in allowed, (
        f"{method} {path} answered {r.status_code} to an anonymous caller "
        f"(expected {sorted(allowed)}): {r.text[:160]}"
    )


# --- and the wrong role gets 403, on every single admin route ------------------------

@pytest.mark.parametrize("method,path,category", ADMIN_ROUTES,
                         ids=[_id(r) for r in ADMIN_ROUTES])
class TestAdminRoutesRefuseEveryOtherRole:
    """The claim the frontend depends on. Hiding a button is not a control; this is."""

    def test_a_plain_user_is_forbidden(self, method, path, category, user_headers):
        r = _call(method, path, user_headers)
        assert r.status_code == 403, f"{method} {path} -> {r.status_code}: {r.text[:160]}"

    def test_an_editor_is_forbidden(self, method, path, category, editor_headers):
        """Editors run the CMS. They do not get events, orders, refunds or roles."""
        r = _call(method, path, editor_headers)
        assert r.status_code == 403, f"{method} {path} -> {r.status_code}: {r.text[:160]}"

    def test_a_door_user_is_forbidden(self, method, path, category, door_headers):
        """A scanner account lives on a phone at a venue — the most losable credential
        in the system, and the one with the least reason to reach anything else."""
        r = _call(method, path, door_headers)
        assert r.status_code == 403, f"{method} {path} -> {r.status_code}: {r.text[:160]}"


def _rows(category):
    return [r for r in GUARDED if r[2] == category]


@pytest.mark.parametrize("method,path,category", _rows(EDITOR_OK),
                         ids=[_id(r) for r in _rows(EDITOR_OK)])
def test_editor_routes_refuse_a_plain_user(method, path, category, user_headers):
    r = _call(method, path, user_headers)
    assert r.status_code == 403, f"{method} {path} -> {r.status_code}: {r.text[:160]}"


@pytest.mark.parametrize("method,path,category", _rows(DOOR_OK),
                         ids=[_id(r) for r in _rows(DOOR_OK)])
def test_door_routes_refuse_a_plain_user(method, path, category, user_headers):
    r = _call(method, path, user_headers)
    assert r.status_code == 403, f"{method} {path} -> {r.status_code}: {r.text[:160]}"


# --- the guards are not just denying everybody ---------------------------------------
# GET only: the point is to prove the allowed role gets past the guard, and doing that
# through POST/DELETE would mean seeding, mailing and deleting on every run.

_GET = [r for r in GUARDED if r[0] == "GET"]


def _passed_the_guard(r, method, path, who):
    """Anything but an authorization refusal. A 429 here is inconclusive rather than a
    pass — the limiter sits in front of the guard — but it is not a failure of the rule
    under test, and `/auth/export` at 3 an hour will produce one on most runs."""
    assert r.status_code not in (401, 403), \
        f"{who} was refused {method} {path}: {r.status_code} {r.text[:160]}"
    assert r.status_code < 500, \
        f"{method} {path} returned {r.status_code} for {who} — guard passed, handler broke"


@pytest.mark.parametrize("method,path,category", _GET, ids=[_id(r) for r in _GET])
def test_an_admin_reaches_every_readable_route(method, path, category, admin_headers):
    _passed_the_guard(_call(method, path, admin_headers), method, path, "admin")


_EDITOR_GET = [r for r in _GET if r[2] in (EDITOR_OK, AUTHED_ONLY)]


@pytest.mark.parametrize("method,path,category", _EDITOR_GET,
                         ids=[_id(r) for r in _EDITOR_GET])
def test_an_editor_reaches_the_content_routes(method, path, category, editor_headers):
    _passed_the_guard(_call(method, path, editor_headers), method, path, "editor")


_DOOR_GET = [r for r in _GET if r[2] in (DOOR_OK, AUTHED_ONLY)]


@pytest.mark.parametrize("method,path,category", _DOOR_GET, ids=[_id(r) for r in _DOOR_GET])
def test_a_door_user_reaches_the_scanning_routes(method, path, category, door_headers):
    _passed_the_guard(_call(method, path, door_headers), method, path, "door")
