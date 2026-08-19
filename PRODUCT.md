# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary: the ticket buyer, on a phone.** A Bucharest gig-goer deciding whether to
attend and buying in a few taps — usually mobile, often close to the event. When roles
conflict, the public surfaces (event pages, box office, shop) win over internal tooling.

Three other confirmed roles exist in the system, each a real person with a different job:

- **door** — scans QR tickets at the entrance on a phone.
- **editor** — publishes and edits CMS pages, events, and gallery content.
- **admin** — the above plus orders, stock, users, and theme.

**A fifth audience is intended but not yet served: the whitelabel operator.** Another
collective or venue that buys the platform and runs it under its own name and look. This
audience does not shape the current build's priorities, but it forbids designing them out
— see Positioning and Brand Commitments.

## Product Purpose

Supersanity is the ticketing and storefront platform for a Bucharest music and
performance collective. It runs the collective's public site, its CMS, the box office
(reserve → Stripe checkout → QR ticket → scan at the door), a merchandise webshop, and a
self-owned, GDPR/CAN-SPAM-aware user-management stack.

Success is a gig-goer going from "should I go?" to a ticket in hand without leaving the
collective's own site, and that ticket being honored at the door in one scan.

**The longer intent is to sell the same platform whitelabel** to other collectives and
venues, each running it under their own identity. Supersanity is the first tenant, not
the only one the product is built to serve.

## Positioning

**No platform fees, and the money lands immediately.** Payments go through Stripe on the
collective's own account — verified in the code as a direct integration, with no Connect
account, no `application_fee`, and no marketplace split — so takings settle into the
collective's own Stripe balance on their own payout schedule.

This is the claim a hosted competitor cannot truthfully copy: Eventbrite, DICE and
similar take a per-ticket cut and hold funds, typically until after the event has
happened. Here there is no intermediary between the collective and its takings.

That same property is what makes the platform sellable whitelabel: a buyer gets a
box office they own outright, on their own Stripe account, under their own brand — not a
storefront on someone else's marketplace.

## Operating Context

- **Buying happens on a phone**, frequently near the event date.
- **The door is a live, timed environment.** Staff scan QR codes on a phone at the
  entrance while people wait. Camera access on iOS was a specific, hard-won fix.
- **Tickets are held, not instantly sold.** The box office issues a time-boxed hold
  (10 minutes) before checkout, so inventory is contended and time-sensitive.
- **The collective re-themes the site itself.** Colors, fonts and spacing are published
  from the CMS at runtime, without a developer or a deploy. This mechanism is also the
  whitelabel mechanism — the same contract that lets Supersanity restyle per season is
  what lets a different collective look like themselves.
- **Prices are in RON.** All copy is English — see Capabilities.
- **Two deployment shapes are live documents**: one Vercel project with two services,
  and a single VPS running nginx + uvicorn + MongoDB.

## Capabilities and Constraints

Confirmed functionality: events with ticket tiers and live availability; discount codes;
time-boxed reservation holds; Stripe checkout; QR tickets; door scanning; a merch shop
with variants, stock and sold-out states; cart; orders; "my tickets"; a newsletter with
confirm/unsubscribe; accounts (sign-in, email verification, password reset, profile
completion); role-gated admin and CMS; CMS-managed pages, navigation, gallery/albums,
theme and uploaded fonts.

Durable constraints:

- **English only, deliberately.** Confirmed by the user. Copy is not to be translated,
  and no i18n layer should be introduced on the assumption that it will be.
- **Structure is fixed; the skin is not.** The brutalist structural rules are permanent
  product identity — zero border radius, hard 1px borders, exposed grid, uppercase
  editorial type, no gradients, no soft shadows, abrupt mechanical motion, left-aligned
  reading flow. Palette, fonts and spacing values are themeable and must stay so. A
  design that hard-codes a color or typeface the theme is supposed to control removes
  both a shipped feature and the whitelabel story.
- **Any design must be expressible through the CMS theme contract.** `applyTheme()`
  writes a fixed set of CSS custom properties onto `:root` at runtime. If a design needs
  a value the contract does not carry, the contract is extended — the value is not
  hard-coded around it.
- **Whitelabel means one deployment per customer.** Each collective gets its own
  deployment, database, Stripe account and CMS theme. There is no multi-tenancy in the
  code and none is planned, so the single-worker and direct-Stripe constraints below hold
  per instance rather than being blockers.
- **The backend runs a single worker on purpose.** The rate limiter holds its buckets in
  process memory, so additional workers or replicas multiply the real limit. Horizontal
  scaling requires moving the limiter to shared state first.
- **Uploaded media is either local disk or Vercel Blob**, selected by whether
  `BLOB_READ_WRITE_TOKEN` is set. Ephemeral filesystems lose local uploads.
- **MongoDB is a replica set**, not a standalone server, because transactions depend on
  it.
