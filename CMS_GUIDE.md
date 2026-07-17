# CMS Guide — Umbra Collective

## What you get
- **/cms** — full visual editor (admin or editor role required)
- **/p/:slug** — public dynamic pages rendered from CMS data
- **/** — now renders the CMS "home" page
- **/mission** — now renders the CMS "mission" page
- **/contact** — now renders the CMS "contact" page
- Events, Artists, Archive, Gallery, ticketing flows are unchanged (per user choice 1a — auto-generated from the ticketing data)

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
