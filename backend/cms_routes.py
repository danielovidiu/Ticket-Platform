"""
CMS routes: dynamic pages, theme, and navigation.
Public read endpoints + admin/editor write endpoints.
Keeps content and theme as structured JSON in Mongo — the frontend
renders everything dynamically from that data.
"""
from datetime import datetime, timezone
from typing import List, Optional
import re
import uuid

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

import storage


# The built-in sections. These are React routes, not CMS pages — there are no blocks to
# edit — but they sit in the same navigation bar as the pages, so they are stored in
# `cms_pages` as `kind: "core"` rows purely to take part in `nav_order`. That is what
# makes the whole bar reorderable from one list instead of the core links being frozen
# after whatever the CMS happens to emit.
#
# The default orders continue the seeded pages (home 0, mission 1, contact 2), so an
# existing site upgrades to exactly the arrangement it already displayed.
CORE_NAV_ITEMS = [
    # (slug, label, route, default nav_order)
    ("core-events", "Events", "/events", 3),
    ("core-shop", "Shop", "/shop", 4),
    ("core-artists", "Artists", "/artists", 5),
    ("core-archive", "Archive", "/archive", 6),
    ("core-gallery", "Gallery", "/gallery", 7),
]


# ---------- Custom webfonts ----------
#
# A white-label site usually has to carry its own type: an artist's brand face is a
# licensed file, not something on Google Fonts. Uploaded files go through the same media
# backend as images (local disk on a laptop, Vercel Blob in production) and are served to
# the browser by @font-face rules the frontend assembles from GET /cms/fonts.

# The format is decided by the file's own signature, never by the client-declared
# Content-Type. Browsers send wildly inconsistent types for fonts
# (application/octet-stream, font/sfnt, application/x-font-ttf), so the declared value is
# useless even before you consider that it is attacker-controlled — which is exactly the
# weakness audit item M8 records about the image upload path. This route does not repeat
# it: bytes that are not a font are rejected here rather than relying on `nosniff`
# downstream.
FONT_MAGIC = [
    (b"wOF2", "woff2", ".woff2", "font/woff2"),
    (b"wOFF", "woff", ".woff", "font/woff"),
    (b"OTTO", "otf", ".otf", "font/otf"),
    (b"\x00\x01\x00\x00", "ttf", ".ttf", "font/ttf"),
    (b"true", "ttf", ".ttf", "font/ttf"),
    (b"ttcf", "ttf", ".ttf", "font/ttf"),
]

# Well under the 25MB media cap: a subset woff2 is typically 20-80KB, and anything past a
# couple of megabytes is a desktop-format file uploaded by mistake.
MAX_FONT_BYTES = 5 * 1024 * 1024

# The family name is interpolated into a generated `font-family:` declaration, so it is
# restricted to characters that cannot close a CSS string or escape the rule. The
# frontend escapes as well; this is the control, that is the backstop.
FAMILY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$")

FONT_STYLES = ("normal", "italic")


def sniff_font_format(data: bytes):
    """(format, extension, content_type) read off the file signature, or None."""
    for magic, fmt, ext, ctype in FONT_MAGIC:
        if data.startswith(magic):
            return fmt, ext, ctype
    return None


# Top-level paths the React router already owns.
#
# A CMS page whose slug collides with one of these would be created happily and then
# never render: React Router ranks a static segment above the ":slug" catch-all, so the
# built-in route wins every time and the page disappears with no error anywhere. Create
# time is the only moment anyone can be told, which is why this is a hard rejection
# rather than a warning.
#
# Derived from the <Route> table in frontend/src/App.js. The two have to move together —
# test_page_slugs.py reads that file and fails if a route is added without landing here.
RESERVED_SLUGS = frozenset({
    # Built-in sections
    "events", "shop", "artists", "archive", "gallery", "cart", "checkout",
    "my-tickets", "my-orders", "settings", "newsletter",
    # Account and auth
    "login", "complete-profile", "verify", "reset-password",
    # Staff tools
    "admin", "cms", "scan",
    # Not routes, but they still occupy the namespace: /api/* is rewritten to the backend
    # before the SPA ever sees it, /p/* is the permanent redirect from the old page URLs,
    # and /static/* is the built asset directory.
    "api", "p", "static",
})

