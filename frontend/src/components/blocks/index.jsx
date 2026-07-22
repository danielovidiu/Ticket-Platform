import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { QRCodeCanvas } from "qrcode.react";
import DOMPurify from "dompurify";
import { http } from "../../api";
import { toast } from "sonner";
import { renderRich, renderInline } from "../../lib/richText";
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

function Container({ children, className = "" }) {
  return <div className={`max-w-[1400px] mx-auto px-6 md:px-10 ${className}`}>{children}</div>;
}

// ---------------- Blocks ----------------

function Hero({ props }) {
  const h = props.height === "short" ? "min-h-[50vh]" : props.height === "medium" ? "min-h-[70vh]" : "min-h-[85vh]";
  const align = props.align === "center" ? "text-center items-center" : props.align === "right" ? "text-right items-end" : "text-left items-start";
  return (
    <section className={`relative overflow-hidden ${h} flex flex-col justify-end`}>
      {props.image_url && (
        <div className="absolute inset-0">
          <img src={props.image_url} alt="" className="w-full h-full object-cover opacity-40" />
          <div className="absolute inset-0 bg-gradient-to-b from-transparent to-[color:var(--bg,#050505)]" />
        </div>
      )}
      <Container className="relative pb-16 md:pb-24 pt-24">
        <div className={`flex flex-col ${align}`}>
          {props.eyebrow && <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-zinc-400 mb-6">{props.eyebrow}</div>}
          {props.heading && <h1 className="font-display text-[10vw] md:text-[7vw] leading-[0.85] uppercase tracking-tighter font-black max-w-6xl">{props.heading}</h1>}
          {props.body && <p className="mt-8 max-w-xl text-zinc-300 leading-relaxed text-lg">{renderInline(props.body)}</p>}
          <div className="mt-8 flex flex-wrap gap-3">
            {props.cta_label && <Link to={props.cta_href || "#"} className={props.cta_style === "accent" ? "btn-accent" : "btn-primary"}>{props.cta_label}</Link>}
            {props.second_cta_label && <Link to={props.second_cta_href || "#"} className="btn-primary">{props.second_cta_label}</Link>}
          </div>
        </div>
      </Container>
    </section>
  );
}

function RichText({ props }) {
  return <section className="py-16"><Container className="max-w-[900px]">{renderRich(props.content)}</Container></section>;
}

function ImageBlock({ props }) {
  if (!props.image_url) return <div className="py-8 text-center text-zinc-500 font-mono-x text-xs uppercase">Image not set</div>;
  const cls = props.full_width ? "w-full" : "max-w-[1200px] mx-auto";
  const aspect = props.aspect && props.aspect !== "natural" ? aspectClass(props.aspect, "") : "";
  return (
    <section className="py-10">
      <figure className={cls}>
        <div className={`${aspect} overflow-hidden border border-white/10`}>
          <img src={props.image_url} alt={props.caption || ""} className="w-full h-full object-cover block" />
        </div>
        {props.caption && <figcaption className="p-3 font-mono-x text-xs uppercase tracking-[0.25em] text-zinc-500">{props.caption}</figcaption>}
      </figure>
    </section>
  );
}

function GalleryGrid({ props }) {
  const [items, setItems] = useState([]);
  useEffect(() => { http.get("/gallery").then((r) => setItems(r.data.slice(0, props.limit || 6))).catch(() => {}); }, [props.limit]);
  return (
    <section className="py-16"><Container>
      {props.heading && <h2 className="font-display text-3xl md:text-5xl uppercase font-bold tracking-tighter mb-8">{props.heading}</h2>}
      <div className="columns-1 md:columns-3 gap-4 space-y-4">
        {items.map((g) => (
          <figure key={g.gallery_id} className="break-inside-avoid border border-white/10">
            <img src={g.image_url} alt={g.caption} className="w-full block" />
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
    <section className="py-16"><Container>
      <div className="flex items-end justify-between mb-10">
        <div>
          {props.eyebrow && <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-zinc-500">{props.eyebrow}</div>}
          {props.heading && <h2 className="font-display text-4xl md:text-6xl uppercase font-bold tracking-tighter mt-2">{props.heading}</h2>}
        </div>
        <Link to="/events" className="btn-primary hidden md:inline">All events</Link>
      </div>
      <div className={`grid grid-cols-1 ${cols} gap-6 items-stretch`}>
        {events.map((e) => {
          const hasAlbum = e.gallery && e.gallery.length > 0;
          const cover = hasAlbum ? e.gallery[0] : null;
          return (
            <div key={e.event_id} className="group flex flex-col h-full border border-white/10 bg-[#0F0F0F] hover:border-white transition-colors">
              {hasAlbum ? (
                <button onClick={() => openAlbum(e)} data-testid={`events-grid-cover-${e.slug}`} className="aspect-[16/10] overflow-hidden relative block w-full text-left shrink-0">
                  {cover.media_type === "video" ? (
                    <video src={mediaUrl(cover.image_url)} className="w-full h-full object-cover" muted preload="metadata" />
                  ) : (
                    <img src={mediaUrl(cover.thumbnail_url || cover.image_url)} alt={e.title} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                  )}
                  <div className="absolute bottom-2 right-2 bg-black/70 px-2 py-1 flex items-center gap-1 font-mono-x text-[10px] uppercase tracking-[0.2em] text-white">
                    <Camera size={11} /> {e.gallery.length}
                  </div>
                </button>
              ) : (
                <Link to={`/events/${e.slug}`} className="aspect-[16/10] overflow-hidden block shrink-0">
                  <img src={e.image_url} alt={e.title} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                </Link>
              )}
              <Link to={`/events/${e.slug}`} className="p-6 flex-1 flex flex-col justify-center">
                <div className="font-mono-x text-xs uppercase tracking-[0.25em] text-zinc-500">{fmtDate(e.starts_at)} · {[e.venue, e.city].filter(Boolean).join(", ")}</div>
                <div className="font-display text-3xl uppercase tracking-tighter font-bold mt-3">{e.title}</div>
              </Link>
            </div>
          );
        })}
        {events.length === 0 && <div className="col-span-full border border-dashed border-white/10 p-10 text-center text-zinc-500 font-mono-x text-xs uppercase tracking-[0.3em]">No upcoming events</div>}
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
    <section className="py-16"><Container>
      <div className="flex items-end justify-between mb-10">
        <div>
          {props.eyebrow && <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-zinc-500">{props.eyebrow}</div>}
          {props.heading && <h2 className="font-display text-4xl md:text-6xl uppercase font-bold tracking-tighter mt-2">{props.heading}</h2>}
        </div>
        <Link to="/artists" className="btn-primary hidden md:inline">All artists</Link>
      </div>
      <div className={`grid grid-cols-2 ${cols} gap-4`}>
        {artists.map((a) => (
          <Link key={a.artist_id} to={`/artists/${a.slug}`} className="group block border border-white/10">
            <div className={`${aspectClass(props.card_aspect, "aspect-square")} overflow-hidden`}><img src={a.image_url} alt={a.name} className="w-full h-full object-cover grayscale group-hover:grayscale-0 transition duration-500" /></div>
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
    <section className="hairline-b hairline py-6 overflow-hidden">
      <div className="marquee">
        <div className="marquee-track font-mono-x uppercase tracking-[0.3em] text-2xl md:text-4xl">
          {[...items, ...items].map((m, i) => (
            <span key={`${m}-${i}`} className="flex items-center gap-16 text-zinc-500">{m} <span className="text-[color:var(--accent)]">◆</span></span>
          ))}
        </div>
      </div>
    </section>
  );
}

function CTABanner({ props }) {
  return (
    <section className="py-24"><Container>
      <div className="grid md:grid-cols-2 gap-10 items-start">
        <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-zinc-500">CTA</div>
        <div>
          {props.heading && <p className="font-display text-3xl md:text-5xl uppercase tracking-tighter leading-tight">{props.heading}</p>}
          {props.body && <p className="mt-4 text-zinc-400 max-w-lg">{renderInline(props.body)}</p>}
          {props.cta_label && <Link to={props.cta_href || "#"} className="mt-8 inline-block btn-primary">{props.cta_label}</Link>}
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
    <section className="py-16"><Container className="max-w-[900px]">
      {props.heading && <h2 className="font-display text-3xl md:text-5xl uppercase font-bold tracking-tighter">{props.heading}</h2>}
      <form onSubmit={submit} className="border border-white/10 bg-[color:var(--surface,#0F0F0F)] p-6 md:p-8 space-y-4 mt-6">
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
    <section className="py-16 hairline"><Container className="max-w-[900px]">
      {props.heading && <h2 className="font-display text-3xl md:text-4xl uppercase font-bold tracking-tighter">{props.heading}</h2>}
      {props.body && <p className="text-zinc-400 mt-3">{renderInline(props.body)}</p>}
      <form onSubmit={submit} className="mt-6 flex gap-3 flex-wrap">
        <input required type="email" placeholder="you@domain.com" value={email} onChange={(e) => setEmail(e.target.value)} className="input-x flex-1 min-w-[240px]" data-testid="newsletter-email" />
        <button disabled={busy} className="btn-accent" data-testid="newsletter-submit">{busy ? "…" : (props.cta_label || "Subscribe")}</button>
      </form>
    </Container></section>
  );
}

function VideoEmbed({ props }) {
  if (!props.url) return null;
  const ytMatch = props.url.match(/(?:v=|youtu\.be\/)([\w-]+)/);
  const vimeoMatch = props.url.match(/vimeo\.com\/(\d+)/);
  let src = props.url;
  if (ytMatch) src = `https://www.youtube.com/embed/${ytMatch[1]}`;
  else if (vimeoMatch) src = `https://player.vimeo.com/video/${vimeoMatch[1]}`;
  return (
    <section className="py-10"><Container>
      <div className="aspect-video border border-white/10"><iframe src={src} title={props.caption || "video"} className="w-full h-full" allowFullScreen /></div>
      {props.caption && <div className="mt-2 font-mono-x text-xs uppercase tracking-[0.25em] text-zinc-500">{props.caption}</div>}
    </Container></section>
  );
}

function CustomHTML({ props }) {
  // XSS guard: sanitize any HTML entered via the CMS. Strips <script>,
  // event handlers, and javascript: URIs. Runs on both editors' preview
  // and public visitors.
  const safe = DOMPurify.sanitize(props.html || "", {
    USE_PROFILES: { html: true, svg: true },
    FORBID_TAGS: ["script", "iframe", "object", "embed", "form"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus", "onblur", "formaction"],
  });
  return <section className="py-4"><Container><div dangerouslySetInnerHTML={{ __html: safe }} /></Container></section>;
}

function Spacer({ props }) { return <div style={{ height: props.height || "4rem" }} />; }

function Split({ props }) {
  const reverse = props.direction === "image-right";
  return (
    <section className="py-16"><Container>
      <div className={`grid md:grid-cols-2 gap-10 items-center ${reverse ? "md:[&>*:first-child]:order-2" : ""}`}>
        <div className={`${aspectClass(props.aspect, "aspect-square")} overflow-hidden border border-white/10`}>
          {props.image_url ? <img src={props.image_url} alt="" className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center text-zinc-600 font-mono-x text-xs uppercase tracking-[0.3em]">Set image URL</div>}
        </div>
        <div>
          {props.eyebrow && <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-zinc-500">{props.eyebrow}</div>}
          {props.heading && <h2 className="font-display text-3xl md:text-5xl uppercase font-bold tracking-tighter mt-2">{props.heading}</h2>}
          {props.body && <p className="mt-4 text-zinc-300 leading-relaxed">{renderInline(props.body)}</p>}
          {props.cta_label && <Link to={props.cta_href || "#"} className="mt-6 inline-block btn-primary">{props.cta_label}</Link>}
        </div>
      </div>
    </Container></section>
  );
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
  custom_html: CustomHTML,
  spacer: Spacer,
  split: Split,
};

export function BlockRenderer({ block }) {
  if (!block || block.enabled === false) return null;
  const R = BLOCK_RENDERERS[block.type];
  if (!R) return <div className="p-6 border border-dashed border-white/10 text-zinc-500 font-mono-x text-xs uppercase">Unknown block: {block.type}</div>;
  return <R props={block.props || {}} />;
}

// Silence linter about unused imports on QR (kept for future custom blocks).
export const _QR = QRCodeCanvas;
