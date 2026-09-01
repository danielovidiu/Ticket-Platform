import { useEffect, useState } from "react";
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

/** Tailwind-safe aspect utility from a friendly ratio label. */
const ASPECTS = {
  "1:1": "aspect-square",
  "4:3": "aspect-[4/3]",
  "3:4": "aspect-[3/4]",
  "16:9": "aspect-video",
  "21:9": "aspect-[21/9]",
  "3:2": "aspect-[3/2]",
  "16:10": "aspect-[16/10]",
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
 * The HORIZONTAL gutters stay. They are not spacing between blocks — they are what keeps
 * text off the edge of a phone screen, and Spacer only has a height, so there would be
 * nothing to restore them with.
 *
 * Two insets survive on purpose and are not inter-block spacing: the hero's text inset
 * over its own background image, and the "Image not set" editor placeholder.
 */
function Container({ children, className = "" }) {
  return <div className={`max-w-[1400px] mx-auto px-6 md:px-10 ${className}`}>{children}</div>;
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
const overlayMode = (props) => (props.overlay === undefined ? "gradient" : props.overlay === true ? "solid" : props.overlay || "none");

function Hero({ props }) {
  const h = props.height === "short" ? "min-h-[50vh]" : props.height === "medium" ? "min-h-[70vh]" : "min-h-[85vh]";
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
    <Container className="relative pb-16 md:pb-24">
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
  if (fullFrame) {
    return <section className={`relative overflow-hidden ${h} flex flex-col justify-end`} data-testid="hero">{media}{body}</section>;
  }
  return (
    <section data-testid="hero">
      <div className={`max-w-[1400px] mx-auto relative overflow-hidden ${h} flex flex-col justify-end border border-ink/10`}>
        {media}{body}
      </div>
    </section>
  );
}

function RichText({ props }) {
  return <section><Container className="max-w-[900px]">{renderRich(props.content)}</Container></section>;
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
    <section><Container>
      {props.heading && <h2 className="font-display text-3xl md:text-5xl uppercase font-bold tracking-tighter mb-8">{props.heading}</h2>}
      <div className="columns-1 md:columns-3 gap-4 space-y-4">
        {items.map((g) => (
          <figure key={g.gallery_id} className="break-inside-avoid border border-ink/10">
            <img src={mediaUrl(g.image_url)} alt={g.caption} className="w-full block" />
          </figure>
        ))}
      </div>
    </Container></section>
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
    <section><Container>
      <div className="flex items-end justify-between mb-10">
        <div>
          {props.eyebrow && <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-ink-4">{props.eyebrow}</div>}
          {props.heading && <h2 className="font-display text-4xl md:text-6xl uppercase font-bold tracking-tighter mt-2">{props.heading}</h2>}
        </div>
        <Link to="/events" className="btn-primary hidden md:inline">All events</Link>
      </div>
      <div className={`grid grid-cols-1 ${cols} gap-6 items-stretch`}>
        {events.map((e) => {
          const hasAlbum = e.gallery && e.gallery.length > 0;
          // The first album's chosen cover, not just the first photo the event owns —
          // an album carries an explicit cover now, and this card is a tile for it.
          const cover = hasAlbum ? (e.albums?.[0]?.cover || e.gallery[0]) : null;
          return (
            <div key={e.event_id} className="group flex flex-col h-full border border-ink/10 bg-surface hover:border-ink transition-colors">
              {hasAlbum ? (
                <button onClick={() => openAlbum(e)} data-testid={`events-grid-cover-${e.slug}`} className="aspect-[16/10] overflow-hidden relative block w-full text-left shrink-0">
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
                <Link to={`/events/${e.slug}`} className="aspect-[16/10] overflow-hidden block shrink-0">
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
    </Container></section>
  );
}

function ArtistsGrid({ props }) {
  const [artists, setArtists] = useState([]);
  useEffect(() => { http.get("/artists").then((r) => setArtists(r.data.slice(0, props.limit || 6))).catch(() => {}); }, [props.limit]);
  const cols = props.layout === "grid-2" ? "md:grid-cols-2" : props.layout === "grid-4" ? "md:grid-cols-4" : "md:grid-cols-3";
  return (
    <section><Container>
      <div className="flex items-end justify-between mb-10">
        <div>
          {props.eyebrow && <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-ink-4">{props.eyebrow}</div>}
          {props.heading && <h2 className="font-display text-4xl md:text-6xl uppercase font-bold tracking-tighter mt-2">{props.heading}</h2>}
        </div>
        <Link to="/artists" className="btn-primary hidden md:inline">All artists</Link>
      </div>
      <div className={`grid grid-cols-2 ${cols} gap-4`}>
        {artists.map((a) => (
          <Link key={a.artist_id} to={`/artists/${a.slug}`} className="group block border border-ink/10">
            <div className={`${aspectClass(props.card_aspect, "aspect-square")} overflow-hidden`}><img src={mediaUrl(a.image_url)} alt={a.name} className="w-full h-full object-cover grayscale group-hover:grayscale-0 transition duration-500" /></div>
            <div className="p-4"><div className="font-display uppercase font-semibold">{a.name}</div></div>
          </Link>
        ))}
      </div>
    </Container></section>
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
  return (
    <section className="hairline-b hairline overflow-hidden">
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
    <section><Container>
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
    </Container></section>
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
    <section><Container className="max-w-[900px]">
      {props.heading && <h2 className="font-display text-3xl md:text-5xl uppercase font-bold tracking-tighter">{props.heading}</h2>}
      <form onSubmit={submit} className="border border-ink/10 bg-[color:var(--surface,#0F0F0F)] p-6 md:p-8 space-y-4 mt-6">
        <input required placeholder="NAME" value={f.name} onChange={(e) => setF({...f, name: e.target.value})} className="input-x" />
        <input required type="email" placeholder="EMAIL" value={f.email} onChange={(e) => setF({...f, email: e.target.value})} className="input-x" />
        <textarea required rows={5} placeholder="MESSAGE" value={f.message} onChange={(e) => setF({...f, message: e.target.value})} className="input-x" />
        <button disabled={busy} className="btn-accent w-full">{busy ? "SENDING…" : "SEND"}</button>
      </form>
    </Container></section>
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
    <section className="hairline"><Container className="max-w-[900px]">
      {props.heading && <h2 className="font-display text-3xl md:text-4xl uppercase font-bold tracking-tighter">{props.heading}</h2>}
      {/* Rich text, like every other multi-line body field — this one rendered inline,
          so an author's line breaks were dropped in this block and kept in the next. */}
      {props.body && <div className="mt-3">{renderRich(props.body, { paraClassName: "text-ink-3" })}</div>}
      <form onSubmit={submit} className="mt-6 flex gap-3 flex-wrap">
        <input required type="email" placeholder="you@domain.com" value={email} onChange={(e) => setEmail(e.target.value)} className="input-x flex-1 min-w-[240px]" data-testid="newsletter-email" />
        <button disabled={busy} className="btn-accent" data-testid="newsletter-submit">{busy ? "…" : (props.cta_label || "Subscribe")}</button>
      </form>
    </Container></section>
  );
}

function VideoEmbed({ props, preview }) {
  // Browsers refuse to start an unmuted video on their own, so autoplay forces muted
  // rather than offering a combination that would silently never play.
  const autoplay = !!props.autoplay;
  const loop = !!props.loop;
  const muted = autoplay || !!props.muted;
  const controls = props.controls !== false;
  const aspect = aspectClass(props.aspect, "aspect-video");
  const caption = props.caption
    ? <div className="mt-2 font-mono-x text-xs uppercase tracking-[0.25em] text-ink-4">{props.caption}</div>
    : null;

  // An uploaded file wins over a pasted embed URL when both are set: it is the more
  // specific of the two, and the only one that autoplays without a third-party player's
  // chrome over it. CSP `media-src` covers 'self' and the blob store, so a file that came
  // from /admin/uploads plays and an arbitrary pasted host is refused by the browser.
  if (props.file_url) {
    return (
      <section><Container>
        <div className={`${aspect} border border-ink/10 bg-scrim overflow-hidden`}>
          <video
            src={mediaUrl(props.file_url)}
            poster={props.poster_url ? mediaUrl(props.poster_url) : undefined}
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
      </Container></section>
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
      <section><Container>
        <div className="border border-brand p-4 font-mono-x text-xs uppercase tracking-[0.2em] text-brand"
             data-testid="video-unsupported">
          Unsupported embed URL — YouTube, Vimeo, SoundCloud and Bandcamp only
          <div className="mt-1 normal-case tracking-normal text-ink-3">
            Bandcamp needs the URL from its own Share / Embed dialog, not the album page.
          </div>
          <div className="mt-2 normal-case tracking-normal text-ink-3 break-all">{props.url}</div>
        </div>
      </Container></section>
    );
  }

  // A SoundCloud or Bandcamp player is a control strip, not a rectangle: forcing it into
  // aspect-video leaves a 16:9 box mostly empty. Audio providers are sized by height and
  // ignore the aspect control, which the panel hides for them.
  const isAudio = AUDIO_PROVIDERS.has(embed.provider);
  const frameClass = isAudio ? "" : aspect;
  const frameStyle = isAudio
    ? { height: embed.provider === "bandcamp" ? 470 : 166 }
    : undefined;

  return (
    <section><Container>
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
    </Container></section>
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
  return <section><Container><div dangerouslySetInnerHTML={{ __html: safe }} /></Container></section>;
}

function Spacer({ props }) { return <div style={{ height: props.height || "4rem" }} />; }

function Split({ props }) {
  const reverse = props.direction === "image-right";
  return (
    <section><Container>
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
    </Container></section>
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
    <div className={`relative overflow-hidden ${h} flex flex-col justify-center`} data-testid="image-band">
      {props.image_url && (
        <div className="absolute inset-0">
          <img src={mediaUrl(props.image_url)} alt="" className="w-full h-full object-cover" />
          <div className="absolute inset-0"
               style={{ backgroundColor: props.overlay_color || "#050505", opacity }}
               data-testid="image-band-overlay" />
        </div>
      )}
      <Container className="relative py-16 md:py-24">
        <div className={`flex flex-col ${align}`}>
          {props.eyebrow && <div className={`font-mono-x text-xs ${upper} tracking-[0.3em] text-ink-3 mb-4`}>{props.eyebrow}</div>}
          {props.heading && (
            <h2 className={`font-display text-4xl md:text-6xl ${upper} tracking-tighter font-bold max-w-4xl whitespace-pre-wrap`}
                data-testid="image-band-heading">
              {props.heading}
            </h2>
          )}
          {props.body && <div className="mt-6 max-w-xl">{renderRich(props.body, { paraClassName: "text-ink-2 leading-relaxed text-lg" })}</div>}
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
