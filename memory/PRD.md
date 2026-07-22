# Supersanity — PRD

## Original problem statement
Website + ticketing platform for a music/performance collective. Public site: home, mission, archive, events, gallery, artists, contact. Ticketing engine with Google OAuth, staged sale waves, discount codes, invite-only special links, 10-min reserve-then-confirm hold, RON via Stripe, QR tickets in "My Tickets", door scanner (first-scan-wins, offline-capable), auto Romanian VAT invoices, admin dashboard, door-staff role.

## Architecture
- Backend: FastAPI + MongoDB (motor). First-party auth: email/password (bcrypt) + direct Google/Apple OAuth, email verification, password reset. Stripe SDK (env-gated, with a local fake-payments mode) for checkout & signature-verified webhooks. reportlab for PDF invoices. qrcode for PNG generation. Session cookies (httpOnly) + Bearer fallback.
- Frontend: React 19 + React Router 7 + Tailwind. Shadcn base + custom brutalist dark styling (Clash Display / IBM Plex Mono / Manrope). qrcode.react for ticket QRs. Native BarcodeDetector API + camera for door scanner; localStorage offline queue.

## User personas
1. Fan – buys tickets, views My Tickets, downloads invoice PDF.
2. Admin – manages artists/projects/events/waves/discounts/invites/orders/refunds/users/gallery, reads sales stats.
3. Door staff – only /scan, first-scan-wins QR validation.

## Core requirements (static)
- Email/password + Google/Apple OAuth. First user auto-promoted to admin. Roles: user/editor/admin/door.
- RON pricing via Stripe (real key gates live mode; fake mode for local dev), reservations hold stock for 10 min, released on expiry.
- Wave tiers (early_bird/general/vip), % discount codes w/ expiry & max uses, invite-only special-price links.
- Max tickets per user enforced at reservation time.
- QR codes are unique per ticket; scan is first-write-wins (Mongo atomic update).
- Auto sequential VAT invoice on paid reservation (19% RO VAT, PDF).
- All sales final unless event cancelled (admin action refunds tickets + reservations).

## What's implemented — 2026-02
- Full public site (Home, Events list + detail, Artists list + detail, Archive, Gallery, Mission, Contact)
- Google OAuth flow, /auth/me, cookie sessions
- Reserve → Stripe checkout → status poll → ticket + invoice generation
- My Tickets + PDF invoice download
- Door scanner PWA-ish page (camera or manual entry, offline queue)
- Admin dashboard: stats, events CRUD w/ waves editor, orders + refunds, artists/projects/discounts/invites/users/gallery
- Seed endpoint `/api/seed` for demo data
- All UI on brutalist dark editorial theme, `data-testid` on interactive elements

## Prioritized backlog
- P1: Real email delivery of QR + invoice (Resend), Apple/Google Wallet passes, Facebook/Apple sign-in.
- P1: Stripe live keys switch + refund via Stripe API (currently marks refunded in DB only).
- P2: Multi-language (RO/EN), SEO metadata per event, analytics.
- P2: Romanian e-invoicing integration (SmartBill/Oblio) for legal invoice numbers.
- P2: Seat maps, waitlist, resale.