# A slug is one URL segment now that pages live at /<slug>. One containing a slash, a
# space or a capital could be stored and would then be unroutable — the same silent
# disappearance the reserved list exists to prevent, by a different route.
SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def page_route(slug: str) -> str:
    """Where a CMS page lives in the router.

    Pages sit at the root: /mission, not /p/mission. Three slugs used to be special-cased
    here because they had hardcoded <Route> entries of their own — which existed only
    because the generic page route was namespaced under /p/. With that namespace gone
    they resolve through the same path as every other page and the exception went too.

    The homepage is not handled here; get_public_nav resolves it to "/" from the is_home
    flag, so which page answers the root never depends on what its slug spells.
    """
    return f"/{slug}"


async def home_page_doc(db, projection=None):
    """The page that answers "/".

    "/" used to be hardcoded to the slug `home`, which made the front page depend on a
    string nobody could edit — slug is immutable through the API on purpose. A site whose
    homepage was authored under any other slug served a 404 at its root with no way to
    repair it from the CMS. So the homepage is now something a page *is*, not something
    its slug happens to spell.

    The `home` slug stays as a fallback so installs that predate the flag keep working
    without being migrated first.
    """
    doc = await db.cms_pages.find_one({"is_home": True, "kind": {"$ne": "core"}}, projection)
    if doc is None:
        doc = await db.cms_pages.find_one({"slug": "home", "kind": {"$ne": "core"}}, projection)
    return doc


async def ensure_home_page(db):
    """Guarantee something answers "/". Returns the slug adopted, or None.

    Only ever fills a vacuum: if a page is already flagged, or a `home` slug exists to
    fall back on, this does nothing. Otherwise it adopts the first published page in the
    nav, because a site with pages but no root is broken in the most visible way possible
    and the first nav entry is what a reader would have been shown anyway.
    """
    if await home_page_doc(db, {"_id": 0, "slug": 1}) is not None:
        return None
    first = await db.cms_pages.find_one(
        {"kind": {"$ne": "core"}, "in_nav": True, "published": {"$ne": None}},
        {"_id": 0, "page_id": 1, "slug": 1},
        sort=[("nav_order", 1)],
    )
    if first is None:
        return None
    await db.cms_pages.update_one({"page_id": first["page_id"]}, {"$set": {"is_home": True}})
    return first["slug"]


async def ensure_core_nav_items(db):
    """Create the core nav rows once. Never touches one that already exists.

    Order, label and visibility are editable afterwards, so re-running this must not
    reset an arrangement somebody chose — `$setOnInsert` with no `$set` is what
    guarantees that, and it makes the call safe on every boot and race-safe between two
    cold starts.
    """
    created = 0
    for slug, label, route, order in CORE_NAV_ITEMS:
        result = await db.cms_pages.update_one(
            {"slug": slug},
            {"$setOnInsert": {
                "page_id": f"nav_{uuid.uuid4().hex[:16]}",
                "slug": slug,
                "kind": "core",
                "route": route,
                "title": label,
                "nav_label": label,
                "nav_order": order,
                "in_nav": True,
                # No blocks, no draft, no versions: there is nothing to author here. The
                # editor keys off `kind` and refuses to open one.
                "draft": None,
                "published": None,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }},
            upsert=True,
        )
        if result.upserted_id is not None:
            created += 1
    return created


