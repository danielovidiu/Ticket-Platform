-- Seed data for "Nocturne Assembly", a fictional music & performance collective.
-- Safe to re-run: every insert uses a fixed id + ON CONFLICT DO NOTHING.
-- Images are deterministic picsum.photos placeholders — swap for real media
-- once the admin dashboard slice can upload into the `media` storage bucket.

-- ---------------------------------------------------------------------------
-- Artists
-- ---------------------------------------------------------------------------
insert into public.artists (id, slug, name, photo_url, bio, role, genre, links, is_featured, is_published)
values
  (
    'a1111111-1111-1111-1111-111111111111',
    'ana-marinescu',
    'Ana Marinescu',
    'https://picsum.photos/seed/ana-marinescu/800/1000',
    'Ana Marinescu is a vocalist and composer working at the edge of jazz and electroacoustic improvisation. Her performances layer processed voice with field recordings gathered across Romania.',
    'Vocalist / Composer',
    'Experimental Jazz',
    '[{"label":"Spotify","url":"https://open.spotify.com/artist/example-ana"},{"label":"Instagram","url":"https://instagram.com/example.ana"}]'::jsonb,
    true,
    true
  ),
  (
    'a2222222-2222-2222-2222-222222222222',
    'radu-ionescu',
    'Radu Ionescu',
    'https://picsum.photos/seed/radu-ionescu/800/1000',
    'Radu Ionescu is a percussionist and live-electronics performer. He builds rhythm sets from modified found objects and modular synthesis, often performed entirely improvised.',
    'Percussion / Live Electronics',
    'Electronic',
    '[{"label":"SoundCloud","url":"https://soundcloud.com/example-radu"},{"label":"Instagram","url":"https://instagram.com/example.radu"}]'::jsonb,
    true,
    true
  ),
  (
    'a3333333-3333-3333-3333-333333333333',
    'collectiv-lumen',
    'Collectiv Lumen',
    'https://picsum.photos/seed/collectiv-lumen/800/1000',
    'Collectiv Lumen is an audiovisual ensemble pairing generative light installations with live modular performance, staged in disused industrial spaces across Romania.',
    'Audiovisual Ensemble',
    'Audiovisual / Installation',
    '[{"label":"Website","url":"https://example.com/collectiv-lumen"},{"label":"Instagram","url":"https://instagram.com/example.lumen"}]'::jsonb,
    false,
    true
  )
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Projects (past)
-- ---------------------------------------------------------------------------
insert into public.projects
  (id, slug, title, event_date, event_end_date, venue_name, venue_address, cover_image_url, description, is_published)
values
  (
    'p1111111-1111-1111-1111-111111111111',
    'nocturne-no-1-halide',
    'Nocturne No. 1: Halide',
    '2025-03-14 20:00:00+02',
    '2025-03-15 01:00:00+02',
    'Fabrica de Pensule',
    'Str. Henri Barbusse 59-61, Cluj-Napoca',
    'https://picsum.photos/seed/nocturne-halide/1600/900',
    'The collective''s inaugural performance: a single continuous set blending voice, percussion, and light across a disused paintbrush factory floor.',
    true
  ),
  (
    'p2222222-2222-2222-2222-222222222222',
    'static-chapel',
    'Static Chapel',
    '2025-09-20 19:30:00+03',
    '2025-09-20 23:30:00+03',
    'Halele Timco',
    'Str. Take Ionescu 46, Timișoara',
    'https://picsum.photos/seed/static-chapel/1600/900',
    'A night of long-form drone and processed choir, staged inside a former locomotive repair hall.',
    true
  )
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Projects (upcoming)
-- ---------------------------------------------------------------------------
insert into public.projects
  (id, slug, title, event_date, event_end_date, venue_name, venue_address, cover_image_url, description, is_published)
values
  (
    'p3333333-3333-3333-3333-333333333333',
    'nocturne-no-2-ember-choir',
    'Nocturne No. 2: Ember Choir',
    '2026-10-03 19:00:00+03',
    '2026-10-04 00:00:00+03',
    'Arcub',
    'Str. Lipscani 84-90, București',
    'https://picsum.photos/seed/ember-choir/1600/900',
    'The second Nocturne gathering brings the full collective together for a new work built around layered vocal loops and live percussion.',
    true
  ),
  (
    'p4444444-4444-4444-4444-444444444444',
    'winter-static',
    'Winter Static',
    '2026-12-12 20:00:00+02',
    '2026-12-13 01:00:00+02',
    'Expirat',
    'Str. Gazometrului 8, București',
    'https://picsum.photos/seed/winter-static/1600/900',
    'A midwinter edition of Static Chapel, reimagined for Expirat''s industrial main hall with an expanded lighting rig from Collectiv Lumen.',
    true
  )
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Lineups
-- ---------------------------------------------------------------------------
insert into public.project_artists (project_id, artist_id, billing_order)
values
  ('p1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', 0),
  ('p1111111-1111-1111-1111-111111111111', 'a2222222-2222-2222-2222-222222222222', 1),
  ('p2222222-2222-2222-2222-222222222222', 'a1111111-1111-1111-1111-111111111111', 0),
  ('p2222222-2222-2222-2222-222222222222', 'a3333333-3333-3333-3333-333333333333', 1),
  ('p3333333-3333-3333-3333-333333333333', 'a1111111-1111-1111-1111-111111111111', 0),
  ('p3333333-3333-3333-3333-333333333333', 'a2222222-2222-2222-2222-222222222222', 1),
  ('p3333333-3333-3333-3333-333333333333', 'a3333333-3333-3333-3333-333333333333', 2),
  ('p4444444-4444-4444-4444-444444444444', 'a2222222-2222-2222-2222-222222222222', 0),
  ('p4444444-4444-4444-4444-444444444444', 'a3333333-3333-3333-3333-333333333333', 1)
