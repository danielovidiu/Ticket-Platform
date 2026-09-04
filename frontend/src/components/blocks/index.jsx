import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import { QRCodeCanvas } from "qrcode.react";
import DOMPurify from "dompurify";
import { resolveEmbed, withPlayback, AUDIO_PROVIDERS } from "../../lib/embeds";
import { http } from "../../api";
import { toast } from "sonner";
import { renderRich } from "../../lib/richText";
import { mediaUrl } from "../../lib/media";
import { Lightbox } from "../ui/lightbox";
import { Camera, Pause, Play, SkipBack, SkipForward, Volume2, VolumeX } from "lucide-react";

const fmtDate = (iso) => new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).toUpperCase();

/** Tailwind-safe aspect utility from a friendly ratio label. Exported because an event
 * carries its own format now, and the event page needs the same map the blocks use — two
 * copies would drift and one of them would render an image with no aspect at all. */
export const ASPECTS = {
  "1:1": "aspect-square",
  "4:3": "aspect-[4/3]",
  "3:4": "aspect-[3/4]",
  "16:9": "aspect-video",
  "21:9": "aspect-[21/9]",
  "3:2": "aspect-[3/2]",
  "16:10": "aspect-[16/10]",
  // Portrait ratios, added for video: a phone held upright wants a tall container, and
  // 16:9 on a 375px screen is a 211px strip. 9:16 is the mirror of the landscape default;
  // 4:5 is the gentler crop when a full-height video is too much.
  "9:16": "aspect-[9/16]",
  "4:5": "aspect-[4/5]",
};
const aspectClass = (v, fallback = "aspect-square") => ASPECTS[v] || fallback;

/**
 * The 1400px frame and the side gutters every block sits in.
 *
 * VERTICAL padding is deliberately absent from this file. Blocks used to carry their own
 * `py-10`/`py-16`/`py-24`, which meant page rhythm was decided by whoever wrote each
 * block rather than by the person composing the page: two blocks that happened to be
 * `py-24` and `py-16` produced a 40-unit gap nobody chose and nobody could change. Every
 * block is now flush, and the Spacer block is the one control for the space between them.
 *
 * The HORIZONTAL gutters stay by DEFAULT. They are not spacing between blocks — they are
 * what keeps text off the edge of a phone screen, and Spacer only has a height, so there
 * is nothing to restore them with. A block set FULL WIDTH drops them deliberately, the
 * way the hero's full frame always has — see `Frame`.
 *
 * Two insets survive on purpose and are not inter-block spacing: the hero's text inset
 * over its own background image, and the "Image not set" editor placeholder.
 */
function Container({ children, className = "" }) {
  // `w-full` is load-bearing, not decoration. Inside a flex column — which the hero and
  // the image band both are — `mx-auto` sets auto margins on the CROSS axis, and an
  // auto cross-axis margin suppresses the default `stretch`. The container then
  // shrink-wrapped its own text and the auto margins centred that box, so a hero set to
  // align left rendered its heading a third of the way across the screen: correctly
  // left-aligned, inside a box that was floating in the middle. Width first, then the
  // max-width caps it and mx-auto centres the capped box, which is what was always meant.
  return <div className={`w-full max-w-[1400px] mx-auto edge-inset ${className}`}>{children}</div>;
}

/**
 * The width a block holds its content at.
 *
 * `full` drops the 1400px cap so the block spans the viewport. The side GUTTERS stay
 * either way — they are not spacing between blocks, they are what keeps text off the edge
 * of a phone, and there is no horizontal spacer to put them back with.
 *
 * `narrow` is the reading measure some blocks use instead: prose, a contact form and the
 * newsletter sign-up are all worse at 1400px than at 900, because a line of text that
 * wide is one the eye loses its place in.
 */
function Frame({ full, narrow = false, className = "", children }) {
  // Full width means what the hero has always meant by it: the block goes edge to edge,
  // gutters included. The first version kept the side padding when full, so a toggle
  // labelled "edge to edge" left 40px of gap on each side — a label the code did not keep.
  //
  // What CHANGED is what "edge to edge" is allowed to do to text. It used to put prose
  // against the glass, and the comment here called that "the editor's to make" — but it
  // is not really a choice anyone wants: on a curved screen the outermost letters lose a
  // sliver to the bend, which reads as a rendering fault rather than as a design.
  //
  // So the frame still surrenders its gutters when full, and the MEDIA inside it still
  // bleeds; the blocks wrap their text in `EdgeInset` instead. Photographs reach the
  // corner, type does not.
  if (full) return <div className={`w-full ${className}`}>{children}</div>;
  const measure = narrow ? "max-w-[900px]" : "max-w-[1400px]";
  return <div className={`w-full mx-auto edge-inset ${measure} ${className}`}>{children}</div>;
}

/**
 * The text inset, applied only where the frame around it has surrendered its own.
 *
 * `full` is the block's own full-width flag, passed straight through. When it is off the
 * Frame has already inset everything and a second helping would double the gutter, so
 * this renders a bare wrapper; when it is on, this is the only thing standing between a
 * paragraph and the edge of the screen.
 *
 * Media is deliberately left outside it. A gallery photograph, an event poster, a video:
 * those are meant to touch the corner and lose nothing by it.
 */
function EdgeInset({ full, className = "", children }) {
  return <div className={`${full ? "edge-inset" : ""} ${className}`.trim()}>{children}</div>;
}

// ---------------- Blocks ----------------

/**
 * Hero heading sizes.
 *
 * These are FIXED steps, not `vw`. The heading used to be `text-[10vw] md:text-[7vw]`,
 * which ties type size to the browser window and makes it unstable by construction: the
 * same heading is a different size in the editor than on the site, and in the CMS
 * preview it is sized from the whole window while being drawn into a pane half that
 * wide — measured at 71px inside a 501px pane, and the same 71px inside the 418px
 * "mobile" preview, where a real phone would render 42px.
 *
 * A step ladder is stable, previews honestly, and is the thing the editor asked for:
 * typography that only changes when someone changes it.
 */
/**
 * Hero heading size, in plain pixels, one value per breakpoint.
 *
 * Not `vw`: that tied type size to the browser window, so the same heading was a
 * different size in the editor than on the site — measured at 71px inside a 501px
 * preview pane, and the same 71px inside the 418px "mobile" preview where a phone
 * renders 42px. Not a four-step ladder either: four steps is a choice between four
 * headings, and a hero heading is the one piece of type on a page that is worth setting
 * exactly.
 *
 * The two values are separate because they have to be. A 96px heading is right on a
 * laptop and unreadable on a 375px phone, and there is no single number that is both.
 */
export const HERO_SIZE_LIMITS = {
  mobile: { min: 16, max: 120, fallback: 48 },
  desktop: { min: 16, max: 240, fallback: 72 },
};

/** The named steps this replaced, in the pixel sizes those Tailwind classes emitted.
 * Blocks saved with one keep rendering at exactly the size they were published at. */
const LEGACY_STEPS = {
  s: { mobile: 30, desktop: 36 },
  m: { mobile: 36, desktop: 60 },
  l: { mobile: 48, desktop: 72 },
  xl: { mobile: 60, desktop: 96 },
};

const clampPx = (value, { min, max }) => Math.min(max, Math.max(min, Math.round(Number(value))));

/**
 * The size a hero heading actually renders at, from whichever of the three shapes the
 * block was saved in: explicit pixels, a legacy named step, or nothing at all.
 */
export function heroHeadingSize(props) {
  const legacy = LEGACY_STEPS[props.heading_size] || LEGACY_STEPS.l;
  const pick = (key) => {
    const raw = props[`heading_size_${key}`];
    if (raw === undefined || raw === null || raw === "" || Number.isNaN(Number(raw))) return legacy[key];
    return clampPx(raw, HERO_SIZE_LIMITS[key]);
  };
  return { mobile: pick("mobile"), desktop: pick("desktop") };
}

/**
 * Blocks authored before `text_case` existed rendered their heading through CSS
 * `uppercase`, so honouring the author's casing by default would silently restyle every
 * published page. Absent therefore means "legacy, keep shouting"; an explicit value
 * means the editor has chosen, and new blocks are created with "as-typed".
 */
const casing = (props) => (props.text_case === undefined ? "uppercase" : props.text_case === "uppercase" ? "uppercase" : "normal-case");

/**
 * How the hero darkens its image. Three named modes rather than a boolean, because the
 * treatment that shipped first — a theme-wide opacity plus a bottom gradient — is not
 * expressible as "a colour at an opacity", and dropping it would restyle every hero
 * already published. Absent means that original mode.
 *
 * A boolean was tried and was worse than useless: the panel showed "Overlay: on" from a
 * fallback while the prop stayed absent, so the colour and opacity controls sat there
 * looking editable and changed nothing.
 */
/**
 * Where the text sits down the height of an image-backed block.
 *
 * Absent means the position each block shipped with — the hero pinned to the bottom, the
 * band centred — so nothing already published moves. That is also why this is a lookup
 * with a per-block fallback rather than one default: the two blocks disagree about what
 * "unset" means, and always did.
 */
const CONTENT_Y = { top: "justify-start", middle: "justify-center", bottom: "justify-end" };
const contentY = (props, fallback) => CONTENT_Y[props.content_y] || fallback;

/** Where the named steps sit on the 0-100 scale that replaced them. */
const CONTENT_Y_AS_PERCENT = { top: 0, middle: 50, bottom: 100 };

/**
 * How far down the block its text sits, as a percentage of the block's own height.
 *
 * Three named steps could put a hero's words at the top, the middle or the bottom of the
 * image and nowhere else — and on a photograph the one place they need to go is usually
 * none of those three, because a face or a horizon is in the way.
 *
 * A block that predates the slider takes the position its old step meant, so nothing
 * moves on upgrade. `fallback` is what a block with neither carries.
 */
