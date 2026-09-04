"""
CMS routes: dynamic pages, theme, and navigation.
Public read endpoints + admin/editor write endpoints.
Keeps content and theme as structured JSON in Mongo — the frontend
renders everything dynamically from that data.
"""
from datetime import datetime, timezone
from typing import Dict, List, Optional
import json
import re
import uuid
import hashlib
# Google's CSS2 API takes the family as a query value; a space must become %20 (or
# '+'), which is exactly what quote() with no safe characters produces.
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, Response, UploadFile
from pydantic import BaseModel, Field
from models_base import ApiModel, LONG_TEXT, MAX_JSON_DOC_BYTES

import storage
from sanitize import sanitize_draft, sanitize_blocks


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
    # No Archive. It showed the projects grid and a past-events list; projects are
    # retired, and past events have been reachable from the Events page's own tabs since
    # the All/Past tabs landed. See migrate_drop_archive_page.
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

# A font's URL is server-generated — a blob address or "/uploads/<uuid>.woff2" — so this
# is a sanity bound, not an editorial one. Blob URLs comfortably exceed the 120 characters
# the colour sanitiser allows, which is half of why that sanitiser must not be used on one.
MAX_FONT_URL_CHARS = 2048
# Characters that cannot appear in a URL sitting inside url("..."): the quotes and
# whitespace that would close the token early, and the punctuation CSS uses to open and
# close declarations and comments.
_CSS_URL_FORBIDDEN = frozenset('"\'\\()<>;{} \t\r\n')

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
    "events", "shop", "artists", "gallery", "cart", "checkout",
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



def _refuse_oversized(payload, what: str):
    """Bound the free-form `dict` payloads (audit M9).

    `str_max_length` on the model config covers every *typed* string field, which is most
    of the API. It cannot reach these: a CMS draft is `Optional[dict]` — a block tree whose
    shape is the block set's business, not Pydantic's — so nothing bounded it at all.

    Measured rather than guessed: the largest real page is 3.6 KB, so the ceiling is two
    orders of magnitude of headroom and exists to stop "arbitrarily large", not to tell an
    editor when to stop writing.
    """
    if payload is None:
        return
    size = len(json.dumps(payload, default=str).encode("utf-8"))
    if size > MAX_JSON_DOC_BYTES:
        raise HTTPException(
            413, f"{what} is {size // 1024} KB; the limit is {MAX_JSON_DOC_BYTES // 1024} KB")


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


# The heading and eyebrow at the top of each built-in section page.
#
# These four pages are React routes with no blocks, so their two lines of type were
# literals in the JSX — a white-label customer who runs a bookshop got "Programme" over
# their events and could do nothing about it. They are content, and content belongs in
# the CMS, so they live here for the same reason the Events tab set does.
#
# The values below are what the pages used to hardcode, which is what makes this change
# invisible to a site that never opens the panel.
CORE_PAGE_HEADERS = {
    "events": {"eyebrow": "Programme", "heading": "Events"},
    "artists": {"eyebrow": "Roster", "heading": "Artists"},
    "gallery": {"eyebrow": "Documentation", "heading": "Gallery"},
    "shop": {"eyebrow": "Merchandise", "heading": "Shop"},
}


class CorePageHeaderIn(ApiModel):
    """One built-in page's two lines. Blank means blank — see CorePageHeadersIn."""
    eyebrow: str = ""
    heading: str = ""


class CorePageHeadersIn(ApiModel):
    """The headings for the built-in section pages, keyed by the slugs above.

    A page may be sent on its own; the ones left out keep whatever they had. Within a
    page that IS sent, both fields are written verbatim, so an emptied box empties the
    line on the site rather than falling back to the built-in wording. That is the same
    "blank means BLANK" rule the site settings follow, and for the same reason: an editor
    who clears a field and is told it saved should not find the old text still there.
    """
    pages: Dict[str, CorePageHeaderIn] = Field(default_factory=dict, max_length=8)


class EventsSettingsIn(ApiModel):
    """Which tabs the Events page offers, and which one it opens on.

    A closed vocabulary rather than free strings: these map to a tri-state query on
    /events, not to a taxonomy, so a value outside the set has nothing to mean.
    """
    tabs: List[str] = Field(default_factory=list, max_length=8)
    default_tab: str = "all"