on conflict (project_id, artist_id) do nothing;

-- ---------------------------------------------------------------------------
-- Ticket types / waves (read-only display this slice; checkout not built yet)
-- ---------------------------------------------------------------------------
insert into public.ticket_types
  (id, project_id, name, price_cents, currency, wave_order, quantity_total, quantity_sold, sales_start_at, sales_end_at, is_active)
values
  (
    't1111111-1111-1111-1111-111111111111', 'p3333333-3333-3333-3333-333333333333',
    'Early Bird', 9000, 'RON', 0, 100, 100,
    '2026-06-01 10:00:00+03', '2026-07-01 23:59:00+03', true
  ),
  (
    't1111111-1111-1111-1111-111111111112', 'p3333333-3333-3333-3333-333333333333',
    'General', 12000, 'RON', 1, 300, 42,
    '2026-07-02 10:00:00+03', '2026-10-02 23:59:00+03', true
  ),
  (
    't1111111-1111-1111-1111-111111111113', 'p3333333-3333-3333-3333-333333333333',
    'Door', 15000, 'RON', 2, null, 0,
    '2026-10-03 12:00:00+03', '2026-10-03 22:00:00+03', true
  ),
  (
    't2222222-2222-2222-2222-222222222221', 'p4444444-4444-4444-4444-444444444444',
    'Early Bird', 8000, 'RON', 0, 80, 80,
    '2026-09-01 10:00:00+03', '2026-10-15 23:59:00+03', true
  ),
  (
    't2222222-2222-2222-2222-222222222222', 'p4444444-4444-4444-4444-444444444444',
    'General', 11000, 'RON', 1, 250, 12,
    '2026-10-16 10:00:00+02', '2026-12-11 23:59:00+02', true
  )
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Gallery items
-- ---------------------------------------------------------------------------
insert into public.gallery_items
  (id, project_id, artist_id, media_type, media_url, thumbnail_url, caption, tags, is_published, sort_order)
