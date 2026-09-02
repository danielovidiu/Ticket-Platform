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
import { Camera } from "lucide-react";

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
  return <div className={`w-full max-w-[1400px] mx-auto px-6 md:px-10 ${className}`}>{children}</div>;
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
  // The consequence is real and is the editor's to make: a text block set full width puts
  // its prose against the screen edge. That is why the cap is the default.
  if (full) return <div className={`w-full ${className}`}>{children}</div>;
  const measure = narrow ? "max-w-[900px]" : "max-w-[1400px]";
  return <div className={`w-full mx-auto px-6 md:px-10 ${measure} ${className}`}>{children}</div>;
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

  const media = props.image_url && (
    <div className="absolute inset-0">
      <img src={mediaUrl(props.image_url)} alt="" className="w-full h-full object-cover" />
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
  return <section><Frame full={props.full_width} narrow>{renderRich(props.content)}</Frame></section>;
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
      {props.heading && <h2 className="font-display text-3xl md:text-5xl uppercase font-bold tracking-tighter mb-8">{props.heading}</h2>}
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
      <div className="flex items-end justify-between mb-10">
        <div>
          {props.eyebrow && <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-ink-4">{props.eyebrow}</div>}
          {props.heading && <h2 className="font-display text-4xl md:text-6xl uppercase font-bold tracking-tighter mt-2">{props.heading}</h2>}
        </div>
        <Link to="/events" className="btn-primary">All events</Link>
      </div>
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

/** Every part of this is authored now. The left column used to be the literal string
 * "CTA" in the markup, and there was no image at all — so the one block whose whole job
 * is to convert was the least configurable one in the CMS. */
function CTABanner({ props }) {
  const upper = casing(props);
  return (
    <section><Frame full={props.full_width}>
      <div className="grid md:grid-cols-2 gap-10 items-start">
        {props.image_url ? (
          <img src={mediaUrl(props.image_url)} alt={props.heading || ""}
               className="w-full object-cover border border-ink/10" data-testid="cta-image" />
        ) : (
          <div className={`font-mono-x text-xs ${upper} tracking-[0.3em] text-ink-4`}>{props.eyebrow ?? "CTA"}</div>
        )}
        <div>
          {props.image_url && props.eyebrow && (
            <div className={`font-mono-x text-xs ${upper} tracking-[0.3em] text-ink-4 mb-4`}>{props.eyebrow}</div>
          )}
          {props.heading && (
            <p className={`font-display text-3xl md:text-5xl ${upper} tracking-tighter leading-tight whitespace-pre-wrap`}
               data-testid="cta-heading">{props.heading}</p>
          )}
          {props.body && <div className="mt-4 max-w-lg">{renderRich(props.body, { paraClassName: "text-ink-3" })}</div>}
          {props.cta_label && (
            <Link to={props.cta_href || "#"}
                  className={`mt-8 inline-block ${props.cta_style === "accent" ? "btn-accent" : "btn-primary"}`}
                  data-testid="cta-button">{props.cta_label}</Link>
          )}
        </div>
      </div>
    </Frame></section>
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
      {props.heading && <h2 className="font-display text-3xl md:text-5xl uppercase font-bold tracking-tighter">{props.heading}</h2>}
      <form onSubmit={submit} className="border border-ink/10 bg-[color:var(--surface,#0F0F0F)] p-6 md:p-8 space-y-4 mt-6">
        <input required placeholder="NAME" value={f.name} onChange={(e) => setF({...f, name: e.target.value})} className="input-x" />
        <input required type="email" placeholder="EMAIL" value={f.email} onChange={(e) => setF({...f, email: e.target.value})} className="input-x" />
        <textarea required rows={5} placeholder="MESSAGE" value={f.message} onChange={(e) => setF({...f, message: e.target.value})} className="input-x" />
        <button disabled={busy} className="btn-accent w-full">{busy ? "SENDING…" : "SEND"}</button>
      </form>
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
      {props.heading && <h2 className="font-display text-3xl md:text-4xl uppercase font-bold tracking-tighter">{props.heading}</h2>}
      {/* Rich text, like every other multi-line body field — this one rendered inline,
          so an author's line breaks were dropped in this block and kept in the next. */}
      {props.body && <div className="mt-3">{renderRich(props.body, { paraClassName: "text-ink-3" })}</div>}
      <form onSubmit={submit} className="mt-6 flex gap-3 flex-wrap">
        <input required type="email" placeholder="you@domain.com" value={email} onChange={(e) => setEmail(e.target.value)} className="input-x flex-1 min-w-[240px]" data-testid="newsletter-email" />
        <button disabled={busy} className="btn-accent" data-testid="newsletter-submit">{busy ? "…" : (props.cta_label || "Subscribe")}</button>
      </form>
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
  const caption = props.caption
    ? <div className="mt-2 font-mono-x text-xs uppercase tracking-[0.25em] text-ink-4">{props.caption}</div>
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
        <div className={`${width} ${place} ${textAlign} overflow-y-auto border border-ink/10 p-6`}
             style={{ height }} data-testid="text-panel">
          {props.heading && (
            <h2 className="font-display text-2xl md:text-3xl uppercase tracking-tighter font-bold mb-4">
              {props.heading}
            </h2>
          )}
          {renderRich(props.content, { paraClassName: "text-ink-2 leading-relaxed mt-4 first:mt-0" })}
        </div>
      </Frame>
    </section>
  );
}

function Spacer({ props }) { return <div style={{ height: props.height || "4rem" }} />; }

function Split({ props }) {
  const reverse = props.direction === "image-right";
  return (
    <section><Frame full={props.full_width}>
      <div className={`grid md:grid-cols-2 gap-10 items-center ${reverse ? "md:[&>*:first-child]:order-2" : ""}`}>
        <div className={`${aspectClass(props.aspect, "aspect-square")} overflow-hidden border border-ink/10`}>
          {props.image_url ? <img src={mediaUrl(props.image_url)} alt="" className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center text-ink-5 font-mono-x text-xs uppercase tracking-[0.3em]">Set image URL</div>}
        </div>
        <div>
          {props.eyebrow && <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-ink-4">{props.eyebrow}</div>}
          {props.heading && <h2 className="font-display text-3xl md:text-5xl uppercase font-bold tracking-tighter mt-2">{props.heading}</h2>}
          {props.body && <div className="mt-4">{renderRich(props.body, { paraClassName: "text-ink-2 leading-relaxed" })}</div>}
          {props.cta_label && <Link to={props.cta_href || "#"} className="mt-6 inline-block btn-primary">{props.cta_label}</Link>}
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
            <img src={mediaUrl(props.image_url)} alt="" className="w-full h-full object-cover" />
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
  cta_banner: CTABanner,
  contact_form: ContactFormBlock,
  newsletter: Newsletter,
  video: VideoEmbed,
  image_band: ImageBand,
  _background: PageBackground,
  text_panel: TextPanel,
  custom_html: CustomHTML,
  spacer: Spacer,
  split: Split,
};

/** `preview` marks the CMS editor's live preview, where an authoring mistake should be
 *  shouted about. The public site passes nothing and stays quiet. */
export function BlockRenderer({ block, preview = false }) {
  if (!block || block.enabled === false) return null;
  const R = BLOCK_RENDERERS[block.type];
  if (!R) return <div className="p-6 border border-dashed border-ink/10 text-ink-4 font-mono-x text-xs uppercase">Unknown block: {block.type}</div>;
  return <R props={block.props || {}} preview={preview} />;
}

// Silence linter about unused imports on QR (kept for future custom blocks).
export const _QR = QRCodeCanvas;