def register_cms_routes(api: APIRouter, db, require_admin, require_admin_or_editor):
    """Attach all CMS endpoints to the provided api router."""

    def now_iso():
        return datetime.now(timezone.utc).isoformat()

    def new_id(prefix):
        return f"{prefix}_{uuid.uuid4().hex[:16]}"

    class PageIn(ApiModel):
        slug: str
        title: str
        nav_label: Optional[str] = None
        nav_order: int = 100
        in_nav: bool = True
        # A page belongs to the top nav or to the footer, never both — see
        # `_apply_placement`. The seeded legal pages were already in_nav=False with a
        # comment saying they live in the footer; this is that comment made real.
        in_footer: bool = False
        footer_order: int = 100

    class PagePatch(ApiModel):
        title: Optional[str] = None
        nav_label: Optional[str] = None
        nav_order: Optional[int] = None
        in_nav: Optional[bool] = None
        in_footer: Optional[bool] = None
        footer_order: Optional[int] = None
        draft: Optional[dict] = None  # {blocks: [...]}

    def _apply_placement(patch: dict, current: dict) -> dict:
        """Keep `in_nav` and `in_footer` mutually exclusive.

        A page is in the top nav or in the footer, not both: the footer is where the
        pages that are not part of the journey go — terms, privacy, cookies — and
        listing one in both places is how a nav ends up with eleven items nobody reads.

        Applied to whichever flag the request SET, so ticking either one unticks the
        other rather than refusing the edit. Refusing would mean an editor has to know
        the rule before they can act on it.
        """
        if patch.get("in_footer") is True:
            patch["in_nav"] = False
        elif patch.get("in_nav") is True:
            patch["in_footer"] = False
        return patch

    class SiteSettingsIn(ApiModel):
        """The site's own words: the two wordmarks, and everything the footer says apart
        from its links — those are CMS pages."""
        header_wordmark: str = ""
        nav_size: Optional[int] = None
        # How far text sits from the screen edge, in px, at the two breakpoints. Media is
        # unaffected and still bleeds — this is only ever applied to type.
        text_inset_sm: Optional[int] = None
        text_inset_lg: Optional[int] = None
        wordmark: str = ""
        description: str = ""
        legal_heading: str = ""
        contact_heading: str = ""
        contact_email: str = ""
        copyright_name: str = ""
        # Keyed by platform, same vocabulary the artist form uses.
        social: dict = {}

    class ReorderIn(ApiModel):
        order: List[str]  # page_ids in desired nav order

    class ThemePatch(ApiModel):
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

    # ---- The theme as a stylesheet ----
    #
    # WHY THIS EXISTS. The theme used to arrive only as JSON, fetched by the app AFTER it
    # mounted, and applied as inline custom properties. That is two round trips behind the
    # first paint, so every reload showed the default palette from index.css for a moment
    # and then snapped to the real one — most visible right after publishing, which is
    # exactly when someone is looking.
    #
    # A stylesheet in <head> is render-blocking by definition: the browser will not paint
    # until it has it. So the theme now travels with the initial payload and the flash is
    # gone by construction rather than by being made faster. ThemeLoader still runs for
    # the live CMS preview and for Google-hosted families; on a public page it now finds
    # everything already applied and changes nothing.

    # Families index.css already self-hosts from @fontsource, plus the one Google does not
    # serve at all. Asking Google for any of these is either a duplicate download of a face
    # the page already has, or — for Clash Display — a 404 that takes the whole combined
    # request down with it. Mirrors NON_GOOGLE in lib/cms.js; the two must agree.
    _SELF_HOSTED = frozenset({"Clash Display", "Manrope", "IBM Plex Mono"})

    # The weights ensureFontLoaded() has always asked for. Kept identical on purpose: the
    # browser then serves the JS-injected <link> from cache instead of fetching a second,
    # differently-weighted copy of the same family.
    _GOOGLE_WEIGHTS = "300;400;500;600;700;800;900"

    def _google_font_imports(f: dict, fonts: list) -> str:
        """`@import` lines for whichever theme families Google has to serve.

        WHY THIS IS IN THE STYLESHEET. The families are chosen in the CMS, so index.html
        cannot name them at build time and the browser only learned them from JS: the app
        booted, ThemeLoader fetched /cms/theme as JSON, applyTheme called ensureFontLoaded,
        and only then was a <link> to Google appended. Measured on the beta deploy, that
        put the request for the site's own display face at t=5117ms — the page spent its
        first five seconds in a fallback and then reflowed. This stylesheet is already
        render-blocking and already knows the family name, so the request starts with it.

        The cost is honest and worth naming: an @import is a second round trip chained
        behind this file rather than issued alongside it. It is still four seconds earlier
        than what it replaces, and it is the only shape available while the family is a
        per-deployment setting — a static preconnect in index.html would open a connection
        to Google for every visitor of every customer, including the ones whose theme uses
        nothing but the self-hosted faces.

        Uploaded families are excluded because _font_face_css below already points them at
        their own blob URL; asking Google for a customer's private face would 404.
        """
        uploaded = {(x.get("family") or "").strip() for x in (fonts or [])}
        wanted, seen = [], set()
        for key in ("display", "body", "mono"):
            family = (f.get(key) or "").strip()
            if not family or family in seen or family in _SELF_HOSTED or family in uploaded:
                continue
            # The same gate the family already passes to be written into a declaration.
            # A name that cannot appear in `font-family:` has no business in a URL either.
            if not FAMILY_RE.match(family):
                continue
            seen.add(family)
            wanted.append(family)
        if not wanted:
            return ""
        # One @import per family, not one combined request. Google's CSS2 API fails the
        # WHOLE request if any single family in it is unknown, so a combined line would
        # let one bad name in the CMS strip the typography off the entire site.
        return "\n".join(
            f'@import url("https://fonts.googleapis.com/css2'
            f'?family={quote(family)}:wght@{_GOOGLE_WEIGHTS}&display=swap");'
            for family in wanted
        )

    def _font_face_css(fonts: list) -> str:
        """@font-face rules for the uploaded faces. Mirrors fontFaceCss() in lib/fonts.js
        — the two must agree, or the live CMS preview and the served page disagree about
        which file a family points at."""
        hints = {"woff2": "woff2", "woff": "woff", "ttf": "truetype", "otf": "opentype"}
        out = []
        for f in fonts or []:
            family, url = (f.get("family") or "").strip(), (f.get("url") or "").strip()
            if not family or not url:
                continue
            href = _css_url(url)
            if not href:
                continue
            hint = hints.get((f.get("format") or "").lower())
            src = f'url("{href}")' + (f' format("{hint}")' if hint else "")
            out.append("\n".join([
                "@font-face {",
                f'  font-family: "{_css_value(family)}";',
                f"  src: {src};",
                f"  font-weight: {int(f.get('weight') or 400)};",
                f"  font-style: {'italic' if f.get('style') == 'italic' else 'normal'};",
                # Show the fallback while the file downloads rather than nothing at all.
                "  font-display: swap;",
                "}",
            ]))
        return "\n\n".join(out)

    def _hex_channels(value: str):
        """"#1166ff" -> "17 102 255", which is the shape Tailwind's rgb(var(--x) / a)
        needs. Mirrors toChannels() in lib/cms.js; anything not a plain hex triple is
        skipped rather than guessed at."""
        v = (value or "").strip()
        if not v.startswith("#"):
            return None
        v = v[1:]
        if len(v) == 3:
            v = "".join(c * 2 for c in v)
        if len(v) != 6:
            return None
        try:
            return " ".join(str(int(v[i:i + 2], 16)) for i in (0, 2, 4))
        except ValueError:
            return None

    def _css_value(value: str) -> str:
        """Custom property values land inside a declaration block, so a `}` or a comment
        opener in one would end the rule early and let an editor's colour field write
        arbitrary CSS. Colours and lengths need none of those characters.

        NOT for URLs — see _css_url, and the bug that note describes."""
        return re.sub(r"[^A-Za-z0-9#(),.%/_\- ]", "", str(value or ""))[:120]

    def _css_url(value: str) -> Optional[str]:
        """A font file's address, ready to sit inside `url("...")`, or None if it is not
        one this will vouch for.

        This exists because _css_value was used here, and _css_value has no colon in its
        allowlist. Run an absolute URL through it and

            https://blob.example.com/uploads/font_ab12.ttf
              becomes  https//blob.example.com/uploads/font_ab12.ttf

        which is no longer absolute, so the browser resolves it against the stylesheet's
        own address and asks for /api/cms/https/blob.example.com/... — a 404 on every
        page load, and a site quietly rendering in a fallback face. The 120-character cap
        was the second half of the same mistake: blob URLs run past it, and a truncated
        URL 404s just as silently as a mangled one.

        It survived review because local development stores uploads at "/uploads/name",
        which has no colon to lose and no length to exceed. Only a deployment backed by
        blob storage ever saw it.

        Refusing beats sanitising. A mangled URL yields a face that never loads with
        nothing anywhere to say why; a refused one is simply not written, and the family
        falls back to the stack the theme already names.
        """
        v = str(value or "").strip()
        if not v or len(v) > MAX_FONT_URL_CHARS:
            return None
        # Quotes and whitespace would end the url() token early; the rest are how a CSS
        # declaration or comment is opened and closed. A URL needs none of them — the
        # ones that may legitimately appear in a path arrive percent-encoded.
        if any(c in _CSS_URL_FORBIDDEN or ord(c) < 0x20 for c in v):
            return None
        # Absolute http(s), or root-relative as the local store writes. Nothing else:
        # "javascript:" and "data:" have no business naming a typeface, and a
        # protocol-relative "//host" would follow the page onto plain http.
        if v.startswith(("https://", "http://")):
            return v
        if v.startswith("/") and not v.startswith("//"):
            return v
        return None

    def _theme_css(theme: dict, fonts: list) -> str:
        c = (theme or {}).get("colors") or {}
        f = (theme or {}).get("fonts") or {}
        s = (theme or {}).get("spacing") or {}
        light = (theme or {}).get("mode") == "light"

        decls = []

        def color(name, key, channel=None):
            raw = c.get(key)
            if not raw:
                return
            decls.append(f"  {name}: {_css_value(raw)};")
            if channel:
                ch = _hex_channels(raw)
                if ch:
                    decls.append(f"  {channel}: {ch};")

        color("--bg", "bg", "--bg-rgb")
        color("--surface", "surface")
        color("--text", "text", "--text-rgb")
        # --text-muted, not --text-2: index.css derives the -2/-4/-5 ramp from this one.
        color("--text-muted", "textMuted")
        color("--accent", "accent", "--accent-rgb")
        color("--accent-fg", "accentFg")
        color("--success", "success")
        color("--border", "border")

        if f.get("display"):
            decls.append(f'  --font-display: "{_css_value(f["display"])}";')
        if f.get("body"):
            decls.append(f'  --font-body: "{_css_value(f["body"])}";')
        if f.get("mono"):
            decls.append(f'  --font-mono: "{_css_value(f["mono"])}";')
        if s.get("sectionY"):
            decls.append(f"  --section-y: {_css_value(s['sectionY'])};")
        if s.get("containerX"):
            decls.append(f"  --container-x: {_css_value(s['containerX'])};")
        # Clamped, not trusted: this lands in a stylesheet every visitor loads, and a
        # nav at 200px would push the header off the page with no way back except the
        # CMS the header is needed to reach.
        nav_size = (theme or {}).get("nav_size")
        if nav_size is not None:
            try:
                decls.append(f"  --nav-size: {max(8, min(32, int(nav_size)))}px;")
            except (TypeError, ValueError):
                pass
        # Clamped like nav_size above, and for a sharper reason: this one is the distance
        # between every word on the site and the edge of the screen. At 0 the problem it
        # exists to solve comes straight back; past 64 the text column collapses on a
        # phone. Both bounds are reachable only through a slider that cannot exceed them,
        # so this is defence against a hand-edited value, not against the UI.
        for key, prop in (("text_inset_sm", "--text-inset-sm"), ("text_inset_lg", "--text-inset-lg")):
            raw = (theme or {}).get(key)
            if raw is None:
                continue
            try:
                decls.append(f"  {prop}: {max(0, min(64, int(raw)))}px;")
            except (TypeError, ValueError):
                pass
        if (theme or {}).get("radius") is not None:
            decls.append(f"  --radius: {int((theme or {}).get('radius') or 0)}px;")
        decls.append(
            "  --btn-radius: 999px;" if (theme or {}).get("button_style") == "pill"
            else "  --btn-radius: var(--radius);"
        )
        # index.css hangs these off `:root[data-theme="light"]`, and an attribute is the
        # one thing a stylesheet cannot set on its own. Emitting the resolved values
        # instead means first paint is right without waiting for the JS that sets it.
        if light:
            decls.append("  --hero-image-opacity: 0.85;")

        # `:root:root`, not `:root`. index.css declares the same custom properties as
        # defaults, and the bundler injects that stylesheet AFTER this link — so at equal
        # specificity the defaults win on source order and this file does nothing.
        # Doubling the pseudo-class raises specificity to 0,2,0 and settles it whichever
        # order the two arrive in, which is the only thing that stays true across a dev
        # server that injects CSS from JS and a build that emits a second <link>.
        blocks = [":root:root {\n" + "\n".join(decls) + "\n}"]
        if light:
            blocks.append(":root:root .grain-overlay { opacity: 0.02; }")

        # @import FIRST, because CSS says so: an @import after any rule is dropped.
        imports = _google_font_imports(f, fonts)
        if imports:
            blocks.insert(0, imports)

        # The uploaded faces ride along, so `--font-display: "SomeUpload"` resolves at
        # first paint too. Without this the page renders one frame in the fallback face.
        face_css = _font_face_css(fonts)
        if face_css:
            blocks.append(face_css)
        return "\n\n".join(blocks) + "\n"

    @api.get("/cms/theme.css")
    async def get_theme_css(request: Request):
        """The published theme, as the stylesheet the document links in <head>."""
        t = await db.cms_theme.find_one({"doc_id": "theme_current"}, {"_id": 0})
        theme = (t or {}).get("published") or _default_theme()
        # Merged in rather than read from the theme document: the value is a site setting
        # now, but it has to reach the browser through the render-blocking stylesheet or
        # the nav paints at the default size and then jumps.
        site = await _site_settings()
        # Same reasoning as nav_size: these are site settings, but they have to arrive in
        # the render-blocking stylesheet or every block paints at the default inset and
        # then shifts sideways once the JS lands.
        theme = {**theme, "nav_size": site["nav_size"],
                 "text_inset_sm": site.get("text_inset_sm"),
                 "text_inset_lg": site.get("text_inset_lg")}
        fonts = await _fonts_sorted()
        css = _theme_css(theme, fonts)

        # Revalidate every load, but pay for the bytes only when it actually changed:
        # publishing a theme has to take effect on the next reload, and a cached stale
        # palette would be a worse bug than the flash this replaces.
        etag = '"' + hashlib.sha256(css.encode()).hexdigest()[:32] + '"'
        if request.headers.get("if-none-match") == etag:
            return Response(status_code=304, headers={"ETag": etag, "Cache-Control": "no-cache"})
        return Response(
            content=css,
            media_type="text/css",
            headers={"ETag": etag, "Cache-Control": "no-cache"},
        )

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

    # ---------- Footer ----------
    #
    # The footer used to be typed into Layout.jsx: a wordmark, a sentence, three links,
    # an address and a copyright line. All of it is content, none of it was editable, and
    # the three links pointed at CMS pages by hardcoded href — so renaming or unpublishing
    # one of those pages left the footer pointing at a 404 with nothing to say so.
    #
    # The links are pages now, chosen with `in_footer`. The rest is one settings document.

    SITE_DEFAULTS = {
        # Two fields on purpose rather than one shared value: the header and the footer
        # say the same thing today, and nothing should force them to say it forever.
        "header_wordmark": "SUPERSANITY",
        # The header nav's type size. It lived in the theme document, which is where
        # typography belongs in the abstract and the last place anyone looked for it.
        "nav_size": 11,
        # The distance between text and the edge of the screen, at the two breakpoints.
        # These match the defaults written in index.css; the pair exists so a site can be
        # tuned without a deploy, not so the two can drift.
        "text_inset_sm": 16,
        "text_inset_lg": 24,
        "wordmark": "SUPERSANITY",
        "description": "A Bucharest music & performance collective. "
                       "Programming, artists, box office — one door.",
        "legal_heading": "Legal",
        "contact_heading": "Contact",
        "contact_email": "bookings@supersanity.collective",
        "copyright_name": "Supersanity",
        "social": {},
    }

    async def _site_settings() -> dict:
        doc = await db.site_settings.find_one({"_id": "site"}, {"_id": 0}) or {}
        merged = dict(SITE_DEFAULTS)
        merged.update({k: v for k, v in doc.items() if k in SITE_DEFAULTS and v is not None})
        merged["social"] = {k: v for k, v in (merged.get("social") or {}).items() if v}
        return merged

    async def _footer_pages() -> list:
        """The pages the footer links to, in order. Published only, and never core rows —
        a core row is a React route with no blocks, and the footer is for authored pages."""
        cursor = db.cms_pages.find(
            {"in_footer": True, "kind": {"$ne": "core"}, "published": {"$ne": None}},
            {"_id": 0, "slug": 1, "title": 1, "nav_label": 1, "footer_order": 1},
        ).sort([("footer_order", 1), ("title", 1)])
        return [
            {"slug": p["slug"], "label": p.get("nav_label") or p.get("title") or p["slug"]}
            for p in await cursor.to_list(50)
        ]

    @api.get("/cms/site")
    async def get_site():
        """Public: every visitor's footer, in one request."""
        return {**await _site_settings(), "pages": await _footer_pages()}

    @api.get("/admin/cms/site")
    async def admin_get_site(user=Depends(require_admin_or_editor)):
        return {**await _site_settings(), "pages": await _footer_pages()}

    @api.put("/admin/cms/site")
    async def admin_put_site(body: SiteSettingsIn, user=Depends(require_admin_or_editor)):
        patch = body.model_dump()
        # Only the fields the caller actually sent. Every string on this model defaults to
        # "", so without this a request carrying one field would blank the other eight.
        sent = body.model_fields_set

        # Blank means BLANK. It used to mean "ignored": an empty field was stripped out
        # here, so clearing the footer description or the wordmark in the CMS did nothing
        # at all — the box showed empty, the editor said saved, and the site kept the old
        # text. The comment that guarded it claimed blank meant "use the built-in", which
        # is a third behaviour it also did not have.
        #
        # The cost is that a wordmark can now be emptied, and an empty one leaves a blank
        # corner. That is the editor's to decide; silently refusing the edit was not.
        cleaned = {k: (v.strip() if isinstance(v, str) else v)
                   for k, v in patch.items() if k in sent}
        # None still means absent — an Optional that was sent as null should not be
        # written over the default with nothing.
        cleaned = {k: v for k, v in cleaned.items() if v is not None}
        if "social" in sent:
            cleaned["social"] = {k: str(v).strip() for k, v in (patch.get("social") or {}).items()
                                 if str(v or "").strip()}
        # Clamped here as well as in the stylesheet: a nav at 200px pushes the header off
        # the page, and the CMS that would undo it is reached through that header.
        if patch.get("nav_size") is not None:
            try:
                cleaned["nav_size"] = max(8, min(32, int(patch["nav_size"])))
            except (TypeError, ValueError):
                cleaned.pop("nav_size", None)
        # Assigned after the filter above, like nav_size, so the clamped number is what
        # lands rather than the raw one. 0 is a legitimate setting — someone may genuinely
        # want type at the edge — and it survives that filter, which tests membership of
        # ("", None) rather than truthiness. Worth stating, because the two read alike.
        for key in ("text_inset_sm", "text_inset_lg"):
            if patch.get(key) is not None:
                try:
                    cleaned[key] = max(0, min(64, int(patch[key])))
                except (TypeError, ValueError):
                    cleaned.pop(key, None)
        await db.site_settings.update_one({"_id": "site"}, {"$set": cleaned}, upsert=True)
        return {**await _site_settings(), "pages": await _footer_pages()}

    # ---------- Events page settings ----------
    #
    # /events is a React route, not a CMS page, so its tabs have nowhere to be authored.
    # They live here rather than in the theme because they are content decisions, not
    # appearance: which slices of the programme a visitor is offered, and which one they
    # land on. Read per request for the same reason the VAT rate is — a change has to take
    # effect on the next page load, not the next deploy.

    EVENT_TABS = ("all", "upcoming", "past")
    EVENTS_DEFAULTS = {"tabs": list(EVENT_TABS), "default_tab": "all"}

    async def _events_settings() -> dict:
        doc = await db.site_settings.find_one({"_id": "events"}, {"_id": 0}) or {}
        tabs = [t for t in doc.get("tabs", EVENTS_DEFAULTS["tabs"]) if t in EVENT_TABS]
        # An empty tab list would render a page with no way to see anything, so the
        # stored value is only honoured while it still leaves something to click.
        if not tabs:
            tabs = list(EVENTS_DEFAULTS["tabs"])
        default_tab = doc.get("default_tab", EVENTS_DEFAULTS["default_tab"])
        # The default has to be a tab that is actually shown, or the page opens on a
        # filter with no button to leave it by.
        if default_tab not in tabs:
            default_tab = tabs[0]
        return {"tabs": tabs, "default_tab": default_tab}

    @api.get("/cms/events-settings")
    async def get_events_settings():
        """Public: the Events page reads this before it renders its tabs."""
        return await _events_settings()

    @api.get("/admin/cms/events-settings")
    async def admin_get_events_settings(user=Depends(require_admin_or_editor)):
        return {**await _events_settings(), "available_tabs": list(EVENT_TABS)}

    @api.put("/admin/cms/events-settings")
    async def admin_put_events_settings(body: EventsSettingsIn,
                                        user=Depends(require_admin_or_editor)):
        tabs = [t for t in dict.fromkeys(body.tabs) if t in EVENT_TABS]
        if not tabs:
            raise HTTPException(400, "Keep at least one tab")
        default_tab = body.default_tab if body.default_tab in tabs else tabs[0]
        await db.site_settings.update_one(
            {"_id": "events"},
            {"$set": {"tabs": tabs, "default_tab": default_tab}},
            upsert=True,
        )
        return await _events_settings()

    # ---------- Built-in page headings ----------
    #
    # One document for all four pages, and one request for the page that needs it. They
    # were four sets of literals in four JSX files; a per-page endpoint would have been
    # four round trips to say something this small.

    async def _core_page_headers() -> dict:
        doc = await db.site_settings.find_one({"_id": "core_pages"}, {"_id": 0}) or {}
        out = {}
        for slug, default in CORE_PAGE_HEADERS.items():
            stored = doc.get(slug)
            # A page that has never been edited has no key here and keeps the built-in
            # wording. Once it HAS been edited the stored pair is the whole answer,
            # including its empty halves — which is what lets a line be deleted rather
            # than only rewritten.
            if isinstance(stored, dict):
                out[slug] = {"eyebrow": str(stored.get("eyebrow", "")),
                             "heading": str(stored.get("heading", ""))}
            else:
                out[slug] = dict(default)
        return out

    @api.get("/cms/core-pages")
    async def get_core_page_headers():
        """Public: what Events, Artists, Gallery and Shop print at the top."""
        return await _core_page_headers()

    @api.get("/admin/cms/core-pages")
    async def admin_get_core_page_headers(user=Depends(require_admin_or_editor)):
        # `defaults` so the editor can offer a "back to the built-in wording" affordance
        # without hardcoding the same four pairs a second time in the frontend.
        return {"pages": await _core_page_headers(), "defaults": CORE_PAGE_HEADERS}

    @api.put("/admin/cms/core-pages")
    async def admin_put_core_page_headers(body: CorePageHeadersIn,
                                          user=Depends(require_admin_or_editor)):
        unknown = [s for s in body.pages if s not in CORE_PAGE_HEADERS]
        if unknown:
            raise HTTPException(400, f"No such built-in page: {', '.join(sorted(unknown))}")
        # Whitespace is not content. Trimmed on the way in so that a box holding one
        # space reads as deleted on the site, which is what it looks like in the editor.
        patch = {slug: {"eyebrow": value.eyebrow.strip(), "heading": value.heading.strip()}
                 for slug, value in body.pages.items()}
        if patch:
            await db.site_settings.update_one({"_id": "core_pages"}, {"$set": patch}, upsert=True)
        return await _core_page_headers()

    @api.get("/cms/nav")
    async def get_public_nav(request: Request):
        """The whole navigation bar, in order, with hrefs resolved.

        Core rows qualify on `kind` rather than on `published`: they have no blocks to
        publish, so the published check that (correctly) hides an unfinished page would
        otherwise hide every built-in section permanently.

        Carries an ETag. This is fetched on every page load by every visitor and changes
        only when an editor reorders or publishes something, so the common case should
        cost a 304 and no body — the header is one of the first things a visitor waits on.
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

        nav = [
            {
                "slug": p["slug"],
                "label": p.get("nav_label") or p["title"],
                "route": route_for(p),
                "kind": p.get("kind") or "page",
            }
            for p in items
        ]

        body = json.dumps(nav, separators=(",", ":"))
        etag = '"' + hashlib.sha256(body.encode()).hexdigest()[:32] + '"'
        if request.headers.get("if-none-match") == etag:
            return Response(status_code=304, headers={"ETag": etag, "Cache-Control": "no-cache"})
        # no-cache, not max-age: a reordered nav has to appear on the next load, and the
        # revalidation it costs is a 304 with no body.
        return Response(content=body, media_type="application/json",
                        headers={"ETag": etag, "Cache-Control": "no-cache"})

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
        placement = _apply_placement(
            {"in_nav": body.in_nav, "in_footer": body.in_footer}, {})
        doc = {
            "page_id": new_id("pg"),
            "slug": body.slug,
            "title": body.title,
            "nav_label": body.nav_label or body.title,
            "nav_order": body.nav_order,
            "in_nav": placement["in_nav"],
            "in_footer": placement["in_footer"],
            "footer_order": body.footer_order,
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
        _refuse_oversized(body.draft, "This page")
        upd = {k: v for k, v in body.model_dump().items() if v is not None}
        # Ticking one placement unticks the other, rather than refusing the edit — an
        # editor should not have to know the rule before they are allowed to act on it.
        current = await db.cms_pages.find_one({"page_id": page_id}, {"_id": 0, "in_nav": 1, "in_footer": 1})
        upd = _apply_placement(upd, current or {})
        # Clean HTML on the way in, not only on the way out (audit M10). The React
        # renderer still runs DOMPurify, but this is what keeps live payloads out of the
        # database and out of every consumer that is not that one component.
        if "draft" in upd:
            upd["draft"] = sanitize_draft(upd["draft"])
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
                # The last gate before content is public. Drafts are cleaned on save, so
                # this is redundant for anything written since — and is exactly what
                # catches a draft that predates the fix.
                "published": {"blocks": sanitize_blocks(draft.get("blocks", []))},
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
            # Sanitized on the way back too: a snapshot taken before M10 was fixed holds
            # whatever was stored then, and restoring it must not reintroduce it.
            {"$set": {"draft": {"blocks": sanitize_blocks(version["blocks"])},
                      "updated_at": now_iso()}},
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
        _refuse_oversized(body.draft, "This theme")
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
        # Bounded here rather than by ApiModel: FastAPI generates the body model for a
        # Form() signature and it does not inherit our base (audit M9).
        family: str = Form(..., max_length=200),
        weight: int = Form(400),
        style: str = Form("normal", max_length=50),
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
        # The header nav's type size, in px. A theme value rather than a hardcoded class
        # because how big the menu should be depends on how many items are in it and how
        # long their labels are — both of which an editor changes, and neither of which
        # is knowable when the class is written.
        "nav_size": 11,
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