def register_cms_routes(api: APIRouter, db, require_admin, require_admin_or_editor):
    """Attach all CMS endpoints to the provided api router."""

    def now_iso():
        return datetime.now(timezone.utc).isoformat()

    def new_id(prefix):
        return f"{prefix}_{uuid.uuid4().hex[:16]}"

    class PageIn(BaseModel):
        slug: str
        title: str
        nav_label: Optional[str] = None
        nav_order: int = 100
        in_nav: bool = True

    class PagePatch(BaseModel):
        title: Optional[str] = None
        nav_label: Optional[str] = None
        nav_order: Optional[int] = None
        in_nav: Optional[bool] = None
        draft: Optional[dict] = None  # {blocks: [...]}

    class ReorderIn(BaseModel):
        order: List[str]  # page_ids in desired nav order

    class ThemePatch(BaseModel):
        draft: dict  # partial theme values

    # ---------- Public ----------

    @api.get("/cms/pages/{slug}")
    async def get_public_page(slug: str):
        p = await db.cms_pages.find_one({"slug": slug}, {"_id": 0})
        if not p or not p.get("published"):
            raise HTTPException(404, "Page not found")
        return {
            "page_id": p["page_id"],
            "slug": p["slug"],
            "title": p["title"],
            "blocks": p["published"].get("blocks", []),
        }

    @api.get("/cms/home")
    async def get_public_home():
        """The page behind "/". Same shape as /cms/pages/{slug}, so the renderer is
        identical — the root just asks a different question to find its page."""
        p = await home_page_doc(db, {"_id": 0})
        if not p or not p.get("published"):
            # 404 rather than an empty 200: the frontend distinguishes "no homepage has
            # been chosen" from "the homepage failed to load", and tells an editor which.
            raise HTTPException(404, "No homepage is set")
        return {
            "page_id": p["page_id"],
            "slug": p["slug"],
            "title": p["title"],
            "blocks": p["published"].get("blocks", []),
        }

    @api.get("/cms/theme")
    async def get_public_theme():
        t = await db.cms_theme.find_one({"doc_id": "theme_current"}, {"_id": 0})
        if not t:
            return {"published": _default_theme()}
        return {"published": t.get("published", _default_theme())}

    def _font_public(f):
        return {"font_id": f["font_id"], "family": f["family"], "weight": f["weight"],
                "style": f["style"], "url": f["url"], "format": f["format"]}

    async def _fonts_sorted():
        cursor = db.custom_fonts.find({}, {"_id": 0}).sort(
            [("family", 1), ("weight", 1), ("style", 1)]
        )
        return await cursor.to_list(200)

    @api.get("/cms/fonts")
    async def get_public_fonts():
        """Every uploaded face, for the @font-face rules the frontend injects at boot.

        Public because what it feeds is public — these URLs are already served to anyone
        who loads the site. Sorted so the generated CSS is byte-stable across requests
        instead of following whatever order Mongo happens to return.
        """
        return [_font_public(f) for f in await _fonts_sorted()]

    @api.get("/cms/nav")
    async def get_public_nav():
        """The whole navigation bar, in order, with hrefs resolved.

        Core rows qualify on `kind` rather than on `published`: they have no blocks to
        publish, so the published check that (correctly) hides an unfinished page would
        otherwise hide every built-in section permanently.
        """
        cursor = db.cms_pages.find(
            {"in_nav": True, "$or": [{"kind": "core"}, {"published": {"$ne": None}}]},
            {"_id": 0, "slug": 1, "nav_label": 1, "title": 1, "nav_order": 1,
             "kind": 1, "route": 1, "is_home": 1},
        ).sort("nav_order", 1)
        items = await cursor.to_list(200)

        def route_for(p):
            if p.get("kind") == "core":
                return p["route"]
            # The homepage links to the root, whatever its slug spells.
            return "/" if p.get("is_home") else page_route(p["slug"])

        return [
            {
                "slug": p["slug"],
                "label": p.get("nav_label") or p["title"],
                "route": route_for(p),
                "kind": p.get("kind") or "page",
            }
            for p in items
        ]

    # ---------- Admin/Editor ----------

    @api.get("/admin/cms/pages")
    async def admin_list_pages(user=Depends(require_admin_or_editor)):
        pages = await db.cms_pages.find({}, {"_id": 0, "versions": 0}).sort("nav_order", 1).to_list(500)
        return pages

    @api.get("/admin/cms/pages/{page_id}")
    async def admin_get_page(page_id: str, user=Depends(require_admin_or_editor)):
        p = await db.cms_pages.find_one({"page_id": page_id}, {"_id": 0})
        if not p:
            raise HTTPException(404, "Page not found")
        return p

    @api.post("/admin/cms/pages")
    async def admin_create_page(body: PageIn, user=Depends(require_admin_or_editor)):
        slug = (body.slug or "").strip().lower()
        if not SLUG_RE.match(slug):
            raise HTTPException(
                400, "Slug: lowercase letters, numbers and single hyphens only (e.g. about-us)"
            )
        if slug in RESERVED_SLUGS:
            raise HTTPException(
                400, f"'{slug}' is reserved by a built-in page — a page there would never open"
            )
        if await db.cms_pages.find_one({"slug": slug}):
            raise HTTPException(400, "Slug already exists")
        body.slug = slug
        doc = {
            "page_id": new_id("pg"),
            "slug": body.slug,
            "title": body.title,
            "nav_label": body.nav_label or body.title,
            "nav_order": body.nav_order,
            "in_nav": body.in_nav,
            "draft": {"blocks": []},
            "published": None,
            "versions": [],
            "created_at": now_iso(),
            "updated_at": now_iso(),
        }
        await db.cms_pages.insert_one(doc)
        doc.pop("_id", None)
        return doc

    @api.patch("/admin/cms/pages/{page_id}")
    async def admin_update_page(page_id: str, body: PagePatch, user=Depends(require_admin_or_editor)):
        upd = {k: v for k, v in body.model_dump().items() if v is not None}
        upd["updated_at"] = now_iso()
        r = await db.cms_pages.update_one({"page_id": page_id}, {"$set": upd})
        if r.matched_count == 0:
            raise HTTPException(404, "Page not found")
        p = await db.cms_pages.find_one({"page_id": page_id}, {"_id": 0})
        return p

    @api.post("/admin/cms/pages/{page_id}/publish")
    async def admin_publish_page(page_id: str, user=Depends(require_admin_or_editor)):
        p = await db.cms_pages.find_one({"page_id": page_id}, {"_id": 0})
        if not p:
            raise HTTPException(404, "Page not found")
        draft = p.get("draft") or {"blocks": []}
        versions = p.get("versions", [])
        # Snapshot the currently-published state before overwriting.
        if p.get("published"):
            versions = ([{
                "version_id": new_id("v"),
                "blocks": p["published"].get("blocks", []),
                "published_at": p.get("published_at", now_iso()),
                "published_by": p.get("published_by"),
            }] + versions)[:20]
        await db.cms_pages.update_one(
            {"page_id": page_id},
            {"$set": {
                "published": {"blocks": draft.get("blocks", [])},
                "published_at": now_iso(),
                "published_by": user["user_id"],
                "versions": versions,
                "updated_at": now_iso(),
            }},
        )
        return await db.cms_pages.find_one({"page_id": page_id}, {"_id": 0})

    @api.post("/admin/cms/pages/{page_id}/revert/{version_id}")
    async def admin_revert_page(page_id: str, version_id: str, user=Depends(require_admin_or_editor)):
        p = await db.cms_pages.find_one({"page_id": page_id}, {"_id": 0})
        if not p:
            raise HTTPException(404, "Page not found")
        version = next((v for v in p.get("versions", []) if v["version_id"] == version_id), None)
        if not version:
            raise HTTPException(404, "Version not found")
        # Load the version into the draft — editor can then publish or edit further.
        await db.cms_pages.update_one(
            {"page_id": page_id},
            {"$set": {"draft": {"blocks": version["blocks"]}, "updated_at": now_iso()}},
        )
        return await db.cms_pages.find_one({"page_id": page_id}, {"_id": 0})

    @api.delete("/admin/cms/pages/{page_id}")
    async def admin_delete_page(page_id: str, user=Depends(require_admin_or_editor)):
        existing = await db.cms_pages.find_one({"page_id": page_id}, {"_id": 0, "kind": 1})
        # `is None`, not falsiness: a page created before `kind` existed projects down to
        # an empty dict, which is falsy, and `if not existing` reported every one of them
        # as 404 instead of deleting it.
        if existing is None:
            raise HTTPException(404, "Page not found")
        # Deleting one would drop a section of the site out of the nav with no way to get
        # it back from the UI, and the route it points at would still be live and
        # reachable. Hide it with `in_nav` instead — that is reversible.
        if existing.get("kind") == "core":
            raise HTTPException(400, "Built-in nav links cannot be deleted — hide them instead")
        await db.cms_pages.delete_one({"page_id": page_id})
        return {"ok": True}

    @api.post("/admin/cms/pages/{page_id}/home")
    async def admin_set_home(page_id: str, user=Depends(require_admin_or_editor)):
        """Make this page answer "/". Exactly one page holds the flag.

        Clearing then setting is two writes, so two editors racing could momentarily
        leave none or two flagged. home_page_doc() resolves either state to a single
        page rather than erroring, and the next save settles it — worth more than a
        transaction for a button one person presses.
        """
        p = await db.cms_pages.find_one({"page_id": page_id}, {"_id": 0, "kind": 1, "slug": 1, "published": 1})
        if p is None:
            raise HTTPException(404, "Page not found")
        if p.get("kind") == "core":
            raise HTTPException(400, "Built-in links are routes, not pages — they have no content to show at /")
        if not p.get("published"):
            # "/" reads the published copy, so a draft-only page would blank the root.
            raise HTTPException(400, "Publish this page before making it the homepage")
        await db.cms_pages.update_many({"is_home": True}, {"$set": {"is_home": False}})
        await db.cms_pages.update_one(
            {"page_id": page_id}, {"$set": {"is_home": True, "updated_at": now_iso()}},
        )
        return {"ok": True, "slug": p["slug"]}

    @api.post("/admin/cms/pages/reorder")
    async def admin_reorder(body: ReorderIn, user=Depends(require_admin_or_editor)):
        for i, pid in enumerate(body.order):
            await db.cms_pages.update_one({"page_id": pid}, {"$set": {"nav_order": i, "updated_at": now_iso()}})
        return {"ok": True}

    # ---------- Theme ----------

    @api.get("/admin/cms/theme")
    async def admin_get_theme(user=Depends(require_admin_or_editor)):
        t = await db.cms_theme.find_one({"doc_id": "theme_current"}, {"_id": 0})
        if not t:
            t = {
                "doc_id": "theme_current",
                "draft": _default_theme(),
                "published": _default_theme(),
                "versions": [],
            }
            await db.cms_theme.insert_one(t)
            t.pop("_id", None)
        return t

    @api.patch("/admin/cms/theme")
    async def admin_patch_theme(body: ThemePatch, user=Depends(require_admin_or_editor)):
        await db.cms_theme.update_one(
            {"doc_id": "theme_current"},
            {"$set": {"draft": body.draft, "updated_at": now_iso()}},
            upsert=True,
        )
        return await db.cms_theme.find_one({"doc_id": "theme_current"}, {"_id": 0})

    @api.post("/admin/cms/theme/publish")
    async def admin_publish_theme(user=Depends(require_admin_or_editor)):
        t = await db.cms_theme.find_one({"doc_id": "theme_current"}, {"_id": 0})
        if not t:
            raise HTTPException(404, "Theme not found")
        versions = t.get("versions", [])
        if t.get("published"):
            versions = ([{
                "version_id": new_id("v"),
                "theme": t["published"],
                "published_at": t.get("published_at", now_iso()),
            }] + versions)[:20]
        await db.cms_theme.update_one(
            {"doc_id": "theme_current"},
            {"$set": {"published": t.get("draft", _default_theme()), "versions": versions,
                      "published_at": now_iso(), "updated_at": now_iso()}},
        )
        return await db.cms_theme.find_one({"doc_id": "theme_current"}, {"_id": 0})

    @api.post("/admin/cms/theme/revert/{version_id}")
    async def admin_revert_theme(version_id: str, user=Depends(require_admin_or_editor)):
        t = await db.cms_theme.find_one({"doc_id": "theme_current"}, {"_id": 0})
        if not t:
            raise HTTPException(404, "Theme not found")
        v = next((x for x in t.get("versions", []) if x["version_id"] == version_id), None)
        if not v:
            raise HTTPException(404, "Version not found")
        await db.cms_theme.update_one(
            {"doc_id": "theme_current"},
            {"$set": {"draft": v["theme"], "updated_at": now_iso()}},
        )
        return await db.cms_theme.find_one({"doc_id": "theme_current"}, {"_id": 0})

    # ---------- Custom fonts (admin) ----------

    @api.get("/admin/cms/fonts")
    async def admin_list_fonts(user=Depends(require_admin_or_editor)):
        """The uploaded faces, each flagged with whether the theme currently names it.

        `in_use` covers the draft as well as the published theme: deleting a face the
        draft points at breaks the next publish, not the live site, which is the harder
        failure to connect back to its cause.
        """
        fonts = await _fonts_sorted()
        t = await db.cms_theme.find_one(
            {"doc_id": "theme_current"}, {"_id": 0, "draft": 1, "published": 1}
        ) or {}
        in_use = {
            (v or "").strip()
            for key in ("draft", "published")
            for v in ((t.get(key) or {}).get("fonts") or {}).values()
        }
        return [{**f, "in_use": f["family"] in in_use} for f in fonts]

    @api.post("/admin/cms/fonts")
    async def admin_upload_font(
        file: UploadFile = File(...),
        family: str = Form(...),
        weight: int = Form(400),
        style: str = Form("normal"),
        user=Depends(require_admin_or_editor),
    ):
        """Store one font file as one (family, weight, style) face.

        Re-uploading the same face replaces it, bytes included. Refusing instead would
        make correcting a wrong file a two-step chore and buys no safety: the face is
        identified by what it is for, not by which upload produced it.
        """
        family = (family or "").strip()
        if not FAMILY_RE.match(family):
            raise HTTPException(
                400, "Family name: letters, numbers, spaces, hyphens and underscores only (max 64)"
            )
        if style not in FONT_STYLES:
            raise HTTPException(400, "Style must be 'normal' or 'italic'")
        if not 1 <= weight <= 1000:
            raise HTTPException(400, "Weight must be between 1 and 1000")

        data = await file.read()
        if not data:
            raise HTTPException(400, "That file is empty")
        if len(data) > MAX_FONT_BYTES:
            raise HTTPException(400, "Font too large (max 5MB) — upload a WOFF2 rather than a desktop OTF/TTF")

        sniffed = sniff_font_format(data)
        if not sniffed:
            raise HTTPException(400, "That is not a font file — WOFF2, WOFF, TTF or OTF only")
        fmt, ext, content_type = sniffed

        url = await storage.save(f"font_{uuid.uuid4().hex}{ext}", data, content_type)
        doc = {
            "font_id": new_id("fnt"),
            "family": family,
            "weight": weight,
            "style": style,
            "url": url,
            "format": fmt,
            "size": len(data),
            "filename": (file.filename or "")[:120],
            "created_at": now_iso(),
        }

        # replace_one+upsert rather than delete-then-insert: it is one atomic operation, so
        # two uploads of the same face racing each other cannot both pass a "does it exist"
        # check and then collide on the unique index.
        prev = await db.custom_fonts.find_one(
            {"family": family, "weight": weight, "style": style}, {"_id": 0, "url": 1}
        )
        await db.custom_fonts.replace_one(
            {"family": family, "weight": weight, "style": style}, dict(doc), upsert=True
        )
        if prev and prev.get("url") != url:
            # After the write, never before: failing here leaves an orphaned object in the
            # store, whereas failing the other way round leaves a face with no bytes.
            await storage.delete(prev["url"])
        return doc

    @api.delete("/admin/cms/fonts/{font_id}")
    async def admin_delete_font(font_id: str, user=Depends(require_admin_or_editor)):
        doc = await db.custom_fonts.find_one_and_delete({"font_id": font_id})
        if not doc:
            raise HTTPException(404, "Font not found")
        await storage.delete(doc.get("url"))
        return {"deleted": font_id}

    # ---------- Seed ----------

    @api.post("/cms/seed")
    async def cms_seed(user=Depends(require_admin)):
        """Seed demo CMS pages + theme. Idempotent. Admin only."""
        # Authored pages only. This used to count the whole collection, which stopped
        # being a "has anyone written anything yet?" question the moment the core nav
        # rows started living here too: they are created at boot, so the count was never
        # zero and a fresh install silently seeded nothing while reporting success.
        existing = await db.cms_pages.count_documents({"kind": {"$ne": "core"}})
        if existing > 0:
            return {"seeded": False, "reason": "already has data"}

        theme = _default_theme()
        await db.cms_theme.insert_one({
            "doc_id": "theme_current",
            "draft": theme,
            "published": theme,
            "versions": [],
            "created_at": now_iso(),
            "published_at": now_iso(),
        })

        home_blocks = _seed_home_blocks()
        mission_blocks = _seed_mission_blocks()
        contact_blocks = _seed_contact_blocks()

        pages = [
            _mk_page("home", "Home", "Home", 0, home_blocks),
            _mk_page("mission", "Mission", "Mission", 1, mission_blocks),
            _mk_page("contact", "Contact", "Contact", 2, contact_blocks),
        ]
        # Legal pages: editable in the CMS like any other page, but kept out of the
        # top nav (in_nav=False) — they live in the footer instead.
        for slug, title, blocks in _legal_pages():
            pages.append(_mk_page(slug, title, title, 100, blocks, in_nav=False))
        for pg in pages:
            await db.cms_pages.insert_one(pg)
        return {"seeded": True, "pages": len(pages)}

    @api.post("/admin/cms/seed-legal")
    async def cms_seed_legal(user=Depends(require_admin_or_editor)):
        """Idempotently create the legal pages (terms / privacy / cookies) if they
        don't already exist. Safe to re-run; never overwrites edited content."""
        created = []
        for slug, title, blocks in _legal_pages():
            if await db.cms_pages.find_one({"slug": slug}):
                continue
            await db.cms_pages.insert_one(_mk_page(slug, title, title, 100, blocks, in_nav=False))
            created.append(slug)
        return {"created": created}