export function contentOffset(props, fallback = 100) {
  const raw = Number(props.content_offset);
  if (Number.isFinite(raw)) return Math.min(100, Math.max(0, raw));
  const named = CONTENT_Y_AS_PERCENT[props.content_y];
  return named === undefined ? fallback : named;
}

/**
 * Two spacers either side of the content, growing in proportion.
 *
 * Absolute positioning with `top: P%` would be the obvious way and it can overflow: at
 * 100% a block of text taller than its section hangs out of the bottom, and the section
 * clips it. Flex-grow shares out only the space that is actually free, so the content is
 * placed proportionally when there is room and simply fills the block when there is not.
 */
function VerticalPlacement({ offset, children, testId }) {
  return (
    <>
      <div style={{ flexGrow: offset }} aria-hidden="true" data-testid={testId && `${testId}-space-before`} />
      {children}
      <div style={{ flexGrow: 100 - offset }} aria-hidden="true" data-testid={testId && `${testId}-space-after`} />
    </>
  );
}

const overlayMode = (props) => (props.overlay === undefined ? "gradient" : props.overlay === true ? "solid" : props.overlay || "none");

/**
 * Which part of a photograph survives the crop on a phone.
 *
 * A background image is `object-cover`: it fills the block and the overflow is thrown
 * away. On a wide screen that costs the top and bottom of the picture, which is usually
 * nothing. On a 375px-wide screen it costs most of the WIDTH — a 3:2 photograph in a
 * portrait block loses about two thirds of itself — and `object-position` decides which
 * third is kept. Centred by default, so a subject standing at the edge of the frame is
 * cropped out of the phone view entirely with no way to say otherwise.
 *
 * Deliberately mobile-only. On desktop this returns `undefined`, which writes no inline
 * style at all and leaves every block already published rendering exactly as it does
 * now — the control answers a question that only a narrow screen asks.
 */
const MOBILE_FOCUS = { left: "0% 50%", center: "50% 50%", right: "100% 50%" };
const mobileFocus = (props, isMobile) =>
  (isMobile ? MOBILE_FOCUS[props.mobile_focus] || MOBILE_FOCUS.center : undefined);

/**
 * Hero height, as a percentage of the viewport.
 *
 * vh rather than the px the heading sizes use, and for the opposite reason. A heading
 * needs px because 96px is right on a laptop and unreadable on a 375px phone — the same
 * number is the wrong size at both ends. A hero is the other way round: it is a
 * viewport-filling element by construction, so a fixed 600px is most of a phone screen
 * and a third of a laptop, and only a proportion means the same thing on both.
 *
 * It also keeps the three named steps this replaces exact. They WERE vh, so a hero
 * published as "tall" resolves to 85 and renders at the height it always did.
 */
export const HERO_HEIGHT_LIMITS = { min: 10, max: 100, fallback: 85 };

const LEGACY_HEIGHTS = { short: 50, medium: 70, tall: 85 };

export function heroHeight(props) {
  const raw = props.height_vh;
  if (raw === undefined || raw === null || raw === "" || Number.isNaN(Number(raw))) {
    return LEGACY_HEIGHTS[props.height] ?? HERO_HEIGHT_LIMITS.fallback;
  }
  // clampPx rounds and clamps; the name is about how it is usually used, not the unit.
  return clampPx(raw, HERO_HEIGHT_LIMITS);
}

function Hero({ props }) {
  const minHeight = { minHeight: `${heroHeight(props)}vh` };
  const align = props.align === "center" ? "text-center items-center" : props.align === "right" ? "text-right items-end" : "text-left items-start";
  const size = heroHeadingSize(props);
  const upper = casing(props);
  // Absent means legacy, where the hero was always edge to edge.
  const fullFrame = props.full_frame !== false;
  const objectPosition = mobileFocus(props, useIsMobileViewport());

  const media = props.image_url && (
    <div className="absolute inset-0">
      <img src={mediaUrl(props.image_url)} alt="" className="w-full h-full object-cover"
           style={{ objectPosition }} data-testid="hero-image" />
      {overlayMode(props) === "gradient" ? (
        // The original treatment: a theme-wide image opacity plus a bottom gradient,
        // neither of which an editor could see or change. It stays as a NAMED option
        // rather than as the behaviour of an absent field, so blocks that predate the
        // overlay controls look identical AND their panel says what they are doing.
        <div data-testid="hero-overlay" data-mode="gradient">
          <div className="absolute inset-0 bg-[color:var(--bg,#050505)] opacity-[calc(1-var(--hero-image-opacity))]" />
          <div className="absolute inset-0 bg-gradient-to-b from-transparent to-[color:var(--bg,#050505)]" />
        </div>
      ) : overlayMode(props) === "solid" ? (
        <div className="absolute inset-0"
             style={{
               backgroundColor: props.overlay_color || "#050505",
               opacity: Math.min(100, Math.max(0, Number(props.overlay_opacity ?? 45))) / 100,
             }}
             data-testid="hero-overlay" data-mode="solid" />
      ) : null}
    </div>
  );

  const body = (
    // Symmetric padding: the text used to be pinned to the bottom, so only bottom
    // padding mattered. It can sit anywhere now, and at 0% it would otherwise start
    // hard against the top edge.
    <Container className="relative py-16 md:py-24">
      <div className={`flex flex-col ${align}`}>
        {props.eyebrow && <div className={`font-mono-x text-xs ${upper} tracking-[0.3em] text-ink-3 mb-6`}>{props.eyebrow}</div>}
        {props.heading && (
          <h1 className={`font-display hero-heading ${upper} tracking-tighter font-black max-w-6xl whitespace-pre-wrap`}
              style={{ "--hero-heading-mobile": `${size.mobile}px`, "--hero-heading-desktop": `${size.desktop}px` }}
              data-testid="hero-heading">
            {props.heading}
          </h1>
        )}
        {props.body && <div className="mt-8 max-w-xl">{renderRich(props.body, { paraClassName: "text-ink-2 leading-relaxed text-lg" })}</div>}
        <div className="mt-8 flex flex-wrap gap-3">
          {props.cta_label && <Link to={props.cta_href || "#"} className={props.cta_style === "accent" ? "btn-accent" : "btn-primary"}>{props.cta_label}</Link>}
          {props.second_cta_label && <Link to={props.second_cta_href || "#"} className="btn-primary">{props.second_cta_label}</Link>}
        </div>
      </div>
    </Container>
  );

  // Full frame spans the viewport, as the hero always has. Turned off, the whole block —
  // image included — is held inside the same 1400px frame the Image block's "Full width"
  // toggles against, so the two controls mean the same thing in both places.
  // 100 = flush with the bottom, which is where the hero has always put its words.
  const offset = contentOffset(props, 100);
  const placed = <VerticalPlacement offset={offset} testId="hero">{body}</VerticalPlacement>;

  if (fullFrame) {
    return (
      <section className="relative overflow-hidden flex flex-col" style={minHeight} data-testid="hero"
               data-content-offset={offset}>
        {media}{placed}
      </section>
    );
  }
  return (
    <section data-testid="hero" data-content-offset={offset}>
      <div className="max-w-[1400px] mx-auto relative overflow-hidden flex flex-col border border-ink/10" style={minHeight}>
        {media}{placed}
      </div>
    </section>
  );
}

function RichText({ props }) {
  return (
    <section><Frame full={props.full_width} narrow>
      <EdgeInset full={props.full_width}>{renderRich(props.content)}</EdgeInset>
    </Frame></section>
  );
}

function ImageBlock({ props }) {
  if (!props.image_url) return <div className="py-8 text-center text-ink-4 font-mono-x text-xs uppercase">Image not set</div>;
  const cls = props.full_width ? "w-full" : "max-w-[1200px] mx-auto";
  const aspect = props.aspect && props.aspect !== "natural" ? aspectClass(props.aspect, "") : "";
  return (
    <section>
      <figure className={cls}>
        <div className={`${aspect} overflow-hidden border border-ink/10`}>
          <img src={mediaUrl(props.image_url)} alt={props.caption || ""} className="w-full h-full object-cover block" />
        </div>
        {props.caption && <figcaption className="p-3 font-mono-x text-xs uppercase tracking-[0.25em] text-ink-4">{props.caption}</figcaption>}
      </figure>
    </section>
  );
}

function GalleryGrid({ props }) {
  const [items, setItems] = useState([]);
  useEffect(() => { http.get("/gallery").then((r) => setItems(r.data.slice(0, props.limit || 6))).catch(() => {}); }, [props.limit]);
  return (
    <section><Frame full={props.full_width}>
      {props.heading && (
        <EdgeInset full={props.full_width}>
          <h2 className="font-display text-3xl md:text-5xl uppercase font-bold tracking-tighter mb-8">{props.heading}</h2>
        </EdgeInset>
      )}
      {/* Not inset: the photographs are the block, and they lose nothing at the corner. */}
      <div className="columns-1 md:columns-3 gap-4 space-y-4">
        {items.map((g) => (
          <figure key={g.gallery_id} className="break-inside-avoid border border-ink/10">
            <img src={mediaUrl(g.image_url)} alt={g.caption} className="w-full block" />
          </figure>
        ))}
      </div>
    </Frame></section>
  );
}

