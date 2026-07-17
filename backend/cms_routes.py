"""
CMS routes: dynamic pages, theme, and navigation.
Public read endpoints + admin/editor write endpoints.
Keeps content and theme as structured JSON in Mongo — the frontend
renders everything dynamically from that data.
"""
from datetime import datetime, timezone
from typing import List, Optional
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel


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

    @api.get("/cms/theme")
    async def get_public_theme():
        t = await db.cms_theme.find_one({"doc_id": "theme_current"}, {"_id": 0})
        if not t:
            return {"published": _default_theme()}
        return {"published": t.get("published", _default_theme())}

    @api.get("/cms/nav")
    async def get_public_nav():
        cursor = db.cms_pages.find(
            {"in_nav": True, "published": {"$ne": None}},
            {"_id": 0, "page_id": 1, "slug": 1, "nav_label": 1, "title": 1, "nav_order": 1},
        ).sort("nav_order", 1)
        items = await cursor.to_list(200)
        return [
            {"slug": p["slug"], "label": p.get("nav_label") or p["title"]} for p in items
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
        if await db.cms_pages.find_one({"slug": body.slug}):
            raise HTTPException(400, "Slug already exists")
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
        r = await db.cms_pages.delete_one({"page_id": page_id})
        if r.deleted_count == 0:
            raise HTTPException(404, "Page not found")
        return {"ok": True}

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

    # ---------- Seed ----------

    @api.post("/cms/seed")
    async def cms_seed():
        """Seed demo CMS pages + theme. Idempotent."""
        existing = await db.cms_pages.count_documents({})
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
        for pg in pages:
            await db.cms_pages.insert_one(pg)
        return {"seeded": True, "pages": len(pages)}


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


def _mk_page(slug, title, nav_label, order, blocks):
    now = datetime.now(timezone.utc).isoformat()
    return {
        "page_id": f"pg_{uuid.uuid4().hex[:16]}",
        "slug": slug,
        "title": title,
        "nav_label": nav_label,
        "nav_order": order,
        "in_nav": True,
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
            body="Umbra programmes music and performance with its own artists and its own box office. No promoter. No middlemen. One door.",
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
            content="MANIFESTO · 01\n\n# We build the room, the sound, and the door.\n\nUmbra is a music and performance collective in Bucharest. We programme our own nights, work with our own artists, and run our own box office. No promoter. No middleman.\n\nThe site you're on is the storefront. The ticketing engine behind it is ours. Every ticket sold, every scan at the door, every invoice — it all lands with us.\n\nWe keep the money inside the work. What comes in from the door pays the artists, the crew, the room, the light, the sound. What's left builds the next project.\n\n## After midnight, the collective owns its whole funnel."),
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
            content="REACH US\n\n# Contact\n\nbookings@umbra.collective — bookings\npress@umbra.collective — press\nStudio, Bucharest, RO"),
        _bk("contact_form", heading="Say hello", success_message="Message sent. We'll be in touch."),
        _bk("newsletter", heading="No promoter. Just us.", body="Two emails a season, tops.", cta_label="Subscribe"),
    ]
