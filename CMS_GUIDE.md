# CMS Guide — Supersanity

## What you get
- **/cms** — full visual editor (admin or editor role required)
- **/:slug** — public dynamic pages rendered from CMS data, served straight off the root
  (`/mission`, not `/p/mission`). `/p/:slug` still works: it is a permanent redirect to
  the new address, declared in `vercel.json`.
- **/** — renders whichever page is flagged as the homepage (the ⌂ button in Navigation),
  not the page whose slug happens to spell "home"
- Events, Artists, Archive, Gallery, ticketing flows are unchanged (per user choice 1a — auto-generated from the ticketing data)

### Slugs that are not available
Pages share the root with the built-in sections, so some names are taken: `events`,
`shop`, `artists`, `archive`, `gallery`, `cart`, `checkout`, `my-tickets`, `my-orders`,
`settings`, `newsletter`, `login`, `complete-profile`, `verify`, `reset-password`,
`admin`, `cms`, `scan`, plus `api`, `p` and `static`.

Creating a page on one of those is refused rather than allowed and then silently
shadowed — React Router ranks a static route above the `:slug` catch-all, so the page
would exist in the CMS and never open. The list lives in `RESERVED_SLUGS`
(`backend/cms_routes.py`); a test reads `frontend/src/App.js` and fails if a route is
ever added without being listed there.

## Roles
- `admin` — everything, including admin ticketing dashboard + CMS
- `editor` — CMS only (no admin dashboard, no scanner)
- `door` — scanner only
- `user` — default

## Seed
POST `/api/cms/seed` — idempotent. Seeds 3 pages (home, mission, contact) + default theme.

## Blocks (14)
hero · rich_text · image · gallery_grid · events_grid · artists_grid · marquee · cta_banner · contact_form · newsletter · video · custom_html · spacer · split

## Data model
- `cms_pages`: {page_id, slug, title, nav_label, nav_order, in_nav, draft:{blocks}, published:{blocks}, versions:[last 20]}
- `cms_theme`: singleton doc_id="theme_current" with draft/published/versions
- Each block: {block_id, type, enabled, props:{...}}

## Editor UX
- **Left panel**: pages list (reorder + delete) · block palette (14 blocks) · structure list (drag to reorder, toggle visibility, delete)
- **Center**: live inline preview. Click any block to select. Mobile/desktop toggle at top.
- **Right panel** (tabs): Props (per-block form) · Theme (colors/fonts/radius/mode) · Versions (last 20 with revert)
- **Autosave**: every ~1.2s to `draft`
- **Publish**: snapshots current `published` into `versions[]` and moves `draft` → `published`
- **Undo/redo**: local edit stack (up to 50 steps) within a single session

## Theme
CSS custom properties applied to `:root` at page load. Changing theme in editor triggers `applyTheme()` for live preview. Publishing theme snapshots the previous version to `cms_theme.versions[]`.