function EventsGrid({ props }) {
  const [events, setEvents] = useState([]);
  const [active, setActive] = useState(null); // { items, index }
  useEffect(() => { http.get("/events?upcoming=true").then((r) => setEvents(r.data.slice(0, props.limit || 4))).catch(() => {}); }, [props.limit]);
  const cols = props.layout === "grid-3" ? "md:grid-cols-3" : props.layout === "grid-1" ? "" : "md:grid-cols-2";

  const openAlbum = (e) => {
    const items = e.gallery.map((g) => ({ url: g.image_url, thumbnail_url: g.thumbnail_url, media_type: g.media_type, caption: g.caption }));
    setActive({ items, index: 0 });
  };

  return (
    <section><Frame full={props.full_width}>
      <EdgeInset full={props.full_width}>
        <div className="flex items-end justify-between mb-10">
          <div>
            {props.eyebrow && <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-ink-4">{props.eyebrow}</div>}
            {props.heading && <h2 className="font-display text-4xl md:text-6xl uppercase font-bold tracking-tighter mt-2">{props.heading}</h2>}
          </div>
          <Link to="/events" className="btn-primary">All events</Link>
        </div>
      </EdgeInset>
      {/* Not inset: the posters were judged to look right against the edge. */}
      <div className={`grid grid-cols-1 ${cols} gap-6 items-stretch`}>
        {events.map((e) => {
          const hasAlbum = e.gallery && e.gallery.length > 0;
          // The first album's chosen cover, not just the first photo the event owns —
          // an album carries an explicit cover now, and this card is a tile for it.
          const cover = hasAlbum ? (e.albums?.[0]?.cover || e.gallery[0]) : null;
          // The event's own format, applied to its card as well as its page — a shape
          // chosen once with the image rather than separately by everything that shows
          // it. Absent means the 16:10 these cards have always used.
          const cardAspect = ASPECTS[e.image_aspect] || "aspect-[16/10]";
          return (
            <div key={e.event_id} className="group flex flex-col h-full border border-ink/10 bg-surface hover:border-ink transition-colors">
              {hasAlbum ? (
                <button onClick={() => openAlbum(e)} data-testid={`events-grid-cover-${e.slug}`} className={`${cardAspect} overflow-hidden relative block w-full text-left shrink-0`}>
                  {cover.media_type === "video" ? (
                    <video src={mediaUrl(cover.image_url)} className="w-full h-full object-cover" muted preload="metadata" />
                  ) : (
                    <img src={mediaUrl(cover.thumbnail_url || cover.image_url)} alt={e.title} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                  )}
                  <div className="absolute bottom-2 right-2 bg-scrim/70 px-2 py-1 flex items-center gap-1 font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink">
                    <Camera size={11} /> {e.gallery.length}
                  </div>
                </button>
              ) : (
                <Link to={`/events/${e.slug}`} className={`${cardAspect} overflow-hidden block shrink-0`}>
                  <img src={mediaUrl(e.image_url)} alt={e.title} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                </Link>
              )}
              <Link to={`/events/${e.slug}`} className="p-6 flex-1 flex flex-col justify-center">
                <div className="font-mono-x text-xs uppercase tracking-[0.25em] text-ink-4">{fmtDate(e.starts_at)} · {[e.venue, e.city].filter(Boolean).join(", ")}</div>
                <div className="font-display text-3xl uppercase tracking-tighter font-bold mt-3">{e.title}</div>
              </Link>
            </div>
          );
        })}
        {events.length === 0 && <div className="col-span-full border border-dashed border-ink/10 p-10 text-center text-ink-4 font-mono-x text-xs uppercase tracking-[0.3em]">No upcoming events</div>}
      </div>
      {active && (
        <Lightbox
          items={active.items}
          index={active.index}
          onClose={() => setActive(null)}
          onIndexChange={(i) => setActive({ ...active, index: i })}
        />
      )}
    </Frame></section>
  );
}

function ArtistsGrid({ props }) {
  const [artists, setArtists] = useState([]);
  useEffect(() => { http.get("/artists").then((r) => setArtists(r.data.slice(0, props.limit || 6))).catch(() => {}); }, [props.limit]);
  const cols = props.layout === "grid-2" ? "md:grid-cols-2" : props.layout === "grid-4" ? "md:grid-cols-4" : "md:grid-cols-3";
  return (
    <section><Frame full={props.full_width}>
      {/* Heading AND grid, unlike Gallery and Events: an artist tile carries the artist's
          NAME beneath it, so leaving the grid at the edge would leave that name there. */}
      <EdgeInset full={props.full_width}>
        <div className="flex items-end justify-between mb-10">
          <div>
            {props.eyebrow && <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-ink-4">{props.eyebrow}</div>}
            {props.heading && <h2 className="font-display text-4xl md:text-6xl uppercase font-bold tracking-tighter mt-2">{props.heading}</h2>}
          </div>
          <Link to="/artists" className="btn-primary">All artists</Link>
        </div>
        <div className={`grid grid-cols-2 ${cols} gap-4`}>
        {artists.map((a) => (
          <Link key={a.artist_id} to={`/artists/${a.slug}`} className="group block border border-ink/10">
            <div className={`${aspectClass(props.card_aspect, "aspect-square")} overflow-hidden`}><img src={mediaUrl(a.image_url)} alt={a.name} className="w-full h-full object-cover grayscale group-hover:grayscale-0 transition duration-500" /></div>
            <div className="p-4"><div className="font-display uppercase font-semibold">{a.name}</div></div>
          </Link>
        ))}
        </div>
      </EdgeInset>
    </Frame></section>
  );
}

function Marquee({ props }) {
  const [events, setEvents] = useState([]);
  useEffect(() => { http.get("/events?upcoming=true").then((r) => setEvents(r.data)).catch(() => {}); }, []);
  // Live upcoming events drive the marquee; the configured `items` are only a
  // fallback for when there are none, not the primary source.
  const items = events.length
    ? events.map((e) => (e.city ? `${e.title} · ${e.city}` : e.title))
    : (props.items || []).length ? props.items : ["NO UPCOMING EVENTS"];
  // A ticker is edge-to-edge by nature and runs with NO gutters — the text sliding off
  // the screen edge is the effect. So `full_width` defaults to true here, unlike every
  // other block: unset means what it has always done, and turning it off is what holds
  // the ticker inside the 1400px frame instead.
  const bleed = props.full_width !== false;
  return (
    <section className={`hairline-b hairline overflow-hidden ${bleed ? "" : "max-w-[1400px] mx-auto"}`}>
      <div className="marquee">
        <div className="marquee-track font-mono-x uppercase tracking-[0.3em] text-2xl md:text-4xl">
          {[...items, ...items].map((m, i) => (
            <span key={`${m}-${i}`} className="flex items-center gap-16 text-ink-4">{m} <span className="text-brand">◆</span></span>
          ))}
        </div>
      </div>
    </section>
  );
}

function ContactFormBlock({ props }) {
  const [f, setF] = useState({ name: "", email: "", message: "" });
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true);
    try { await http.post("/contact", f); toast.success(props.success_message || "Sent"); setF({ name: "", email: "", message: "" }); }
    catch { toast.error("Failed"); }
    setBusy(false);
  };
  return (
    <section><Frame full={props.full_width} narrow>
      <EdgeInset full={props.full_width}>
      {props.heading && <h2 className="font-display text-3xl md:text-5xl uppercase font-bold tracking-tighter">{props.heading}</h2>}
      <form onSubmit={submit} className="border border-ink/10 bg-[color:var(--surface,#0F0F0F)] p-6 md:p-8 space-y-4 mt-6">
        <input required placeholder="NAME" value={f.name} onChange={(e) => setF({...f, name: e.target.value})} className="input-x" />
        <input required type="email" placeholder="EMAIL" value={f.email} onChange={(e) => setF({...f, email: e.target.value})} className="input-x" />
        <textarea required rows={5} placeholder="MESSAGE" value={f.message} onChange={(e) => setF({...f, message: e.target.value})} className="input-x" />
        <button disabled={busy} className="btn-accent w-full">{busy ? "SENDING…" : "SEND"}</button>
      </form>
      </EdgeInset>
    </Frame></section>
  );
}

function Newsletter({ props }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (!email) return;
    setBusy(true);
    try {
      const { data } = await http.post("/newsletter", { email, source: props.heading || "newsletter" });
      toast.success(data.already_subscribed ? "You're already on the list" : "Subscribed");
      setEmail("");
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed");
    }
    setBusy(false);
  };
  return (
    <section className="hairline"><Frame full={props.full_width} narrow>
      <EdgeInset full={props.full_width}>
      {props.heading && <h2 className="font-display text-3xl md:text-4xl uppercase font-bold tracking-tighter">{props.heading}</h2>}
      {/* Rich text, like every other multi-line body field — this one rendered inline,
          so an author's line breaks were dropped in this block and kept in the next. */}
      {props.body && <div className="mt-3">{renderRich(props.body, { paraClassName: "text-ink-3" })}</div>}
      <form onSubmit={submit} className="mt-6 flex gap-3 flex-wrap">
        <input required type="email" placeholder="you@domain.com" value={email} onChange={(e) => setEmail(e.target.value)} className="input-x flex-1 min-w-[240px]" data-testid="newsletter-email" />
        <button disabled={busy} className="btn-accent" data-testid="newsletter-submit">{busy ? "…" : (props.cta_label || "Subscribe")}</button>
      </form>
      </EdgeInset>
    </Frame></section>
  );
}

// Default player heights, in px, by provider and by whether the thing playing is one
// track or a list of them. Bandcamp emits size=large for both, so both want the same box.
const AUDIO_HEIGHTS = {
  soundcloud: { track: 166, playlist: 400 },
  bandcamp: { track: 470, playlist: 470 },
};

/** The default for what is playing, unless the block names its own height. */
function audioHeight(embed, props) {
  const raw = props.embed_height;
  if (raw !== undefined && raw !== null && raw !== "" && !Number.isNaN(Number(raw))) {
    return clampPx(raw, { min: 80, max: 1000 });
  }
  const byProvider = AUDIO_HEIGHTS[embed.provider] || AUDIO_HEIGHTS.soundcloud;
  return byProvider[embed.kind === "playlist" ? "playlist" : "track"];
}