def _default_theme():
    return {
        "mode": "dark",
        "colors": {
            "bg": "#050505",
            "surface": "#0F0F0F",
            "text": "#FFFFFF",
            "textMuted": "#A1A1AA",
            "accent": "#FF3333",
            "accentFg": "#000000",
            "success": "#E1FF00",
            "border": "rgba(255,255,255,0.1)",
        },
        "fonts": {
            "display": "Clash Display",
            "body": "Manrope",
            "mono": "IBM Plex Mono",
        },
        "spacing": {"sectionY": "6rem", "containerX": "2.5rem"},
        "radius": 0,
        "button_style": "sharp",  # sharp | pill
    }


def _mk_page(slug, title, nav_label, order, blocks, in_nav=True):
    now = datetime.now(timezone.utc).isoformat()
    return {
        "page_id": f"pg_{uuid.uuid4().hex[:16]}",
        "slug": slug,
        "title": title,
        "nav_label": nav_label,
        "nav_order": order,
        "in_nav": in_nav,
        "draft": {"blocks": blocks},
        "published": {"blocks": blocks},
        "versions": [],
        "created_at": now,
        "updated_at": now,
        "published_at": now,
    }


def _bk(t, **props):
    return {"block_id": f"bk_{uuid.uuid4().hex[:12]}", "type": t, "enabled": True, "props": props}


