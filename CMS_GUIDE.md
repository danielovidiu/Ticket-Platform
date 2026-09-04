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
- [Split (image, text & audio)](#split-image-text--audio) — the one with the clip player
- [Events grid](#events-grid) · [Artists grid](#artists-grid) · [Gallery grid](#gallery-grid)
- [Video / audio](#video--audio-embed) · [Marquee](#marquee)
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
| Mobile view | select | `left` · `center` · `right` | `center` |
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

**Mobile view** picks which part of the photograph survives the crop on a phone — see
[Framing a photo for phones](#framing-a-photo-for-phones).

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

**Mobile view** is hidden while Fixed background is on — that photo is drawn at the band's
full width with its height left free, so there is no side crop for it to choose from.

### Framing a photo for phones

A background photo fills its block and the overflow is thrown away. On a wide screen that
costs the top and bottom, which is usually nothing. On a 375 px phone it costs most of the
**width** — a landscape photo can lose two thirds of itself — and by default the kept
third is the middle. A subject standing at the edge of the frame is simply cropped out.

**Mobile view** says which part to keep: `left`, `center` or `right`.

It applies **only below 768 px**. Nothing about the desktop rendering changes, whatever
the setting says, so it is safe to set on a page that is already published. Available on
**Hero** and **Image band**.

### Controls

| Control | Type | Options | Default |
|---|---|---|---|
| Background image | upload | — | — |
| Mobile view | select | `left` · `center` · `right` | `center` |
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
| Image aspect | select | **`natural`** · `1:1` · `4:3` · `3:4` · `16:9` · `16:10` · `3:2` | `natural` |
| Gap between the columns | slider | **0 – 80 px** | 40 px |
| Hairline around the photo | toggle | — | **on** |
| Eyebrow · Heading · Body | text, multi-line, multi-line | — | — |
| Heading size — desktop | slider | 16 – 240 px | **48 px** |
| Heading size — mobile | slider | 16 – 120 px | **30 px** |
| Text case | select | `as-typed` · `uppercase` | `uppercase` |
| Text align (horizontal) | select | `left` · `center` · `right` | `left` |
| Text position (vertical) | select | `top` · `middle` · `bottom` | `middle` |
| CTA label / link | text | — | — |
| Full width | toggle | — | off |

**`natural` aspect** lets the photograph keep its own proportions and makes the block as
tall as the picture, instead of cropping every image to one shape. The text column
stretches to match. Named ratios still crop, and a block published before this carries its
own saved ratio, so nothing on a live page moved.

**Heading size** defaults to 48/30 px — the size these headings have always rendered at.
It is deliberately *not* the hero's 72/48, so adding the control changed nothing.

**Text position** needs the column to have height to work within, which `natural` gives
it. Top-aligned text takes a small gutter so it does not sit level with the very top of
the photograph.

### Making a chessboard

Two of these stacked with **opposite directions** tile like a chessboard — but only if the
photographs actually reach the column boundary. Two things are in the way by default, and
both are now controls:

1. **Gap** → `0`. At 40 px there is a permanent band down the middle.
2. **Hairline** → off. A 1 px border on each photo leaves a 2 px seam where tiles meet.

With both set, the corners meet exactly. Blocks are flush vertically already, so no Spacer
between them.

Closing the gap does **not** push the words onto the picture: the text column takes back
as padding whatever the gap gives up, on the side facing the photograph only. Tiles touch,
words keep their distance.

---

## Split (image, text & audio)

Split's layout with the far column cut in two: **words above, a clip player below**. For a
release page — a sleeve on one side, the track snippets on the other.

| Control | Type | Options | Default |
|---|---|---|---|
| Direction | select | `image-left` · `image-right` | `image-left` |
| Image width (share of the block) | slider | **20 – 80 %** | 50 % |
| Photo and text meet in the middle | toggle | — | **on** |
| Image | upload | — | — |
| Max height | slider | 200 – 1400 px | 640 px |
| Gap between the columns | slider | 0 – 80 px | 40 px |
| Eyebrow · Heading · Body | text, multi-line, multi-line | — | — |
| Heading size — desktop / mobile | slider | 16 – 240 / 16 – 120 px | 48 / 32 px |
| Text case | select | `as-typed` · `uppercase` | `as-typed` |
| Text align (horizontal) | select | `left` · `center` · `right` | `left` |
| Text position (vertical) | select | `top` · `middle` · `bottom` | `middle` |
| Primary CTA label / link / style | text, text, select (`outline` · `accent`) | — | `outline` |
| Secondary CTA label / link | text | — | — |
| Audio tracks | list | name + file per row | — |
| Full width | toggle | — | off |

### Dimensions

The block is **as tall as the photograph**, which keeps its own proportions up to **Max
height**. Past that it crops rather than squashes. The text-and-player column stretches to
match, the words taking whatever space is left above the player.

**Image width** and **meet in the middle** work together:

- **Toggle on** (default) — each side takes half the block and the ratio decides how much
  of its own half the photo fills. The join between picture and words stays on the centre
  line at *every* ratio; the narrower side gives its spare width to the outer edge.
- **Toggle off** — the ratio sizes the columns themselves, so at 70 % the join sits 70 %
  of the way across.

At 50 % the two are identical: an even split, joined in the middle.

The photograph carries **no hairline** in this block.

### The player

One player, one clip at a time. Two of these blocks on a page will not sound over each
other — starting one stops the other.

**Transport:** previous · play/pause · next · elapsed · seek rail · duration · mute ·
volume. The rail can be dragged, clicked anywhere along its length, or driven from the
keyboard.

**Track list:** numbered rows, each with its name and length. Press a row to play it;
press it again to pause. When a clip ends the next one starts, and the list stops at the
end rather than looping.

> **Ninety seconds is the ceiling.** These are snippets. A longer file uploads and plays,
> but stops at 1:30 and hands to the next track — and the rail will not seek past that
> point, because that is where playback ends. A row shows what will *play*, so a
> five-minute file lists as `1:30`.

**Lengths are measured once, in the CMS**, when you choose the clip — not fetched from the
visitor's browser. A list of six tracks costs a visitor no extra requests, and only a clip
someone actually presses is ever downloaded. A track added by pasting a URL rather than
uploading shows no length until it is played.

The panel shows each clip's measured length and flags anything over the cap, so you see it
where the clip is chosen rather than by listening to it stop.

**Audio formats:** MP3, WAV, OGG, M4A. See [Upload limits](#upload-limits).

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

## CTA banner — removed

It is no longer in the palette. **Split** and **Image band** both do what it did and carry
controls it never had: alignment, heading size, a photograph that keeps its own shape.

A page still holding one shows a visitor **nothing** — the block is skipped rather than
printing an error into the page. Open that page in the editor and you will see a dashed
placeholder naming the retired block, which is your cue to delete it.

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

### What may be uploaded

| Kind | Accepted | Where |
|---|---|---|
| Image | JPEG · PNG · WebP · GIF | any image field |
| Video | MP4 · WebM · MOV | Video block |
| Audio | **MP3 · WAV · OGG · M4A** | Split (image, text & audio) |

A file is checked against what it *claims* to be, not against its name: markup renamed
`.mp3` is refused, and so is a WAV announced as an MP3. A format outside the list is
refused **before anything is sent**, with the accepted ones named — so a `.flac` fails
instantly rather than after a long upload.

An audio clip is stored exactly as uploaded. Images are re-encoded (which is what strips
their EXIF); audio and video are not, because there is no transcoder on the server.

For clip length, the ninety-second rule belongs to the player, not the upload — see
[Split (image, text & audio)](#split-image-text--audio).

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

One line. The copyright on the left, your social marks in the middle, and on the right
every page you have marked **Show in footer**.

There is no rule above it and no wordmark in it. Both were removed: with a single line of
small type, a border only announced something the eye already knew.

**It floats over the page.** The footer is completely invisible while you read, fading in
across the last 150 pixels of the scroll and reaching full strength exactly at the end,
where it settles into the site's own background colour. On a page too short to scroll it
is simply there, because you are already at the end.

**Words stop above it; pictures carry on underneath.** Every page reserves exactly the
footer's height at the end of its content, so a paragraph, a form or a button always ends
above it. A page background photo or video is not part of that flow — it fills the window
and runs to the very bottom of the screen, showing through for the whole time the footer
is transparent.

While it is invisible it cannot be clicked or tabbed to, which is deliberate: an unseen
link is not a link. Scroll to the bottom of any page and it is there.

**Anything the footer should link to is a page.** Make it in the CMS, tick *Show in
footer*, and it joins the row — that includes the consumer-protection notices a
jurisdiction requires, such as ANPC and SAL in Romania. None of those are built into the
code, which is what lets a site elsewhere carry whichever its own law asks for. A page in
the footer is kept out of the main navigation.

**Social marks show only where you have filled them in**, and each real platform draws its
own logo — SoundCloud, Spotify, Instagram, YouTube, TikTok, Facebook, and X. *Website* has
no logo, because it is not a brand; it shows the word instead. Leave them all blank and
the middle of the line is simply empty.

Only two fields feed this now: **Copyright name** and **Social links**. The footer
wordmark, description, contact email and the two column headings were removed from Site
settings when the rows that carried them went — an editable field that changes nothing on
the site is worse than no field at all.
read as deliberate; setting blocks to different distances is what makes a page look
unfinished, which is why there is one control rather than one per block.

0 is allowed, and puts text back against the glass. The cap of 64 px exists because past
it a phone has no column left to read in.

### The exceptions, and why

| Block | What moves in |
|---|---|
| **Gallery**, **Events** | The heading only. The photographs and posters keep the corner — they are the block. |
| **Split**, **Split (image, text & audio)** | The text column only — and, in the audio one, the player with it, so the two share an edge. The image keeps its own edge in both. |

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