- **A refund is recorded, not executed.** `admin_refund` marks the reservation and its
  tickets refunded and returns still-sellable stock to the wave, but never calls Stripe's
  refund API — the Stripe SDK is used only for customers, checkout sessions and webhook
  verification. The money is moved by hand in the Stripe dashboard, so "refunded" in this
  system means "we owe them" until someone does that.
- **Invoices are the platform's own.** Sequential VAT PDFs are generated in-process with
  reportlab. There is no integration with a Romanian e-invoicing provider (SmartBill,
  Oblio, e-Factura), so the numbers are issued by this system rather than by one.
- **Containerization and CI/CD are agreed, not built.** The decision to do both has been
  made; no Dockerfile or workflow exists yet, and `.github/` still contains only
  Dependabot config. Per-customer deployment is the reason it matters — repeatable
  provisioning is what makes whitelabel practical.

## Brand Commitments

- The product and collective are named **Supersanity**; the site titles itself
  "Supersanity | Artist Collective". This is the first tenant's identity, not the
  platform's only possible one.
- It represents a real Bucharest music and performance collective. Programming, artists,
  box office and merch are facets of one organization, not separate products.
- **`design_guidelines.json` at the repo root is binding.** It is the incumbent visual
  authority: Boiler Room / Berghain / RA.co reference points, brutalist dark mode,
  anti-polish, editorial arts brand. Emotional register is exclusive, raw, underground,
  disciplined, mysterious, confident. Its structural rules are permanent (see
  Capabilities); its palette (`#050505` base, `#FF3333` accent, `#E1FF00` success) and
  typefaces (Clash Display headings, Manrope body, IBM Plex Mono data/meta) ship as the
  default theme rather than as hard-coded values.
- **The three typefaces are vendored, not fetched.** Clash Display, Manrope and IBM Plex
  Mono are self-hosted in the repo and Fontshare was deliberately removed from the CSP.
  `design_guidelines.json` still says to import them from Google Fonts or Fontshare; the
  repo is correct and that line is stale.
- **Re-theming is a brand commitment, not a preference.** The collective can restyle the
  site per season or event through the CMS, and a whitelabel buyer can restyle it
  entirely. Work that removes that capability breaks a promise the product already makes.

## Evidence on Hand

- **`SECURITY_AUDIT.md`** — a genuine security audit with one critical, three high and
  twelve medium findings, all closed, plus later findings also closed. Reproduction
  detail included. This is real, citable evidence of the platform's security posture.
- **`backend/tests/test_deploy_config.py`** — deployment invariants asserted rather than
  described, including the security headers and the SPA fallback across serving targets.
- **`design_guidelines.json`** — the binding visual record described above. Note that it
  also carries implementation directives aimed at a coding agent (plain JS over TSX,
  `data-testid` on every interactive element, named component libraries). Those are
  conventions to check against the repo, not product truth.
- **Seeded working data** in development: ~50 shop products with categories, variants and
  stock states; events with ticket tiers, availability and discount codes.
- **`design-prototype/`** — a separate Supabase/TypeScript prototype ("Nocturne
  Assembly") kept only as a design source; scheduled for deletion once harvested.

Absences future work must not fabricate: there are **no** testimonials, customer logos,
press mentions, attendance figures, revenue numbers, or third-party endorsements anywhere
in this project. Ticket and merch prices exist only as seeded development data and are not
a published price list. **No whitelabel customer exists yet** — the platform has one
tenant, and no second collective may be named, counted, or implied.

## Product Principles

1. **The phone is the venue for buying.** The decision-to-ticket path is the product's
   spine; everything else is support.
2. **The door must never become the bottleneck.** Scanning is a first-class product
   surface, not an admin afterthought — it runs under time pressure, in the dark, on
   someone else's hardware.
3. **Nothing sits between the collective and its own money or audience.** No fee-taking
   intermediary, no third-party account system, no held funds.
4. **The house restyles; the architecture does not.** Any collective must be able to
   change the paint from the CMS without a developer. The structure underneath stays
   brutalist and stays put.
5. **Security posture is a feature that has been paid for.** Findings were closed and
   invariants asserted in tests; a regression is a defect, not a tradeoff.

## Accessibility & Inclusion

No formal conformance target has been adopted for the product as a whole. What is
required comes from the real usage scene and from the binding design record:

- **The door scanner must work one-handed, in the dark, in a hurry, on hardware that
  isn't ours.** Massive touch targets, viewport-locked layout, and state recognisable at
  a glance — valid versus invalid readable without reading.
- **Contrast is not decorative.** `design_guidelines.json` requires all text to meet
  WCAG AA at minimum, and its brutalist high-contrast rule is the mechanism. Text lost
  against a dark background is a defect.
- **Themeability must not be able to break either of the above.** A CMS theme or
  whitelabel palette that drops text below AA is the theme contract failing, not the
  operator's mistake.

Open: the frontend currently has no `prefers-reduced-motion` handling anywhere, while the
motion philosophy is deliberately abrupt and mechanical. No decision has been recorded on
how to reconcile those.