def _seed_home_blocks():
    return [
        _bk("hero",
            eyebrow="BUCHAREST · EST. 2019 · MUSIC · PERFORMANCE",
            heading="A collective for the ones after midnight.",
            body="Supersanity programmes music and performance with its own artists and its own box office. No promoter. No middlemen. One door.",
            image_url="https://images.unsplash.com/photo-1545128485-c400e7702796?crop=entropy&cs=srgb&fm=jpg&q=85",
            cta_label="Buy Tickets",
            cta_href="/events",
            cta_style="accent",
            second_cta_label="Read the manifesto",
            second_cta_href="/mission",
            align="left",
            height="tall"),
        _bk("marquee", items=["OBSIDIAN · CHAPTER I", "CORPUS · LIVE", "BOX OFFICE OPEN", "VOID ORCHESTRA", "NOKTURN", "LUMEN / CORPS"]),
        _bk("events_grid", heading="Upcoming", eyebrow="01 — Programme", limit=4, layout="grid-2"),
        _bk("artists_grid", heading="Artists", eyebrow="02 — Roster", limit=6, layout="grid-3"),
        _bk("cta_banner", heading="We build the room, the sound, and the door.", body="We keep the money out of promoters' pockets and inside the work.", cta_label="Read more", cta_href="/mission"),
    ]


