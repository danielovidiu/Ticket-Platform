# CMS Guide — Supersanity

Every block, every control, and the dimensions each one actually produces.

Numbers here are read from the code, not from memory. Where a value is a percentage of
the screen it is given as `vh`/`vw` with a worked example, because the pixel answer
depends on the visitor's window.

---

## Contents

- [The width system](#the-width-system) — the one thing that explains most blocks
- [Hero](#hero) · [Background (page)](#background-page) · [Image band](#image-band)
- [Text panel](#text-panel-scrolling) · [Rich text](#rich-text) · [Image](#image) · [Split](#split-image--text)
- [Events grid](#events-grid) · [Artists grid](#artists-grid) · [Gallery grid](#gallery-grid)
- [Video / audio](#video--audio-embed) · [Marquee](#marquee) · [CTA banner](#cta-banner)
- [Contact form](#contact-form) · [Newsletter](#newsletter) · [Custom HTML](#custom-html) · [Spacer](#spacer)
- [Pages, slugs, roles](#pages-slugs-and-roles) · [Theme and fonts](#theme-and-fonts)
- [Upload limits](#upload-limits) — how large a file may be, and why it varies
- [Text and the screen edge](#text-and-the-screen-edge) — why photos bleed and words do not

---

## The width system

Almost every block shares one width model, so learning it once explains the rest.

| Mode | Max width | Side gutters | Used by |
|---|---|---|---|
| **Framed** (default) | 1400 px, centred | 24 px under 768 px, 40 px at or above | most blocks |
| **Narrow** | 900 px, centred | same | Rich text, Contact form, Newsletter |
| **Full width** | none — spans the window | **none** | any block with the toggle on |

The breakpoint throughout is **768 px** (`md`). Below it the layout is one column and the
gutters are 24 px; at or above, 40 px.

> **Full width removes the gutters too.** "Edge to edge" means edge to edge: a text block
> set full width puts its prose against the side of the screen. That is why framed is the
> default, and it is the editor's call to change it.

**Two blocks bleed by default** and are capped by switching the toggle *off*: **Marquee**
(a ticker runs off both sides by nature) and **Background (page)** (a backdrop covers the
page). Every other block is framed until you say otherwise.

**Spacer has no width control**, because it has no content to frame — it is an empty box
with a height, so framed and full width would render identically.

---

## Hero

The full-bleed opening block: background photo, overlay, heading, body, two buttons.

### Dimensions

**Height** is a *minimum*, set as a percentage of the visitor's window:

| | Value |
|---|---|
| Control | `Height (% of screen)` — slider |
| Range | **10 – 100 %** of window height |
| Default | **85 %** |
| Legacy names | `short` = 50 %, `medium` = 70 %, `tall` = 85 % |

In pixels, on three common window heights:

| Window height | Minimum (10 %) | Default (85 %) | Maximum (100 %) |
|---|---|---|---|
| 800 px | 80 px | 680 px | 800 px |
| 900 px | 90 px | 765 px | 900 px |
| 1080 px | 108 px | 918 px | 1080 px |

It is a **min-height**, so a hero holding more text than fits will grow past it. It never
shrinks below it.

**Width** — and this is the part that surprises people:

| Full frame | The block / background | The text and buttons |
|---|---|---|
| **On** (default) | spans the window, edge to edge | still capped at **1400 px** with gutters |
| **Off** | capped at **1400 px**, centred, with a hairline border | same — capped at 1400 px with gutters |

**Full frame moves the photograph, not the words.** The text stays inside the same
1400 px measure either way, so a heading is never 2 000 px wide on a large monitor. If
the words look too narrow, the control you want is the heading size, not full frame.

*Measured on the live site at a 1440 × 900 window with height 91 %: block 1432 × 819 px
(1432 not 1440 because of the scrollbar), text frame 1400 px wide with 40 px gutters.*

### Controls

| Control | Type | Range / options | Default |
|---|---|---|---|
| Eyebrow | text | — | — |
| Heading | multi-line text | — | — |
| Body | multi-line text | markdown-ish | — |
| Background image | upload | — | — |
| Full frame (edge to edge) | toggle | — | **on** |
| Overlay | select | `gradient` · `solid` · `none` | `gradient` |
| Overlay colour | colour | — | `#050505` |
| Overlay opacity | slider | 0 – 100 % | 45 % |
| Heading size — desktop | slider | **16 – 240 px** | 72 px |
| Heading size — mobile | slider | **16 – 120 px** | 48 px |
| Text case | select | `as-typed` · `uppercase` | `uppercase` |
| Primary CTA label / link / style | text, text, select (`accent` · `outline`) | — | — |
| Secondary CTA label / link | text | — | — |
| Text align (horizontal) | select | `left` · `center` · `right` | `left` |
| Text position — down from the top | slider | **0 – 100 %** | 100 % (bottom) |
| Height (% of screen) | slider | 10 – 100 | 85 |

**Text position** moves the whole group — eyebrow, heading, body and both buttons — as a
proportion of the block's height. 0 % is flush with the top, 50 % centred, 100 % flush
with the bottom. The old `top` / `middle` / `bottom` steps map to 0 / 50 / 100, so
anything published before the slider sits exactly where it did.

**Overlay** has three modes. `gradient` is the original treatment (a theme-wide image
fade plus a bottom gradient) and is what a hero with no overlay setting uses. `solid`
gives you the colour and opacity controls. `none` shows the photograph untouched.

---

## Background (page)

A photograph behind **everything else on the page**. Add it once; every other block lands
on top of it, transparently.

### Dimensions

- **Pinned to the window**, full height (`100vh`), and it stays put as the page scrolls.
- Takes **no vertical space** — it does not push the blocks below it down.
- **Full frame on** (default): spans the window. **Off**: capped at 1400 px, centred.
- It never intercepts clicks, and screen readers skip it.

### Controls

| Control | Type | Range | Default |
|---|---|---|---|
| Photo | upload | — | — |
| Overlay colour | colour | — | `#050505` |
| Overlay opacity | slider | 0 – 100 % | 40 % |
| Full frame (edge to edge) | toggle | — | **on** |

The overlay is drawn even with no photo, so a flat colour is a legitimate backdrop.

> **Only the first one on a page is used.** A second would stack invisibly under the first.
>
> **In the editor it shows as a labelled band, not as the real backdrop.** The preview
> draws one block per row, so the true pinned layer would cover the blocks after it
> instead of sitting under them. Use **View live** to see the composite.

---

## Image band

A strip of photograph with text over it. Shorter than a hero, meant to sit mid-page.

### Dimensions

| Height | Value | At a 900 px window |
|---|---|---|
| `short` | 30 % of window height | 270 px |
| `medium` (default) | 45 % | 405 px |
| `tall` | 60 % | 540 px |

Also minimums — more text makes the band taller.

The **text runs the full width of the safe area** (the frame minus its gutters), rather
than stopping partway across the photograph.

**Fixed background** makes the photo drift as the page scrolls. It is a real image, not a
CSS fixed background, so it works on phones and — importantly — it is **never scaled up**:
it drifts only as far as its own spare height allows, and a photo with no spare height
sits still rather than being enlarged to create some.

### Controls

| Control | Type | Options | Default |
|---|---|---|---|
| Background image | upload | — | — |
| Fixed background | toggle | — | off |
| Overlay colour / opacity | colour, slider 0–100 | — | `#050505`, 50 % |
| Eyebrow · Heading · Body | text, multi-line, multi-line | — | — |
| Button label / link / style | text, text, select (`outline` · `accent`) | — | `outline` |
| Text case | select | `as-typed` · `uppercase` | `as-typed` |
| Text align (horizontal) | select | `left` · `center` · `right` | `left` |
| Text position (vertical) | select | `top` · `middle` · `bottom` | `middle` |
| Height | select | `short` · `medium` · `tall` | `medium` |
| Full width | toggle | — | **on** |

---

## Text panel (scrolling)

A box of text with its own scrollbar, for long copy that should not stretch the page.

| Control | Type | Range / options | Default |
|---|---|---|---|
| Heading | text | — | — |
| Content | multi-line | markdown-ish | — |
| Panel height (px) | slider | **80 – 1200 px** | **320 px** |
| Width | select | `narrow` **640 px** · `normal` **900 px** · `wide` **1200 px** | `normal` |
| Panel position | select | `left` · `center` · `right` | `center` |
| Text align | select | `left` · `center` · `right` | `left` |
| Full width | toggle | — | off |

Panel height is fixed — content longer than it scrolls inside the box. **Width** is the
panel's own measure; **Panel position** is where that panel sits in the row.

The panel draws **no border** and its text is set in exactly the same type as
[Rich text](#rich-text) — same size, colour and line spacing. The two blocks hold the same
kind of prose, so a reader should not be able to tell which one they are in. The only
difference is the measure: Rich text is fixed at a comfortable reading width, while this
block's line length is yours to set with **Width**.

---

## Rich text

Prose. Framed to the **narrow 900 px** measure rather than 1400 px, because a line of
text that wide is one the eye loses its place in.

| Control | Type | Default |
|---|---|---|
| Content (markdown-ish) | multi-line | — |
| Full width | toggle | off |

---

## Image

| Control | Type | Options | Default |
|---|---|---|---|
| Image | upload | — | — |
| Caption | text | — | — |
| Full width | toggle | — | off |
| Aspect ratio | select | `natural` · `1:1` · `4:3` · `3:4` · `16:9` · `21:9` · `3:2` · `16:10` | `natural` |

`natural` keeps the file's own proportions. Any other value crops to that shape.

---

## Split (image + text)

Two columns at 768 px and above; stacked below it.

| Control | Type | Options | Default |
|---|---|---|---|
| Direction | select | `image-left` · `image-right` | `image-left` |
| Image | upload | — | — |
| Image aspect | select | `1:1` · `4:3` · `3:4` · `16:9` · `16:10` · `3:2` | `1:1` |
| Eyebrow · Heading · Body | text, text, multi-line | — | — |
| CTA label / link | text | — | — |
| Full width | toggle | — | off |

---

## Events grid

Upcoming events, newest first, pulled live from ticketing.

| Control | Type | Options | Default |
|---|---|---|---|
| Eyebrow · Heading | text | — | — |
| Max events | number | — | 4 |
| Layout | select | `grid-1` (one column) · `grid-2` · `grid-3` | `grid-2` |
| Card aspect | select | `1:1` · `4:3` · `16:9` · `16:10` · `3:2` · `3:4` | see below |
| Full width | toggle | — | off |

> **Card aspect is now the event's own property.** Each event carries an *Image format*
> chosen in the admin, and the card uses that so a photograph is not cropped one way here
> and another on the event's own page. An event that has never been given a format falls
> back to **16:10** on a card and **4:3** on its page — open and save the event to pick
> one and make them agree.

Always one column below 768 px, whatever the layout says.

---

## Artists grid

| Control | Type | Options | Default |
|---|---|---|---|
| Eyebrow · Heading | text | — | — |
| Max artists | number | — | 6 |
| Layout | select | `grid-2` · `grid-3` · `grid-4` | `grid-3` |
| Card aspect | select | `1:1` · `4:3` · `3:4` · `16:10` | `1:1` |
| Full width | toggle | — | off |

**Two columns on a phone**, not one — artist tiles are portraits and read fine at that
size.

---

## Gallery grid

Recent gallery media as a masonry wall: **one column below 768 px, three above**. Images
keep their own proportions, which is what makes the wall interlock.

| Control | Type | Default |
|---|---|---|
| Heading | text | — |
| Max items | number | 6 |
| Full width | toggle | off |

---

## Video / audio embed

Two sources in one block. Paste a **URL** (YouTube, Vimeo, SoundCloud, Bandcamp) or
**upload a file** (MP4 / WebM / MOV). When both are set, the uploaded file wins.

### Dimensions

**Video** uses an aspect ratio — default **16:9**.

**Audio** uses a fixed height instead, because a player is a bar and not a rectangle:

| Provider | Single track | Playlist |
|---|---|---|
| SoundCloud | 166 px | 400 px |
| Bandcamp | 470 px | 470 px |

*Player height (px)* overrides both, clamped to **80 – 1000 px**.

| Control | Type | Options | Default |
|---|---|---|---|
| URL | text | — | — |
| Or upload a video file | upload | — | — |
| Autoplay | toggle | — | off |
| Loop | toggle | — | off |
| Start muted | toggle | — | off |
| Show player controls | toggle | uploaded files only | on |
| Aspect ratio | select | `16:9` · `21:9` · `4:3` · `1:1` · `3:4` · `16:10` · `3:2` | `16:9` |
| Player height (px) | text | 80 – 1000 | per provider |
| Caption | text | — | — |
| Full width | toggle | — | off |

**Autoplay is always muted**, on both sources — every current browser refuses to start an
unmuted video on its own, so "Start muted" is an override that autoplay ignores. For a
background-style video: autoplay on, loop on, controls off.

Only these four providers embed, and the allow-list is enforced server-side as well as in
the browser. A URL from anywhere else is refused rather than rendered.

An uploaded file is subject to a size ceiling that depends on where the site is hosted —
see [Upload limits](#upload-limits). The editor tells you the number before the upload
starts, and refuses a file over it immediately rather than part way through.

---

## Marquee

A scrolling ticker of upcoming events.

| Control | Type | Default |
|---|---|---|
| Fallback items | list | — |
| Full width | toggle | **on** |

The list is used **only when there are no upcoming events** — it is a fallback, not the
content. Bleeds edge to edge by default; switch full width off to cap it at 1400 px.

---

## CTA banner

| Control | Type | Options | Default |
|---|---|---|---|
| Image | upload | — | — |
| Eyebrow · Title · Description | text, multi-line, multi-line | — | — |
| Button label / link / style | text, text, select (`outline` · `accent`) | — | `outline` |
| Text case | select | `as-typed` · `uppercase` | `uppercase` |
| Full width | toggle | — | off |

---

## Contact form

Framed to the **narrow 900 px** measure. Submissions land in the admin.

| Control | Type | Default |
|---|---|---|
| Heading | text | — |
| Success message | multi-line | — |
| Full width | toggle | off |

---

## Newsletter

Framed to the **narrow 900 px** measure.

| Control | Type | Default |
|---|---|---|
| Heading · Body | text, multi-line | — |
| Button label | text | — |
| Full width | toggle | off |

---

## Custom HTML

| Control | Type | Default |
|---|---|---|
| HTML | multi-line | — |
| Full width | toggle | off |

Sanitised server-side before it is stored. **`<iframe>` is not allowed** — use the
Video / audio block, which embeds through the same allow-list from a host the server
controls.

---

## Spacer

| Control | Type | Default |
|---|---|---|
| Height | text — any CSS length, e.g. `4rem`, `120px` | `4rem` |

No width control: an empty box renders identically framed or full width, so a toggle
would visibly do nothing.

---

## Pages, slugs and roles

- **`/cms`** — the visual editor. `admin` or `editor`.
- **`/:slug`** — public pages, served off the root (`/mission`, not `/p/mission`).
  `/p/:slug` is a permanent redirect for old links.
- **`/`** — whichever page carries the homepage flag (the ⌂ button in Navigation), not
  the page whose slug happens to spell "home".
- Events, Artists, Gallery and the ticketing flows are generated from ticketing data, not
  authored as pages.

### Slugs that are not available

`events`, `shop`, `artists`, `gallery`, `cart`, `checkout`, `my-tickets`, `my-orders`,
`settings`, `newsletter`, `login`, `complete-profile`, `verify`, `reset-password`,
`admin`, `cms`, `scan`, plus `api`, `p` and `static`.

Creating a page on one is refused rather than allowed and then silently shadowed — a
static route always beats the `:slug` catch-all, so the page would exist in the CMS and
never open. The list lives in `RESERVED_SLUGS` (`backend/cms_routes.py`), and a test
fails if a route is added without being listed there.

> `archive` used to be reserved and is not any more. The Archive page was retired — it
> showed a projects grid and a past-events list, and past events are reachable from the
> Events page's own tabs — so `archive` is now a name you may use.

### Roles

| Role | Can do |
|---|---|
| `admin` | everything: ticketing dashboard, CMS, scanner |
| `editor` | CMS only |
| `door` | scanner only |
| `user` | default |

---

## Saving

Autosave is **off by default**, per person and per browser. The toggle sits in the toolbar
beside **Save now**.

- **Off** — nothing is written until you press Save now (or ⌘S). Unsaved work is flagged
  in the toolbar, and leaving the tab warns you.
- **On** — writes every 15 seconds while you are editing. An *interval*, not a pause
  timer: typing steadily still gets saved, rather than pushing the deadline ahead of you.

One Save covers everything on screen — blocks, page settings, theme, site settings — so
you never have to think about which pane you are in.

**Save is not Publish.** Saving updates the draft; **Publish** is what visitors see.

---

## Theme and fonts

Colours, typography and the header's menu size live under **Theme** and **Site**.
Publishing the theme is separate from publishing a page.

Uploaded fonts (WOFF2 / WOFF / TTF / OTF, 5 MB max) are served with the theme stylesheet
so the page never flashes a fallback face. The format is read from the file's signature
rather than trusted from its name.

---

## Upload limits

The ceiling on a single file is **not one number**, because it depends on what sits
between the browser and storage. The editor asks the server before every upload and shows
you the answer, so you should never have to work it out — this section is here for when
the number is smaller than you expected.

| Where the site runs | Ceiling | Why |
|---|---|---|
| A normal server (VPS, or local development) | **100 MB** | The file comes straight to the application, so the application's own limit is the only one. |
| Serverless, direct-to-storage working | **100 MB** | The browser sends the file to blob storage directly. It never passes through the application, so nothing in between can refuse it. |
| Serverless, direct-to-storage off | **4 MB** | Every byte has to fit inside one request, and the platform rejects a body over roughly 4.5 MB at the edge — before any of the site's own code runs. |

**The beta deployment is the second row: 100 MB.** The direct-to-storage route took six
attempts to get running and now answers, so the browser sends a large video straight to
blob storage and the 4.5 MB request limit never applies to it.

### What this means in practice

You can upload a real video — up to 100 MB — rather than a compressed fragment. The file
goes from your browser to storage directly, so the progress bar is real and a large upload
does not tie up the site.

Two things still argue for restraint. A visitor on a phone has to download whatever you
upload, so a 90 MB background loop is a slow page for them however fast it was to publish;
short clips at a modest bitrate are usually the better choice. And anything long-form —
a full set, an interview — is still better hosted on YouTube or Vimeo and embedded by URL,
which has no size limit at all and costs the site nothing to serve.

If the direct route is ever switched off (`DIRECT_BLOB_UPLOAD=0`), the editor drops back
to the third row automatically and tells you the smaller number before you pick a file.

Images are unaffected in practice — the editor compresses them before upload, and a
processed image lands well under any of these ceilings.

### If an upload is refused

The message names both numbers: the size of your file and the limit. That check happens in
the browser before a single byte is sent, so a refusal is instant. An upload that instead
runs for a while and *then* fails is a different problem and worth reporting.

---

## Text and the screen edge

Phones curve at the edge of the glass. A photograph that runs into that curve loses a
couple of pixels and nobody can tell. A **letter** that runs into it loses part of its
stem, and that reads as something broken rather than as a design.

So the site follows one rule, everywhere:

> **Media bleeds to the edge. Text never does.**

Turning **Full width** on still sends photographs, posters and video to the very edge of
the screen — that is what the toggle is for, and nothing about it has changed. What it no
longer does is take the words with them.

### The distance is yours to set

**Site → Text inset**, two sliders:

| | Default | Range |
|---|---|---|
| Phone | **16 px** | 0 – 64 |
| Desktop | **24 px** | 0 – 64 |

They move every piece of text on the site together — headings, body copy, form fields, the
hero, and the site's own chrome: the header wordmark, the phone menu, the footer and the
cookie banner all sit on the same line as the content above them.

### The footer

Two rows divided by a rule. The first carries the **Footer wordmark** and **Description**
on the left, and on the right every page you have marked *in footer*, as one line
separated by `·`, ending with the **Contact email**. The second carries the copyright and
your social links.

There are no column headings any more, so **Legal heading** no longer appears anywhere and
**Contact heading** is used only as the hover text on the email.

**Social links show only where you have filled them in**, and each one that is a real
platform draws its own logo — SoundCloud, Spotify, Instagram, YouTube, TikTok, Facebook,
and X. *Website* has no logo, because it is not a brand; it shows the word instead. Leave
a platform blank and it does not appear; leave them all blank and the row does not either.

The **Description** is the tallest thing in the footer, at roughly 40px on desktop and
70px on a phone. Clearing it in Site settings is the quickest way to make the footer
shorter, and takes effect immediately. That single line is what makes the inset
read as deliberate; setting blocks to different distances is what makes a page look
unfinished, which is why there is one control rather than one per block.

0 is allowed, and puts text back against the glass. The cap of 64 px exists because past
it a phone has no column left to read in.

### The three exceptions, and why

| Block | What moves in |
|---|---|
| **Gallery**, **Events** | The heading only. The photographs and posters keep the corner — they are the block. |
| **Split** | The text column only. The image keeps its own edge. |
| **CTA banner** | Everything, image included. On a phone its two columns stack, so the text lands under the image; insetting only the text would leave the picture hanging past it and make the stack look like a mistake. |

**Custom HTML** is left alone entirely, so you can still build something deliberately
edge-to-edge there.

### Against a full-page photo background

The `_background` block is unaffected: it still covers the whole viewport, corner to
corner, with no gap on any side. The text sitting on top of it moves in by the inset.

That is the same relationship the **Hero** has always had between its photograph and its
heading — the image fills the frame, the words sit inside it — which is why a page mixing
the two reads as one design rather than as a patch.

---

## Where these numbers come from

| Fact | Source |
|---|---|
| Widths, gutters, narrow measure | `Frame` / `Container`, `frontend/src/components/blocks/index.jsx` |
| Hero height and heading sizes | `HERO_HEIGHT_LIMITS`, `HERO_SIZE_LIMITS`, same file |
| Every control, its type and default | `FIELDS`, `frontend/src/pages/CMSEditor.jsx` |
| Block list and defaults | `BLOCK_LABELS`, `BLOCK_DEFAULTS`, `frontend/src/lib/cms.js` |
| Reserved slugs | `RESERVED_SLUGS`, `backend/cms_routes.py` |

If a number here disagrees with the site, the code is right and this file is stale.