/** True while the viewport is below Tailwind's `md`, which is where the mobile cut and
 *  the portrait aspect take over.
 *
 * A media query rather than two <video> elements hidden by CSS: a hidden element still
 * downloads its source, so the CSS approach would pull BOTH cuts on every visit — which
 * on a 100MB pair is the whole point of having two of them, wasted. */
const MOBILE_QUERY = "(max-width: 767px)";

function useIsMobileViewport() {
  const subscribe = useCallback((fn) => {
    const mq = window.matchMedia?.(MOBILE_QUERY);
    if (!mq) return () => {};
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);
  return useSyncExternalStore(
    subscribe,
    () => (window.matchMedia?.(MOBILE_QUERY)?.matches ?? false),
    () => false,   // server render: assume desktop, which is the wider default
  );
}

function VideoEmbed({ props, preview }) {
  // Browsers refuse to start an unmuted video on their own, so autoplay forces muted
  // rather than offering a combination that would silently never play.
  const autoplay = !!props.autoplay;
  const loop = !!props.loop;
  const muted = autoplay || !!props.muted;
  const controls = props.controls !== false;

  /* One shape for a wide screen and another for a tall one.
   *
   * A single ratio cannot serve both: 16:9 on a 375px phone is a 211px strip, which is
   * the complaint this answers. The reference site (alexandermcqueen.com, measured) runs
   * 16:9 at 1440 wide and 9:16 at 375 — the container follows the DEVICE's orientation
   * so the video fills the screen either way, rather than keeping one ratio and shrinking.
   *
   * `aspect_mobile` absent falls back to the desktop ratio, which is exactly what every
   * video block did before this existed, so nothing published changes shape. */
  const isMobile = useIsMobileViewport();
  const desktopAspect = aspectClass(props.aspect, "aspect-video");
  const aspect = isMobile
    ? aspectClass(props.aspect_mobile || props.aspect, "aspect-video")
    : desktopAspect;

  /* The mobile cut, when there is one. Chosen in JS rather than with CSS so only the
   * file that will actually be shown is downloaded. */
  const fileUrl = (isMobile && props.file_url_mobile) || props.file_url;
  const posterUrl = (isMobile && props.file_url_mobile && props.poster_url_mobile)
    || props.poster_url;
  // The caption is text and moves in; the video above it is media and does not.
  const caption = props.caption
    ? <EdgeInset full={props.full_width}>
        <div className="mt-2 font-mono-x text-xs uppercase tracking-[0.25em] text-ink-4"
             data-testid="video-caption">{props.caption}</div>
      </EdgeInset>
    : null;

  // An uploaded file wins over a pasted embed URL when both are set: it is the more
  // specific of the two, and the only one that autoplays without a third-party player's
  // chrome over it. CSP `media-src` covers 'self' and the blob store, so a file that came
  // from /admin/uploads plays and an arbitrary pasted host is refused by the browser.
  if (fileUrl) {
    return (
      <section><Frame full={props.full_width}>
        {/* No border when it bleeds: a hairline around a full-bleed video is a line down
            the side of the screen, not a frame. */}
        <div className={`${aspect} ${props.full_width ? "" : "border border-ink/10"} bg-scrim overflow-hidden`}>
          <video
            key={fileUrl}
            src={mediaUrl(fileUrl)}
            poster={posterUrl ? mediaUrl(posterUrl) : undefined}
            className="w-full h-full object-cover"
            autoPlay={autoplay}
            muted={muted}
            loop={loop}
            controls={controls}
            playsInline
            preload={autoplay ? "auto" : "metadata"}
            data-testid="video-file"
          />
        </div>
        {caption}
      </Frame></section>
    );
  }

  if (!props.url) return null;

  // Audit M11. This used to fall through to the author's raw URL for anything that was
  // neither YouTube nor Vimeo, framing any page on the internet inside a real Supersanity
  // URL. `resolveEmbed` returns a canonical src from a fixed host list or nothing at all —
  // there is no passthrough any more.
  const embed = withPlayback(resolveEmbed(props.url), { autoplay, loop });

  if (!embed) {
    // Silent on the public site: a visitor cannot act on this, and a broken-embed notice
    // is worse than an absent block. Loud in the editor's preview, which is the one place
    // the person who can fix it is looking. Without this the failure was an empty box.
    if (!preview) return null;
    return (
      <section><Frame full={props.full_width}>
        <div className="border border-brand p-4 font-mono-x text-xs uppercase tracking-[0.2em] text-brand"
             data-testid="video-unsupported">
          Unsupported embed URL — YouTube, Vimeo, SoundCloud and Bandcamp only
          <div className="mt-1 normal-case tracking-normal text-ink-3">
            Bandcamp needs the URL from its own Share / Embed dialog, not the album page.
          </div>
          <div className="mt-2 normal-case tracking-normal text-ink-3 break-all">{props.url}</div>
        </div>
      </Frame></section>
    );
  }

  // A SoundCloud or Bandcamp player is a control strip, not a rectangle: forcing it into
  // aspect-video leaves a 16:9 box mostly empty. Audio providers are sized by height and
  // ignore the aspect control, which the panel hides for them.
  //
  // A playlist is not a track. SoundCloud's compact player is 166px, which is right for
  // one track and cuts a playlist off at its first row — the track list is the reason
  // someone embeds a playlist at all.
  const isAudio = AUDIO_PROVIDERS.has(embed.provider);
  const frameClass = isAudio ? "" : aspect;
  const frameStyle = isAudio ? { height: audioHeight(embed, props) } : undefined;

  return (
    <section><Frame full={props.full_width}>
      <div className={`${frameClass} border border-ink/10`} style={frameStyle}>
        {/* `sandbox` is the half a CSP cannot do: frame-src says which origins may be
            framed, this says what the frame may then do. allow-same-origin is required
            or the player cannot reach its own APIs; allow-top-navigation is deliberately
            absent, so an embed cannot redirect the page around the visitor. */}
        <iframe
          src={embed.src}
          title={props.caption || (isAudio ? "audio" : "video")}
          className="w-full h-full"
          data-provider={embed.provider}
          sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
          referrerPolicy="strict-origin-when-cross-origin"
          allow={`accelerometer; ${autoplay ? "autoplay; " : ""}clipboard-write; encrypted-media; gyroscope; picture-in-picture`}
          allowFullScreen
        />
      </div>
      {caption}
    </Frame></section>
  );
}

function CustomHTML({ props }) {
  // Second of two sanitization passes, not the only one. The server now cleans this
  // HTML on write with nh3 (backend/sanitize.py, audit M10) so the database never holds
  // a live payload and every consumer — email, API read, a future SSR pass — gets clean
  // markup. This pass stays as defence in depth, and because content stored before that
  // fix has never been through the server-side one.
  //
  // `svg: true` was removed: it widened the mXSS surface for a capability no block in
  // the set uses, and it made the two passes disagree about what is allowed. The
  // FORBID_TAGS/FORBID_ATTR lists went with it — they were redundant with DOMPurify's
  // defaults, so they read as the protection while doing none of the work, which is
  // worse than not being there.
  const safe = DOMPurify.sanitize(props.html || "", { USE_PROFILES: { html: true } });
  return <section><Frame full={props.full_width}><div dangerouslySetInnerHTML={{ __html: safe }} /></Frame></section>;
}

/**
 * A text panel that scrolls inside itself.
 *
 * The point is a box of a FIXED height holding text of any length: a manifesto, a long
 * credit list, terms nobody reads in full. The page keeps its shape and the words scroll
 * within the panel rather than pushing everything below them down the page.
 *
 * Its own scrollbar is deliberate and not hidden. The blocks that hide theirs — the nav,
 * the marquee — are ones where the overflow is incidental; here the overflow IS the
 * feature, and a scrollable box with no visible scrollbar is a box that looks truncated.
 *
 * Width is a choice rather than a consequence: narrow for a reading measure, normal for
 * the page frame, full to the edges. `align` moves the panel within its frame, which is
 * a different question from how the text inside it is aligned.
 */
const PANEL_WIDTHS = { narrow: "max-w-[640px]", normal: "max-w-[900px]", wide: "max-w-[1200px]" };
const PANEL_PLACE = { left: "mr-auto", center: "mx-auto", right: "ml-auto" };

function TextPanel({ props }) {
  // Validated before clamping, the way heroHeight does. `clampPx("abc")` is NaN, the
  // browser drops the style, and the panel silently loses its height — taking the
  // scrolling that is the entire point of the block with it.
  const raw = Number(props.height);
  const height = Number.isFinite(raw) ? clampPx(raw, { min: 80, max: 1200 }) : 320;
  const width = props.full_width ? "w-full" : (PANEL_WIDTHS[props.width] || PANEL_WIDTHS.normal);
  const place = PANEL_PLACE[props.align] || PANEL_PLACE.center;
  const textAlign = props.text_align === "center" ? "text-center"
    : props.text_align === "right" ? "text-right" : "text-left";

  return (
    <section>
      <Frame full={props.full_width}>
        {/* No border: the panel is a window onto text, not a boxed-off card. Vertical
            padding stays — it keeps the first and last lines off the scroll edges — but
            there is no horizontal padding, so the text lines up with every other block
            on the page instead of sitting in an unexplained 24px indent that used to be
            justified by a frame that is no longer drawn. */}
        <div className={`${width} ${place} ${textAlign} overflow-y-auto py-6 ${props.full_width ? "edge-inset" : ""}`}
             style={{ height }} data-testid="text-panel">
          {props.heading && (
            <h2 className="font-display text-2xl md:text-3xl uppercase tracking-tighter font-bold mb-4">
              {props.heading}
            </h2>
          )}
          {/* The same type as Rich text — `text-lg` and the same colour and leading —
              because the two blocks hold the same kind of prose and a reader should not
              be able to tell which one they are in. Rich text's `max-w-2xl` is
              deliberately NOT copied: that caps a line at 672px, which would quietly
              override this block's own Width control and make "wide" (1200px) render
              identically to "narrow". Width is this block's to decide. */}
          {renderRich(props.content, {
            paraClassName: "text-ink-2 text-lg leading-relaxed mt-4 first:mt-0",
            listClassName: "mt-4 space-y-1 text-ink-2 text-lg leading-relaxed",
          })}
        </div>
      </Frame>
    </section>
  );
}

function Spacer({ props }) { return <div style={{ height: props.height || "4rem" }} />; }

/**
 * Where a column of text sits horizontally, and how its lines are set.
 *
 * One map rather than the ternary chain each block used to carry its own copy of. The
 * items-* half matters as much as the text-* half: inside a flex column the children are
 * stretched by default, so a button in a centred column would still sit hard left.
 */
const TEXT_ALIGN = {
  left: "text-left items-start",
  center: "text-center items-center",
  right: "text-right items-end",
};
const textAlign = (props, fallback = "left") => TEXT_ALIGN[props.align] || TEXT_ALIGN[fallback];

/**
 * The size a Split-family heading renders at, in plain pixels per breakpoint.
 *
 * The same shape as `heroHeadingSize` and deliberately NOT the same function. Hero's
 * fallback is its old `l` step — 48/72px — and borrowing it here would resize every split
 * already published, because these headings have never had a size field at all: they were
 * `text-3xl md:text-5xl`, which is 30px and 48px. Those two numbers are the fallback, so
 * a block that has never been touched renders at exactly the size it always has.
 *
 * The LIMITS are shared with the hero on purpose. They are a sane range for a display
 * heading in pixels, and there is no reason for two blocks to disagree about it.
 */
const SPLIT_HEADING_FALLBACK = { mobile: 30, desktop: 48 };

export function splitHeadingSize(props) {
  const pick = (key) => {
    const raw = props[`heading_size_${key}`];
    if (raw === undefined || raw === null || raw === "" || Number.isNaN(Number(raw))) {
      return SPLIT_HEADING_FALLBACK[key];
    }
    return clampPx(raw, HERO_SIZE_LIMITS[key]);
  };
  return { mobile: pick("mobile"), desktop: pick("desktop") };
}

function Split({ props }) {
  const reverse = props.direction === "image-right";
  const size = splitHeadingSize(props);
  // Absent means the uppercase these headings have always been set in, the same bargain
  // `casing` makes everywhere else: an explicit value is a decision, absence is history.
  const upper = casing(props);
  /* "natural" is the new default and the reason the row is `items-stretch` below: the
     element takes the height of the photograph rather than cropping every photograph to
     one shape. A block published before this carries an explicit aspect and keeps it,
     and `aspectClass`'s own fallback is still the square those blocks were drawn at. */
  const natural = props.aspect === "natural";
  const aspect = natural ? "" : aspectClass(props.aspect, "aspect-square");
  const gap = splitGap(props);

  return (
    <section><Frame full={props.full_width}>
      {/* The column gap is a value, not a class, and only the COLUMN one: below `md` the
          two stack, and a gap of zero there would sit the words directly against the
          bottom of the photograph. The row gap stays at what `gap-10` always drew. */}
      <div className={`grid md:grid-cols-2 items-stretch ${reverse ? "md:[&>*:first-child]:order-2" : ""}`}
           style={{ columnGap: `${gap.column}px`, rowGap: "2.5rem" }}
           data-testid="split" data-gap={gap.column}>
        {/* The image is NOT inset: asked for explicitly, and it keeps the column edge.
            The hairline is the last thing standing between two of these and a chessboard —
            a 1px border on each photograph is a 2px seam where two tiles meet, in both
            directions. Absent means drawn, which is what every published block has. */}
        <div className={`${aspect} overflow-hidden ${props.hairline === false ? "" : "border border-ink/10"}`}
             data-testid="split-media">
          {props.image_url ? (
            <img src={mediaUrl(props.image_url)} alt=""
                 className={natural ? "w-full h-auto block" : "w-full h-full object-cover"} />
          ) : (
            <div className="w-full h-full min-h-[12rem] flex items-center justify-center text-ink-5 font-mono-x text-xs uppercase tracking-[0.3em]">Set image URL</div>
          )}
        </div>
        <EdgeInset full={props.full_width}>
          {/* The text's own box, full height so it has something to be aligned within.
              Without this the column had exactly the height of its words and top,
              middle and bottom all meant the same thing.

              The padding is what the gap gave up: at 40 the gap holds the words off the
              photograph and this is nothing, at 0 the tiles touch and this holds them off
              instead. Either way a line of text stops the same distance from the picture. */}
          <div className={`h-full flex flex-col ${contentY(props, "justify-center")} ${textAlign(props)} ${gap.padClass}`}
               style={{ "--column-pad": `${gap.pad}px` }}
               data-testid="split-text">
            {props.eyebrow && <div className={`font-mono-x text-xs ${upper} tracking-[0.3em] text-ink-4`}>{props.eyebrow}</div>}
            {props.heading && (
              <h2 className={`font-display hero-heading ${upper} font-bold tracking-tighter mt-2 whitespace-pre-wrap`}
                  style={{ "--hero-heading-mobile": `${size.mobile}px`, "--hero-heading-desktop": `${size.desktop}px` }}
                  data-testid="split-heading">
                {props.heading}
              </h2>
            )}
            {props.body && <div className="mt-4">{renderRich(props.body, { paraClassName: "text-ink-2 leading-relaxed" })}</div>}
            {props.cta_label && <Link to={props.cta_href || "#"} className="mt-6 inline-block btn-primary">{props.cta_label}</Link>}
          </div>
        </EdgeInset>
      </div>
    </Frame></section>
  );
}

/**
 * The longest a snippet plays before the player moves on, in seconds.
 *
 * A rule the PLAYER holds, not the upload. Trimming audio on the server would mean
 * ffmpeg, which is deliberately not a dependency anywhere in this app — the video block
 * captures its poster frame in the browser for the same reason. So a two-minute file can
 * be uploaded and the block will still play ninety seconds of it and move on, which is
 * the behaviour that was actually asked for: these are teasers, not tracks.
 */
export const AUDIO_TRACK_MAX_SECONDS = 90;

/** The `setPlaying` of whichever playlist on the page is sounding, so a second one can
 *  silence it before it starts. Reset by whoever takes over; see `stopOthers`. */
let nowPlaying = null;

/** m:ss, or "--:--" for a length nothing has measured yet. Exported because the CMS field
 *  prints the same numbers this player does, and two spellings of a clock would drift. */
export const fmtClock = (seconds) => {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};

/**
 * What a row prints for its length: the stored figure, or what the element has just told
 * us about the track it is actually playing.
 *
 * `measured` wins when there is one, because a clip that has loaded knows more than the
 * number saved beside it — a file replaced at the same URL would otherwise print the old
 * length for as long as the block goes un-edited.
 *
 * Capped, for the same reason the transport's readout is: the player stops at ninety
 * seconds, so ninety seconds is what a row promising a length should promise.
 */
function rowLength(track, measured) {
  const known = Number.isFinite(measured) ? measured : Number(track?.duration);
  if (!Number.isFinite(known) || known <= 0) return "";
  return fmtClock(Math.min(known, AUDIO_TRACK_MAX_SECONDS));
}

/**
 * A list of short clips with a transport, one playing at a time.
 *
 * ONE `<audio>` element for the whole list, not one per row. Two elements can play at
 * once, and a playlist whose second track starts over the top of the first is the bug this
 * shape makes impossible: switching tracks is switching the source of the single player,
 * so the previous one stops by construction.
 *
 * WHICH track is loaded and WHETHER it is playing are separate pieces of state, which is
 * what a transport needs and a bare list of toggles does not. With one combined value,
 * pausing has to mean "nothing is selected", so the controls have nothing to point at and
 * resuming would start the clip again from zero. Split apart, pause leaves the track
 * loaded at its position and the scrubber keeps working while stopped.
 *
 * The behaviours asked for map onto the handlers below. Pressing a row toggles it — the
 * same row pauses, a different row switches. `onEnded` steps to the next row and stops at
 * the end of the list rather than looping, which is what "until the end" means.
 * `onTimeUpdate` enforces the ninety-second cap by taking the same step early, and the
 * scrubber cannot be dragged past that cap either — a control that let you seek to 1:20 of
 * a clip that stops at 1:30 would be lying about what it will play.
 */
export function AudioPlaylist({ tracks }) {
  const list = (Array.isArray(tracks) ? tracks : []).filter((t) => t && t.url);
  const [current, setCurrent] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [duration, setDuration] = useState(null);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const audioRef = useRef(null);
  // Read by the load effect so it can start a newly chosen track without taking
  // `isPlaying` as a dependency, which would restart the clip on every pause and resume.
  const playingRef = useRef(false);
  playingRef.current = isPlaying;

  // Derived rather than kept in state, so the load effect has a dependency that is stable
  // across re-renders — `list` is rebuilt on every one of them.
  const currentUrl = list[current]?.url || null;

  const start = useCallback((el) => {
    // A browser can refuse — an autoplay policy, a file it cannot decode — and jsdom has
    // no media stack at all. Neither is worth throwing a render away for.
    try { el.play()?.catch(() => {}); } catch { /* no media support here */ }
  }, []);

  const advance = useCallback(() => {
    setCurrent((at) => {
      if (at + 1 < list.length) return at + 1;
      setIsPlaying(false);   // the end of the list stops rather than looping
      return at;
    });
  }, [list.length]);

  /* Loading a track. Separate from the play/pause effect below so that resuming continues
     from where it stopped instead of rewinding: setting `src` resets the position, and a
     single effect covering both would do it on every pause. */
  useEffect(() => {
    const el = audioRef.current;
    if (!el || !currentUrl) return;
    el.src = mediaUrl(currentUrl);
    setElapsed(0);
    setDuration(null);
    if (playingRef.current) {
      /* One player at a time on the whole PAGE, not merely within one block. A page can
         carry two of these, and starting the second while the first was running left both
         sounding at once — the same fault the single shared <audio> rules out inside a
         block, one level up. Module scope, because two sibling blocks share no state and
         there is only ever one pair of ears. */
      if (nowPlaying && nowPlaying !== setIsPlaying) nowPlaying(false);
      nowPlaying = setIsPlaying;
      start(el);
    }
  }, [currentUrl, start]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    if (!isPlaying) { el.pause(); return; }
    if (nowPlaying && nowPlaying !== setIsPlaying) nowPlaying(false);
    nowPlaying = setIsPlaying;
    start(el);
  }, [isPlaying, start]);

  useEffect(() => {
    const el = audioRef.current;
    if (el) { el.volume = volume; el.muted = muted; }
  }, [volume, muted]);

  const onTimeUpdate = (e) => {
    const at = e.currentTarget.currentTime;
    if (at >= AUDIO_TRACK_MAX_SECONDS) { advance(); return; }
    setElapsed(at);
  };

  const choose = (i) => {
    if (i === current) { setIsPlaying((on) => !on); return; }
    setCurrent(i);
    setIsPlaying(true);
  };

  const step = (by) => {
    const to = current + by;
    if (to < 0 || to >= list.length) return;
    setCurrent(to);
  };

  const seek = (to) => {
    const el = audioRef.current;
    setElapsed(to);
    if (el) el.currentTime = to;
  };

  if (!list.length) return null;

  /* What the scrubber runs against: the clip\'s own length, or the cap when the clip is
     longer than the cap — because the cap is where it will actually stop. */
  const span = Math.min(duration || AUDIO_TRACK_MAX_SECONDS, AUDIO_TRACK_MAX_SECONDS);
  const button = "shrink-0 w-8 h-8 border border-ink/20 hover:border-ink transition-colors flex items-center justify-center disabled:opacity-30 disabled:hover:border-ink/20";

  return (
    <div className="mt-8 border-t border-ink/10" data-testid="audio-playlist">
      <audio ref={audioRef} preload="none" onEnded={advance} onTimeUpdate={onTimeUpdate}
             onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
             onPlay={() => setIsPlaying(true)} onPause={() => setIsPlaying(false)}
             data-testid="audio-element" />

      {/* The transport. Text-left regardless of the block\'s own alignment: a row of
          controls that shifts to the right on a centred block reads as a mistake. */}
      <div className="py-4 text-left" data-testid="audio-transport">
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => step(-1)} disabled={current === 0}
                  aria-label="Previous track" data-testid="audio-prev" className={button}>
            <SkipBack size={12} />
          </button>
          <button type="button" onClick={() => setIsPlaying((on) => !on)}
                  aria-label={isPlaying ? "Pause" : "Play"} aria-pressed={isPlaying}
                  data-testid="audio-playpause" className={button}>
            {isPlaying ? <Pause size={13} /> : <Play size={13} />}
          </button>
          <button type="button" onClick={() => step(1)} disabled={current >= list.length - 1}
                  aria-label="Next track" data-testid="audio-next" className={button}>
            <SkipForward size={12} />
          </button>

          <span className="shrink-0 font-mono-x text-[10px] tracking-[0.2em] text-ink-4 tabular-nums"
                data-testid="audio-elapsed">{fmtClock(elapsed)}</span>
          {/* A range input rather than a styled div: it can be dragged, clicked anywhere
              along its length AND driven from the keyboard, none of which comes free with
              a bar and a mousedown handler. */}
          <input type="range" min={0} max={span} step={0.01} value={Math.min(elapsed, span)}
                 onChange={(e) => seek(Number(e.target.value))}
                 aria-label="Seek" data-testid="audio-seek"
                 className="flex-1 min-w-0 accent-[color:var(--accent)]" />
          <span className="shrink-0 font-mono-x text-[10px] tracking-[0.2em] text-ink-4 tabular-nums"
                data-testid="audio-duration">{fmtClock(span)}</span>

          <button type="button" onClick={() => setMuted((m) => !m)}
                  aria-label={muted ? "Unmute" : "Mute"} aria-pressed={muted}
                  data-testid="audio-mute" className={button}>
            {muted || volume === 0 ? <VolumeX size={12} /> : <Volume2 size={12} />}
          </button>
          <input type="range" min={0} max={1} step={0.01} value={muted ? 0 : volume}
                 onChange={(e) => { setVolume(Number(e.target.value)); setMuted(false); }}
                 aria-label="Volume" data-testid="audio-volume"
                 className="w-16 shrink-0 accent-[color:var(--accent)] hidden sm:block" />
        </div>
        <div className="mt-2 font-mono-x text-[10px] uppercase tracking-[0.25em] text-ink-4 truncate"
             data-testid="audio-now-playing">
          {list[current]?.title || `Track ${current + 1}`}
        </div>
      </div>

      <ul className="border-t border-ink/10">
        {list.map((track, i) => {
          const active = current === i && isPlaying;
          return (
            <li key={`${track.url}-${i}`} className="border-b border-ink/10 last:border-b-0">
              <button type="button" onClick={() => choose(i)}
                      aria-pressed={active} data-testid={`audio-track-${i}`}
                      className="group w-full flex items-center gap-3 py-3 text-left">
                <span className="shrink-0 w-8 h-8 border border-ink/20 group-hover:border-ink transition-colors flex items-center justify-center">
                  {active ? <Pause size={12} /> : <Play size={12} />}
                </span>
                <span className="shrink-0 font-mono-x text-[10px] tracking-[0.2em] text-ink-5 tabular-nums">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="flex-1 min-w-0">
                  <span className={`block font-mono-x text-[11px] uppercase tracking-[0.2em] truncate ${current === i ? "text-ink" : "text-ink-2"}`}>
                    {track.title || `Track ${i + 1}`}
                  </span>
                  {current === i && (
                    <span className="mt-1.5 block h-[2px] w-full bg-ink/10" data-testid="audio-progress">
                      <span className="block h-full bg-ink"
                            style={{ width: `${Math.min(100, (elapsed / span) * 100)}%` }} />
                    </span>
                  )}
                </span>
                {/* Every row's length, the way a record shop's player lists them — and
                    read from the block's own data, not from the network. The number was
                    measured once in the CMS when the clip was chosen (see
                    AudioTracksField), so a list of six costs six requests to nobody.

                    What is printed is what will PLAY, which for anything over the cap is
                    the cap rather than the file's own length: the transport says 1:30 and
                    a row claiming 5:29 beside it would be the one that is wrong. A track
                    whose length was never captured — pasted rather than uploaded, or
                    saved before this existed — simply shows nothing until it is played. */}
                {/* NOT `audio-track-N-something`: the rows are counted with a
                    `[data-testid^="audio-track-"]` prefix match, and a child sharing that
                    prefix is counted as a row of its own. */}
                <span className="shrink-0 font-mono-x text-[10px] tracking-[0.2em] text-ink-5 tabular-nums"
                      data-testid={`audio-length-${i}`}>
                  {rowLength(track, i === current ? duration : null)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The ratio slider's bounds. Not 0-100: a column at 5% is not a layout choice, it is a
 *  sliver with a cropped photograph in it, and the block below has no use for either end. */
export const SPLIT_RATIO_LIMITS = { min: 20, max: 80, fallback: 50 };
export const SPLIT_MAX_HEIGHT_LIMITS = { min: 200, max: 1400, fallback: 640 };

/**
 * The channel between the two columns. 40px is what `gap-10` has always drawn, so a block
 * that has never been touched keeps it.
 *
 * Zero is the interesting end and the reason this is a control at all: it is what lets two
 * stacked split blocks with opposite directions tile like a chessboard, the photograph in
 * one meeting the photograph in the next at the corner instead of across a permanent 40px
 * band. See `SPLIT_TEXT_BREATHING` for the half that keeps the words readable when it does.
 */
export const SPLIT_GAP_LIMITS = { min: 0, max: 80, fallback: 40 };

/** How close a line of text may come to the photograph beside it. Whatever the gap does
 *  not provide, the text column takes as padding on that side — so the tiles can touch
 *  while the words keep the same distance from the picture they always had. */
const SPLIT_TEXT_BREATHING = 40;

/**
 * The channel between the columns, and the padding the text needs to survive closing it.
 *
 * `reverse` says which side of the text column the photograph is on: image-left puts it to
 * the text's left, image-right to its right. Only that side is padded — padding the outer
 * edge would pull the text off the margin every other block on the page lines up with.
 */
function splitGap(props) {
  const column = bounded(props.gap, SPLIT_GAP_LIMITS);
  return {
    column,
    padClass: props.direction === "image-right" ? "column-pad-end" : "column-pad-start",
    pad: Math.max(0, SPLIT_TEXT_BREATHING - column),
  };
}

/** A number within its limits, or the default when there isn't one.
 *
 * The emptiness check is separate from `Number.isFinite` and has to be: `Number("")` is
 * 0, which is perfectly finite, so a cleared field would clamp to the FLOOR — a 200px
 * cap on a photograph nobody asked to shrink — rather than falling back to the default.
 * `heroHeight` guards the same way for the same reason. */
const bounded = (value, limits) => {
  if (value === undefined || value === null || value === "") return limits.fallback;
  const raw = Number(value);
  return Number.isFinite(raw) ? clampPx(raw, limits) : limits.fallback;
};

/**
 * How much of its own half an element fills, when the join between the two is pinned to
 * the centre of the block.
 *
 * The larger side fills its half; the smaller one takes the same fraction of a half that
 * it has of the pair. At 50/50 both fill their halves and the block is edge to edge, which
 * is exactly what it does without this. Off 50 the shortfall lands at the outer edge.
 *
 * 70/30, in a 1000px block: the photograph fills its 500, and the text takes 30/70 of the
 * other 500 — 214px against the join, with 286px of margin beyond it.
 */
export const shareOfHalf = (mine, other) => (mine >= other ? 100 : (mine / other) * 100);

/**
 * Split's layout with the far column cut in two: words above, short clips below.
 *
 * Three things separate it from Split, and all three were asked for by name.
 *
 *   THE RATIO IS A SLIDER. Split is two equal columns forever. Here the photograph can
 *   take a third of the width or two thirds of it. At 50 the two halves meet exactly at
 *   the middle of the block, which is the "image central" case — it needs no special
 *   handling because an even grid already does it.
 *
 *   THE PHOTOGRAPH HAS NO HAIRLINE. Split draws a border around its image column; this
 *   one does not, so the picture sits on the page rather than in a box.
 *
 *   IT TAKES THE PHOTOGRAPH'S HEIGHT, up to a cap. `h-auto` lets the image keep its own
 *   proportions and the grid row grows to fit it; `max-height` stops a very tall portrait
 *   from running the block off the screen. Once the cap bites, both dimensions of the
 *   image box are definite, which is exactly when `object-fit: cover` starts applying —
 *   so past the cap the photograph is cropped rather than squashed.
 */
function SplitAudio({ props }) {
  const reverse = props.direction === "image-right";
  const size = splitHeadingSize(props);
  const upper = casing(props);
  const maxHeight = bounded(props.max_height, SPLIT_MAX_HEIGHT_LIMITS);
  const ratio = bounded(props.ratio, SPLIT_RATIO_LIMITS);
  const gap = splitGap(props);

  /* Where the join between the two sits.
   *
   * OFF, the ratio sizes the tracks themselves, so the join lands wherever the ratio put
   * it — 70/30 joins at 70% across.
   *
   * ON, the tracks are equal halves and the ratio decides how much of its half each side
   * fills, so the join stays on the centre line at every ratio and the shortfall becomes
   * margin at the outer edge. Absent means off, so nothing published moves; new blocks
   * are created with it on.
   *
   * Fractions rather than percentages either way, and set as CSS variables rather than
   * inline `grid-template-columns`. Percentages would not leave room for the gap; an
   * inline value would beat the `md:` breakpoint and split a phone screen into two thin
   * columns. See `.column-ratio` and `.seam-share` in index.css — the same trick
   * `.hero-heading` uses, and for the same reason: a media query cannot be written
   * inline. Reversing swaps the tracks as well as the order, or the photograph would move
   * into the column sized for the text. */
  const centred = !!props.center_seam;
  const columns = centred ? [50, 50] : reverse ? [100 - ratio, ratio] : [ratio, 100 - ratio];

  /* The gap is the text's indentation from the join, and it is why the two sides are
     given their share rather than being butted together: the photograph stops at the
     centre line, and the words start 40px the other side of it. */
  const shares = centred
    ? { image: shareOfHalf(ratio, 100 - ratio), text: shareOfHalf(100 - ratio, ratio) }
    : { image: 100, text: 100 };

  /** The element sitting in the LEFT half has to be pushed across to meet the join; the
   *  one in the right half already starts there. Which is which follows `direction`. */
  const share = (part, inLeftHalf) => ({
    className: centred ? `seam-share ${inLeftHalf ? "seam-share-end" : ""}` : "",
    style: centred ? { "--seam-share": `${shares[part]}%` } : undefined,
  });
  const image = share("image", !reverse);
  const text = share("text", reverse);

  return (
    <section><Frame full={props.full_width}>
      <div className={`grid items-stretch column-ratio ${reverse ? "md:[&>*:first-child]:order-2" : ""}`}
           style={{ "--column-ratio-a": `${columns[0]}fr`, "--column-ratio-b": `${columns[1]}fr`,
                    columnGap: `${gap.column}px`, rowGap: "2.5rem" }}
           data-testid="split-audio" data-ratio={ratio} data-centred={centred ? "true" : "false"}
           data-gap={gap.column}>
        {/* No border and not inset: the photograph reaches the edge of its column, and of
            the screen when the block is full width. */}
        <div className={`overflow-hidden ${image.className}`} style={image.style}
             data-testid="split-audio-media">
          {props.image_url ? (
            <img src={mediaUrl(props.image_url)} alt=""
                 className="w-full h-auto object-cover block"
                 style={{ maxHeight: `${maxHeight}px` }}
                 data-testid="split-audio-image" />
          ) : (
            <div className="w-full h-full min-h-[12rem] flex items-center justify-center text-ink-5 font-mono-x text-xs uppercase tracking-[0.3em]">Set image URL</div>
          )}
        </div>
        {/* The share wrapper is the grid child, so `h-full` has to be handed down to the
            inset as well — a percentage height resolves against the box above it, and
            without this the column inside would collapse to the height of its words. */}
        <div className={text.className} style={text.style} data-testid="split-audio-column">
        <EdgeInset full={props.full_width} className="h-full">
          {/* The column is as tall as the photograph beside it. The words take whatever is
              left above the player and are placed within it — which is what top, middle
              and bottom mean here — and the player sits at the bottom of the column. */}
          <div className="h-full flex flex-col">
            <div className={`flex-1 flex flex-col ${contentY(props, "justify-center")} ${textAlign(props)} ${gap.padClass}`}
                 style={{ "--column-pad": `${gap.pad}px` }}
                 data-testid="split-audio-text">
              {props.eyebrow && <div className={`font-mono-x text-xs ${upper} tracking-[0.3em] text-ink-4`}>{props.eyebrow}</div>}
              {props.heading && (
                <h2 className={`font-display hero-heading ${upper} font-bold tracking-tighter mt-2 whitespace-pre-wrap`}
                    style={{ "--hero-heading-mobile": `${size.mobile}px`, "--hero-heading-desktop": `${size.desktop}px` }}
                    data-testid="split-audio-heading">
                  {props.heading}
                </h2>
              )}
              {props.body && <div className="mt-4">{renderRich(props.body, { paraClassName: "text-ink-2 leading-relaxed" })}</div>}
              {(props.cta_label || props.second_cta_label) && (
                <div className="mt-6 flex flex-wrap gap-3">
                  {props.cta_label && (
                    <Link to={props.cta_href || "#"} data-testid="split-audio-cta"
                          className={props.cta_style === "accent" ? "btn-accent" : "btn-primary"}>{props.cta_label}</Link>
                  )}
                  {props.second_cta_label && (
                    <Link to={props.second_cta_href || "#"} data-testid="split-audio-cta-2"
                          className="btn-primary">{props.second_cta_label}</Link>
                  )}
                </div>
              )}
            </div>
            <AudioPlaylist tracks={props.tracks} />
          </div>
        </EdgeInset>
        </div>
      </div>
    </Frame></section>
  );
}

/**
 * An image-backed band for the middle of a page.
 *
 * Deliberately not the Hero. Hero is the top of a page: it fills the viewport, its
 * heading is the h1, and it defaults to edge-to-edge. This sits inline at a fraction of
 * that height with an h2, so a page can carry several without each one claiming to be
 * the page's subject.
 *
 * The overlay is a plain colour and opacity, with none of Hero's three named modes.
 * Those exist there only to keep heroes published before the overlay controls looking
 * as they did; a new block has no such history and does not need to carry it.
 *
 * Its text inset is internal padding rather than block spacing, which is why it survives
 * the zeroing described on Container: with none, the heading would sit against the edge
 * of its own background image, and a Spacer between blocks could not put it back.
 */
/** The most of its spare height the photo will use up drifting. Under 1 so the movement
 *  eases off before it reaches an edge rather than stopping dead against one. */
const PARALLAX_TRAVEL = 0.8;

/**
 * The photo behind a band, drifting as the page scrolls.
 *
 * NOT `background-attachment: fixed`, which is what this replaces and which was wrong in
 * two ways that both trace to the same rule: a fixed background's positioning area is
 * the VIEWPORT, not the element.
 *
 *   IT ZOOMED. `cover` sized the photo to cover the viewport's full height while the
 *   band showed a window 45vh tall, so the image arrived blown up — measured at 1.72x on
 *   a 981x505 band in a 989x1123 viewport. And it could not be fixed by choosing a
 *   smaller background-size: a viewport-pinned image MUST cover the viewport, or a band
 *   sitting anywhere else on screen would show gaps. The zoom was the price of the
 *   technique, not a mistake in using it.
 *
 *   IT WAS INVISIBLE ON PHONES. iOS Safari and most mobile browsers ignore the property
 *   outright, so the band had to hide the photo below md and collapsed to a flat colour.
 *
 * An ordinary <img> sized to cover the band has neither problem. It is drawn slightly
 * taller than the band and translated by a fraction of the band's progress across the
 * viewport, which is the drift the effect was for. The overscan is usually free: a photo
 * wider than the band is already width-limited, so making the box 24% taller does not
 * scale it at all.
 */
function ParallaxPhoto({ src, alt = "" }) {
  const frameRef = useRef(null);
  const imgRef = useRef(null);
  const [drift, setDrift] = useState(0);

  /* The photo is fitted to the band's WIDTH and left at its own aspect, with a floor of
   * the band's height. A landscape photo in a wide band therefore comes out taller than
   * it needs to be, and that surplus — not a fixed percentage — is the room it drifts
   * in. Movement is bought with height the image already had, so the scale never rises
   * above a plain cover.
   *
   * The alternative, drawing it a fixed 24% taller, costs 24% zoom exactly when the band
   * is too narrow to supply the surplus for free: measured at 1.24x on a 375x365 phone
   * band. A still photograph correctly framed beats a moving one that is too big, so
   * where there is no surplus there is no drift. */
  const measure = useCallback(() => {
    const el = frameRef.current;
    const img = imgRef.current;
    if (!el || !img) return;
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight || 0;
    if (!vh || !r.height) return;

    const surplus = Math.max(0, (img.offsetHeight - r.height) / 2);
    if (!surplus) { setDrift(0); return; }

    // -1 as the band enters from below, +1 once it has left above. The band's own height
    // is in the denominator so a tall band drifts across the same span as a short one.
    const travel = (vh + r.height) / 2;
    const progress = ((vh / 2) - (r.top + r.height / 2)) / travel;
    const clamped = Math.max(-1, Math.min(1, progress));
    setDrift(clamped * surplus * PARALLAX_TRAVEL);
  }, []);

  useEffect(() => {
    // Someone who has asked for less motion gets a still photograph, correctly framed —
    // which is the half of this that matters.
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (reduced?.matches) return undefined;

    let queued = false;
    const onScroll = () => {
      if (queued) return;
      queued = true;
      window.requestAnimationFrame(() => { queued = false; measure(); });
    };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [measure]);

  return (
    <div ref={frameRef} className="absolute inset-0 overflow-hidden" data-testid="image-band-fixed">
      {/* h-auto keeps the photo's own proportions so any surplus height is real rather
          than invented; min-h-full is the floor that stops a wide panorama leaving a gap,
          and object-cover crops rather than stretches when that floor is what applies. */}
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        onLoad={measure}
        data-testid="image-band-parallax-img"
        className="absolute left-0 top-1/2 w-full h-auto min-h-full max-w-none object-cover will-change-transform"
        style={{ transform: `translate3d(0, calc(-50% + ${drift}px), 0)` }}
      />
    </div>
  );
}

/**
 * The page's backdrop: one photograph behind everything else on it.
 *
 * Pinned rather than scrolling, so a long page keeps one image rather than dragging a
 * very tall one past the reader. `sticky` and not `fixed`, which matters more than it
 * sounds:
 *
 *   A `fixed` element is positioned against the VIEWPORT, so inside the CMS preview —
 *   a scrolling panel occupying part of the screen — it would break out and cover the
 *   whole editor, including the controls being used to edit it. Sticky is positioned
 *   against its scrolling ancestor, which is the page on a live page and the preview
 *   panel inside the editor, so one implementation is right in both.
 *
 * The negative margin is what keeps it OUT of the layout: a full-height element in
 * normal flow would push every block down by a screenful. Taking that height back
 * leaves the following blocks starting where they otherwise would, painting over it.
 *
 * It is NOT put behind the content with a negative z-index, which is the obvious way and
 * does not work here: a negative-z child paints above its stacking context's own
 * background but still below every in-flow block box, and this app wraps its pages in an
 * opaque `.App` div. The backdrop went behind that and vanished. So DynamicPage places
 * the two instead — this layer at z-0, the blocks above it at z-10 — which puts both in
 * the positioned painting step, above any ancestor's background.
 */
function PageBackground({ props, preview }) {
  const opacity = Math.min(100, Math.max(0, Number(props.overlay_opacity ?? 40))) / 100;
  const full = props.full_frame !== false;

  const layers = (
    <div className={full ? "relative w-full h-full" : "relative w-full h-full max-w-[1400px] mx-auto"}>
      {props.image_url ? (
        <img src={mediaUrl(props.image_url)} alt="" data-testid="page-background-img"
             className="absolute inset-0 w-full h-full object-cover" />
      ) : null}
      {/* Drawn even with no photo: the colour alone is a legitimate backdrop, and an
          editor who sets the overlay first should see something happen. */}
      <div className="absolute inset-0" data-testid="page-background-overlay"
           style={{ backgroundColor: props.overlay_color || "#050505", opacity }} />
    </div>
  );

  /* In the editor it is a band you can see and click, not the real backdrop.
   *
   * The preview renders one block per row, each in its own wrapper, so a sticky
   * full-height layer would have a zero-height containing block to stick inside and would
   * cover the blocks after it rather than sitting under them. Showing it as itself keeps
   * it selectable and shows the photo and overlay being chosen; "View live" shows the
   * composite. A band that lied about where it sits would be worse than one that is
   * plainly a stand-in. */
  if (preview) {
    return (
      <div className="relative h-56 overflow-hidden border border-dashed border-ink/25"
           data-testid="page-background-preview">
        {layers}
        <div className="absolute inset-x-0 bottom-0 p-2 font-mono-x text-[9px] uppercase tracking-[0.2em] text-ink-2 bg-scrim/70">
          Page background — every other block sits on top of this
        </div>
      </div>
    );
  }

  return (
    <div className="sticky top-0 h-screen -mb-[100vh] z-0 overflow-hidden pointer-events-none"
         data-testid="page-background" aria-hidden="true">
      {layers}
    </div>
  );
}

function ImageBand({ props }) {
  const h = props.height === "short" ? "min-h-[30vh]"
    : props.height === "tall" ? "min-h-[60vh]"
    : "min-h-[45vh]";
  const align = props.align === "center" ? "text-center items-center"
    : props.align === "right" ? "text-right items-end"
    : "text-left items-start";
  const upper = casing(props);
  const opacity = Math.min(100, Math.max(0, Number(props.overlay_opacity ?? 50))) / 100;
  /* Only the still photograph takes a focal point. The parallax one is drawn at the
     band's full width with its own height left free — there is no horizontal overflow
     for `object-position` to choose from, so the control would be a dead one there. */
  const objectPosition = mobileFocus(props, useIsMobileViewport());

  const inner = (
    <div className={`relative overflow-hidden ${h} flex flex-col ${contentY(props, "justify-center")}`} data-testid="image-band">
      {props.image_url && (
        // One photograph either way; the toggle only decides whether it moves. See
        // ParallaxPhoto for why this is no longer a fixed background.
        props.fixed_bg ? (
          <>
            <ParallaxPhoto src={mediaUrl(props.image_url)} />
            <div className="absolute inset-0"
                 style={{ backgroundColor: props.overlay_color || "#050505", opacity }}
                 data-testid="image-band-overlay" />
          </>
        ) : (
          <div className="absolute inset-0">
            <img src={mediaUrl(props.image_url)} alt="" className="w-full h-full object-cover"
                 style={{ objectPosition }} data-testid="image-band-image" />
            <div className="absolute inset-0"
                 style={{ backgroundColor: props.overlay_color || "#050505", opacity }}
                 data-testid="image-band-overlay" />
          </div>
        )
      )}
      {/* No max-w on the text. It was capped at 4xl for the heading and xl for the body,
          so on a wide band a line broke less than halfway across and the rest of the
          photograph sat empty beside it — the words looked pasted onto a corner rather
          than set on the image. The safe area IS the Container's padding; inside it the
          text is free to use the full measure. */}
      <Container className="relative py-16 md:py-24">
        <div className={`flex flex-col w-full ${align}`}>
          {props.eyebrow && <div className={`font-mono-x text-xs ${upper} tracking-[0.3em] text-ink-3 mb-4`}>{props.eyebrow}</div>}
          {props.heading && (
            <h2 className={`font-display text-4xl md:text-6xl ${upper} tracking-tighter font-bold w-full whitespace-pre-wrap`}
                data-testid="image-band-heading">
              {props.heading}
            </h2>
          )}
          {props.body && <div className="mt-6 w-full">{renderRich(props.body, { paraClassName: "text-ink-2 leading-relaxed text-lg" })}</div>}
          {props.cta_label && (
            <div className="mt-8">
              <Link to={props.cta_href || "#"} className={props.cta_style === "accent" ? "btn-accent" : "btn-primary"}>{props.cta_label}</Link>
            </div>
          )}
        </div>
      </Container>
    </div>
  );

  // Same bargain the Image block's "Full width" makes: on, it spans the viewport; off,
  // it is held inside the 1400px frame everything else lines up with.
  if (props.full_width !== false) return <section>{inner}</section>;
  return <section><div className="max-w-[1400px] mx-auto border border-ink/10">{inner}</div></section>;
}

export const BLOCK_RENDERERS = {
  hero: Hero,
  rich_text: RichText,
  image: ImageBlock,
  gallery_grid: GalleryGrid,
  events_grid: EventsGrid,
  artists_grid: ArtistsGrid,
  marquee: Marquee,
  contact_form: ContactFormBlock,
  newsletter: Newsletter,
  video: VideoEmbed,
  image_band: ImageBand,
  _background: PageBackground,
  text_panel: TextPanel,
  custom_html: CustomHTML,
  spacer: Spacer,
  split: Split,
  split_audio: SplitAudio,
};

/** `preview` marks the CMS editor's live preview, where an authoring mistake should be
 *  shouted about. The public site passes nothing and stays quiet. */
export function BlockRenderer({ block, preview = false }) {
  if (!block || block.enabled === false) return null;
  const R = BLOCK_RENDERERS[block.type];
  if (!R) {
    /* The same bargain the unsupported-embed notice makes, and it started mattering the
       day a block type was RETIRED: every page still holding a `cta_banner` printed
       "Unknown block: cta_banner" at its visitors, who can neither read that as English
       nor do anything about it. Silent on the public site, loud in the editor's preview —
       the one place the person who can delete the block is looking. */
    if (!preview) return null;
    return (
      <div className="p-6 border border-dashed border-ink/10 text-ink-4 font-mono-x text-xs uppercase"
           data-testid="unknown-block">
        Unknown block: {block.type} — retired. Delete it; visitors see nothing here.
      </div>
    );
  }
  return <R props={block.props || {}} preview={preview} />;
}

// Silence linter about unused imports on QR (kept for future custom blocks).
export const _QR = QRCodeCanvas;