def _seed_mission_blocks():
    return [
        _bk("rich_text",
            content="MANIFESTO · 01\n\n# We build the room, the sound, and the door.\n\nSupersanity is a music and performance collective in Bucharest. We programme our own nights, work with our own artists, and run our own box office. No promoter. No middleman.\n\nThe site you're on is the storefront. The ticketing engine behind it is ours. Every ticket sold, every scan at the door, every invoice — it all lands with us.\n\nWe keep the money inside the work. What comes in from the door pays the artists, the crew, the room, the light, the sound. What's left builds the next project.\n\n## After midnight, the collective owns its whole funnel."),
        _bk("split", direction="image-right",
            image_url="https://images.unsplash.com/photo-1593408995262-1d8933c37afc?crop=entropy&cs=srgb&fm=jpg&q=85",
            eyebrow="Approach",
            heading="Room, Sound, Door.",
            body="Every event we run controls the space, the audio system, and the box office ourselves. It's slower but it's ours.",
            cta_label="See events", cta_href="/events"),
        _bk("spacer", height="4rem"),
        _bk("gallery_grid", heading="Field Notes", limit=6),
    ]


def _seed_contact_blocks():
    return [
        _bk("rich_text",
            content="REACH US\n\n# Contact\n\nbookings@supersanity.collective — bookings\npress@supersanity.collective — press\nStudio, Bucharest, RO"),
        _bk("contact_form", heading="Say hello", success_message="Message sent. We'll be in touch."),
        _bk("newsletter", heading="No promoter. Just us.", body="Two emails a season, tops.", cta_label="Subscribe"),
    ]