values
  (
    'g1111111-1111-1111-1111-111111111111',
    'p1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111',
    'image', 'https://picsum.photos/seed/halide-live-1/1200/1200', 'https://picsum.photos/seed/halide-live-1/400/400',
    'Ana Marinescu on stage at Halide', array['live'], true, 0
  ),
  (
    'g2222222-2222-2222-2222-222222222222',
    'p1111111-1111-1111-1111-111111111111', 'a2222222-2222-2222-2222-222222222222',
    'image', 'https://picsum.photos/seed/halide-live-2/1200/1200', 'https://picsum.photos/seed/halide-live-2/400/400',
    'Radu Ionescu''s percussion rig', array['live','backstage'], true, 1
  ),
  (
    'g3333333-3333-3333-3333-333333333333',
    'p1111111-1111-1111-1111-111111111111', null,
    'image', 'https://picsum.photos/seed/halide-venue/1200/1200', 'https://picsum.photos/seed/halide-venue/400/400',
    'Fabrica de Pensule, before doors', array['installation'], true, 2
  ),
  (
    'g4444444-4444-4444-4444-444444444444',
    'p2222222-2222-2222-2222-222222222222', 'a3333333-3333-3333-3333-333333333333',
    'image', 'https://picsum.photos/seed/static-chapel-1/1200/1200', 'https://picsum.photos/seed/static-chapel-1/400/400',
    'Collectiv Lumen''s light rig at Static Chapel', array['live','installation'], true, 0
  ),
  (
    'g5555555-5555-5555-5555-555555555555',
    'p2222222-2222-2222-2222-222222222222', 'a1111111-1111-1111-1111-111111111111',
    'video', 'https://picsum.photos/seed/static-chapel-video/1200/1200', 'https://picsum.photos/seed/static-chapel-2/400/400',
    'Closing minutes of Static Chapel', array['live'], true, 1
  ),
  (
    'g6666666-6666-6666-6666-666666666666',
    'p2222222-2222-2222-2222-222222222222', null,
    'image', 'https://picsum.photos/seed/static-chapel-3/1200/1200', 'https://picsum.photos/seed/static-chapel-3/400/400',
    'Halele Timco backstage', array['backstage'], true, 2
  ),
  (
    'g7777777-7777-7777-7777-777777777777',
    'p3333333-3333-3333-3333-333333333333', null,
    'image', 'https://picsum.photos/seed/ember-choir-teaser/1200/1200', 'https://picsum.photos/seed/ember-choir-teaser/400/400',
    'Rehearsal for Ember Choir', array['backstage'], true, 0
  ),
  (
    'g8888888-8888-8888-8888-888888888888',
    null, 'a3333333-3333-3333-3333-333333333333',
    'image', 'https://picsum.photos/seed/lumen-studio/1200/1200', 'https://picsum.photos/seed/lumen-studio/400/400',
    'Collectiv Lumen in the studio', array['installation'], true, 0
  )
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Content pages (Mission + legal). TEMPORARY placeholder copy — must be
-- reviewed by qualified legal counsel before launch; this is not legal advice.
-- ---------------------------------------------------------------------------
insert into public.content_pages (slug, title, excerpt, body, is_published)
values
  (
    'mission',
    'Our Mission',
    'Nocturne Assembly stages music and performance in spaces that were never built for it — and shares what we learn along the way.',
    E'## What we do\n\nNocturne Assembly is a music & performance collective based in Romania. We stage one-night gatherings in disused industrial buildings, pairing live music with light and space.\n\n## Our values\n\n- **Site-specific work.** Every performance responds to the building that hosts it.\n- **Collaboration over spectacle.** Artists share billing and process, not a single headliner.\n- **Access.** We keep ticket prices as low as the venue and production costs allow.\n\n*This is placeholder mission copy for the initial build — replace with the collective''s own voice before launch.*',
    true
  ),
  (
    'privacy-policy',
    'Privacy Policy',
    'How we collect, use, and protect your personal data.',
    E'_TEMPORARY placeholder legal copy — must be reviewed by qualified legal counsel before launch. Not legal advice._\n\n## Data we collect\n\nWhen you create an account or buy a ticket, we collect your name, email address, and phone number. Payment details are processed directly by Stripe and are never stored on our servers.\n\n## Your rights\n\nUnder GDPR, you can request a copy of your data or ask us to delete your account at any time from your profile settings.\n\n## Contact\n\nQuestions about this policy can be sent to booking@nocturneassembly.example.',
    true
  ),
  (
    'terms-of-sale',
    'Terms of Sale',
    'Ticket sale terms, entry conditions, and our refund policy.',
    E'_TEMPORARY placeholder legal copy — must be reviewed by qualified legal counsel before launch. Not legal advice._\n\n## Sales\n\nAll ticket prices are shown in Romanian Lei (RON) and include the service fee. All sales are final — we do not offer self-serve refunds.\n\n## Cancellations\n\nIf an event is cancelled by the organizer, all ticket holders will be refunded in full and notified by email.\n\n## Entry\n\nEach ticket is a unique QR code. The first valid scan admits the holder; duplicate scans are rejected at the door.',
    true
  ),
  (
    'cookie-policy',
    'Cookie Policy',
    'What cookies we use and how to control them.',
    E'_TEMPORARY placeholder legal copy — must be reviewed by qualified legal counsel before launch. Not legal advice._\n\n## Essential cookies\n\nWe use a small number of essential cookies to keep you signed in and to remember your cookie preferences.\n\n## Analytics cookies\n\nWe use Google Analytics to understand how visitors use this site, but only after you accept analytics cookies via the banner. You can withdraw consent at any time by clearing your browser''s local storage for this site.',
    true
  )
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------------
-- FAQ
-- ---------------------------------------------------------------------------
insert into public.faq_items (id, question, answer, sort_order, is_published)
values
  ('f1111111-1111-1111-1111-111111111111', 'Is online ticketing available yet?', 'Not yet — online ticket sales are launching soon. In the meantime, ticket tiers and pricing are shown on each event page.', 0, true),
  ('f2222222-2222-2222-2222-222222222222', 'Is there an age restriction?', 'Most Nocturne Assembly events are 18+. Specific age policies, if different, are listed on the event page.', 1, true),
  ('f3333333-3333-3333-3333-333333333333', 'Are the venues accessible?', 'Accessibility varies by venue since many are repurposed industrial spaces. Contact us before the event if you have specific accessibility needs.', 2, true),
  ('f4444444-4444-4444-4444-444444444444', 'What is your refund policy?', 'All ticket sales are final. If an event is cancelled by the organizer, all ticket holders are refunded automatically and notified by email.', 3, true),
  ('f5555555-5555-5555-5555-555555555555', 'Can I transfer my ticket to someone else?', 'Tickets are not officially transferable, but each QR code is only checked for validity at the door on a first-scan basis — we don''t check ID.', 4, true),
  ('f6666666-6666-6666-6666-666666666666', 'How can I get in touch?', 'Use the contact form on this site, or email us directly at booking@nocturneassembly.example.', 5, true)
on conflict (id) do nothing;