# ---------- Legal pages ----------
# Starter templates only — the operator must review these with qualified counsel and
# fill the [bracketed] placeholders before relying on them. They're normal CMS pages,
# so all of this can be edited and re-published from the CMS editor.

def _legal_pages():
    return [
        ("terms", "Terms & Conditions", _seed_terms_blocks()),
        ("privacy", "Privacy Policy", _seed_privacy_blocks()),
        ("cookie-policy", "Cookie Policy", _seed_cookie_blocks()),
    ]


def _seed_terms_blocks():
    return [_bk("rich_text", content=(
        "LEGAL · TERMS\n\n"
        "# Terms & Conditions\n\n"
        "Last updated: [DATE]. This is a starter template and must be reviewed by "
        "qualified counsel before you rely on it.\n\n"
        "## 1. Who we are\n\n"
        "Supersanity (\"we\", \"us\") operates this site and sells tickets to events we "
        "programme. [Legal entity name, registration number, and registered address.]\n\n"
        "## 2. Tickets & orders\n\n"
        "Placing an order creates a binding contract once payment is confirmed. Tickets "
        "are personal to the buyer. We may refuse entry for invalid, duplicated, or "
        "resold tickets.\n\n"
        "## 3. Pricing & payment\n\n"
        "Prices are shown in RON and include applicable VAT. Payment is handled by our "
        "payment provider; we never store your full card details.\n\n"
        "## 4. Refunds & cancellations\n\n"
        "All sales are final unless an event is cancelled by us, in which case tickets "
        "are refunded to the original payment method. [Insert your rescheduling policy.]\n\n"
        "## 5. Conduct at events\n\n"
        "Entry is subject to venue rules and the law. We may refuse or revoke entry for "
        "unsafe or unlawful behaviour.\n\n"
        "## 6. Liability\n\n"
        "To the extent permitted by law, our liability is limited to the ticket price "
        "paid. Nothing here excludes liability that cannot be excluded by law.\n\n"
        "## 7. Changes\n\n"
        "We may update these terms. Material changes are posted here with a new "
        "\"last updated\" date.\n\n"
        "## 8. Contact\n\n"
        "Questions about these terms: bookings@supersanity.collective"
    ))]


def _seed_privacy_blocks():
    return [_bk("rich_text", content=(
        "LEGAL · PRIVACY\n\n"
        "# Privacy Policy\n\n"
        "Last updated: [DATE]. Starter template — review with counsel before publishing.\n\n"
        "## Who is responsible\n\n"
        "Supersanity is the data controller for personal data processed through this "
        "site. [Legal entity + contact for data requests.]\n\n"
        "## What we collect\n\n"
        "Account data (name, email, and optionally phone), order and ticket history, "
        "invoices, marketing preferences with a consent log, and payment metadata — "
        "never full card numbers, which go straight to our payment provider.\n\n"
        "## Why we process it\n\n"
        "To create your account and issue tickets, process payments, send transactional "
        "emails (order and ticket confirmations), and — only with your opt-in — send "
        "newsletters and promotions.\n\n"
        "## Legal bases\n\n"
        "Performance of a contract (tickets), legal obligation (invoice retention), and "
        "consent (marketing).\n\n"
        "## Sharing\n\n"
        "With our payment provider (Stripe), our email provider, and the identity "
        "providers you choose to sign in with (Google, Apple). We do not run "
        "third-party advertising trackers.\n\n"
        "## Retention\n\n"
        "Invoices and tickets are kept for the period required by tax law (approx. 10 "
        "years). Sessions expire after 7 days. Consent records are kept as evidence of "
        "compliance.\n\n"
        "## Your rights\n\n"
        "You can access, export, correct, or delete your data, and withdraw marketing "
        "consent at any time from your [account settings](/settings). Deletion "
        "anonymizes your account while retaining invoices as legally required.\n\n"
        "## Contact\n\n"
        "Data requests: bookings@supersanity.collective"
    ))]


def _seed_cookie_blocks():
    return [_bk("rich_text", content=(
        "LEGAL · COOKIES\n\n"
        "# Cookie Policy\n\n"
        "Last updated: [DATE]. Starter template — review with counsel before publishing.\n\n"
        "## Cookies we use\n\n"
        "We use only **strictly necessary** cookies.\n\n"
        "## Session cookie\n\n"
        "A single `session_token` cookie keeps you signed in and lets you complete a "
        "ticket purchase. It is essential — the site cannot function without it — and is "
        "not used for tracking or advertising.\n\n"
        "## What we don't use\n\n"
        "We do not run third-party analytics, advertising, or session-recording "
        "cookies. There is nothing to opt out of beyond the essential session cookie, "
        "which is cleared when you sign out.\n\n"
        "## Managing cookies\n\n"
        "You can clear cookies in your browser at any time; doing so signs you out.\n\n"
        "## Contact\n\n"
        "Questions: bookings@supersanity.collective"
    ))]
