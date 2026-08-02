import React, { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { http } from "../api";
import { useAuth, startLogin } from "../auth";
import { toast } from "sonner";
import { Play } from "lucide-react";
import { renderRich } from "../lib/richText";
import { mediaUrl } from "../lib/media";
import { Lightbox } from "../components/ui/lightbox";

const fmtDate = (iso) => new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" }).toUpperCase();
const fmtTime = (iso) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/**
 * Clamp long copy to `lines` rendered rows, with a toggle to see the rest.
 *
 * Whether it overflows is measured, not guessed from the text length: a clamp is a
 * function of the rendered width, so the same description spills at 375px and fits at
 * 1280px. That also means a short event description gets no pointless "Show more".
 *
 * The measurement only runs while collapsed. Once expanded, scrollHeight equals
 * clientHeight, and a naive re-measure would decide there was nothing to clamp and
 * remove the button the reader needs to collapse it again.
 */
function Collapsible({ lines = 10, testId, children }) {
  const ref = useRef(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || expanded) return undefined;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [expanded, children]);

  return (
    <div data-testid={testId}>
      {/* Clamping counts rendered rows across the block children renderRich emits, which
          is what "the first ten rows" means — not the first ten paragraphs. Written as an
          inline style rather than line-clamp-[10] so `lines` is a real prop: Tailwind
          generates classes by scanning source text and cannot see a runtime value. */}
      <div ref={ref}
           className={expanded ? undefined : "overflow-hidden"}
           style={expanded ? undefined : {
             display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: lines,
           }}>
        {children}
      </div>
      {(overflows || expanded) && (
        <button onClick={() => setExpanded((v) => !v)}
                data-testid={`${testId}-toggle`} aria-expanded={expanded}
                className="mt-4 font-mono-x text-[11px] uppercase tracking-[0.2em] text-ink-3 hover:text-ink underline underline-offset-4">
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

export default function EventDetail() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const { user } = useAuth();
  const [event, setEvent] = useState(null);
  const [waveId, setWaveId] = useState(null);
  const [qty, setQty] = useState(1);
  const [code, setCode] = useState("");
  const [special, setSpecial] = useState(null);
  const [busy, setBusy] = useState(false);
  const [lbIndex, setLbIndex] = useState(null);

  const specialToken = search.get("invite") || null;

  useEffect(() => {
    http.get(`/events/${slug}`).then((r) => {
      setEvent(r.data);
      const active = r.data.waves.find((w) => w.is_active && w.available > 0);
      if (active) setWaveId(active.wave_id);
      else if (r.data.waves.length > 0) setWaveId(r.data.waves[0].wave_id);
    }).catch(() => toast.error("Event not found"));
    if (specialToken) {
      http.get(`/special-links/${specialToken}`).then((r) => setSpecial(r.data.link)).catch(() => {});
    }
  }, [slug, specialToken]);

  // Derived UI values — memoized so re-renders on qty/code changes don't rescan the waves array.
  const selectedWave = useMemo(
    () => event?.waves?.find((w) => w.wave_id === waveId) || null,
    [event, waveId]
  );
  const soldOut = !special && !!event && event.waves.length > 0 && event.waves.every((w) => !w.is_active || w.available <= 0);
  const unitPrice = special ? special.price_ron : (selectedWave?.price_ron || 0);
  const total = useMemo(() => unitPrice * qty, [unitPrice, qty]);
  const qtyOptions = useMemo(() => {
    const cap = event?.max_tickets_per_user || 4;
    return [1, 2, 3, 4].filter((n) => n <= cap);
  }, [event]);

  const reserve = async () => {
    if (!user) {
      // NON-SENSITIVE: this stores the current URL path (not an auth token or PII)
      // so we can return the user to the same event page after Google OAuth.
      // Auth tokens themselves live in an httpOnly cookie set by the backend.
      localStorage.setItem("auth_return_to", window.location.pathname + window.location.search);
      startLogin(window.location.pathname);
      return;
    }
    if (!waveId) { toast.error("Pick a wave"); return; }
    setBusy(true);
    try {
      const { data } = await http.post("/reservations", {
        event_id: event.event_id,
        wave_id: waveId,
        quantity: Number(qty),
        discount_code: code || null,
        special_link_token: specialToken,
      });
      navigate(`/checkout/${data.reservation_id}`);
    } catch (e) {
      // The account gates answer with an object, not a string: a session that predates
      // the mandatory-profile rule can reach this button with no phone number on file.
      // Send those to the form that fixes it instead of showing a dead-end error.
      const detail = e.response?.data?.detail;
      if (detail?.reason === "profile_incomplete") {
        toast.error("Add your name and phone number to buy tickets");
        navigate(`/complete-profile?return=${encodeURIComponent(window.location.pathname + window.location.search)}`);
        return;
      }
      if (detail?.reason === "email_not_verified") {
        toast.error("Confirm your email address first — check your inbox for the link");
        return;
      }
      toast.error(typeof detail === "string" ? detail : "Could not hold tickets");
    } finally {
      setBusy(false);
    }
  };

  if (!event) return <div className="p-16 text-center text-ink-4 font-mono-x uppercase text-xs tracking-[0.3em]">Loading…</div>;

  return (
    /* Three grid blocks rather than two columns, so the DOM order IS the mobile order:
       photo and title, then the box office, then the description, then the album. The
       box office used to be the second of two columns, which put the buy button below
       the entire description and gallery on a phone — the one thing a visitor came for,
       past everything they had to scroll through first.

       On md the box office spans both rows of the left stack, which is what gives the
       sticky card a tall enough containing block to travel in, exactly as the two-column
       version did. */
    <div className="max-w-[1400px] mx-auto px-6 md:px-10 py-12 grid md:grid-cols-12 gap-10 items-start">
      <div className="md:col-span-7">
        <div className="aspect-[4/3] overflow-hidden border border-ink/10">
          <img src={mediaUrl(event.image_url)} alt={event.title} className="w-full h-full object-cover" />
        </div>
        <div className="mt-8 font-mono-x text-xs uppercase tracking-[0.25em] text-ink-3">
          {fmtDate(event.starts_at)} · Doors {fmtTime(event.doors_open_at || event.starts_at)} · {[event.venue, event.city].filter(Boolean).join(", ")}
        </div>
        <h1 data-testid="event-title" className="font-display text-5xl md:text-7xl uppercase font-black tracking-tighter mt-4 leading-none">
          {event.title}
        </h1>
      </div>

      <div className="md:col-span-5 md:row-span-2">
        <div className="border border-ink/10 bg-surface p-6 md:p-8 sticky top-24">
          <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-ink-4">Box Office</div>
          <div className="font-display text-2xl uppercase font-bold mt-2">Buy Tickets</div>

          {special && (
            <div className="mt-4 border border-brand p-3 font-mono-x text-xs uppercase tracking-[0.2em] text-brand">
              INVITE · {special.label} · {special.price_ron.toFixed(2)} RON
            </div>
          )}

          {soldOut ? (
            <div data-testid="sold-out-message" className="mt-6 border border-ink/15 bg-ink/5 p-6 text-center">
              <div className="font-display text-2xl uppercase font-bold tracking-tight">
                {event.sold_out_message || "Sold Out"}
              </div>
            </div>
          ) : (
            <>
              <div className="mt-6 space-y-3">
                {!special && event.waves.map((w) => (
                  <button key={w.wave_id} onClick={() => setWaveId(w.wave_id)} data-testid={`wave-${w.tier}`}
                          disabled={!w.is_active || w.available <= 0}
                          className={`w-full text-left border p-4 transition-colors ${waveId===w.wave_id ? "border-ink bg-ink/5" : "border-ink/15"} ${(!w.is_active || w.available<=0) ? "opacity-40 cursor-not-allowed" : "hover:border-ink"}`}>
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="font-display uppercase font-bold">{w.name}</div>
                        <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 mt-1">
                          {w.available > 0 ? `${w.available} available` : "SOLD OUT"}
                        </div>
                      </div>
                      <div className="font-mono-x">{w.price_ron.toFixed(2)} RON</div>
                    </div>
                  </button>
                ))}
              </div>

              <div className="mt-6 grid grid-cols-2 gap-3">
                <label className="col-span-1">
                  <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 mb-2">Quantity</div>
                  <select value={qty} onChange={(e) => setQty(Number(e.target.value))} data-testid="qty-select" className="input-x">
                    {qtyOptions.map(n => <option key={n} value={n}>{n}</option>)}
                  </select>
                </label>
                {!special && (
                  <label className="col-span-1">
                    <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 mb-2">Discount code</div>
                    <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="CODE" data-testid="discount-input" className="input-x uppercase" />
                  </label>
                )}
              </div>

              <div className="mt-6 hairline pt-6">
                <div className="flex justify-between font-mono-x text-sm">
                  <span className="text-ink-4 uppercase tracking-[0.2em] text-xs">Subtotal</span>
                  <span>{total.toFixed(2)} RON</span>
                </div>
                <div className="flex justify-between mt-3 items-center">
                  <span className="font-mono-x uppercase text-xs tracking-[0.2em] text-ink-3">Total</span>
                  <span className="font-display text-3xl font-bold">{total.toFixed(2)} RON</span>
                </div>
              </div>

              <button onClick={reserve} disabled={busy} data-testid="reserve-btn" className="btn-accent w-full mt-6">
                {busy ? "HOLDING…" : "HOLD & CHECKOUT · 10 MIN"}
              </button>
              <p className="mt-4 text-xs text-ink-4 leading-relaxed">
                Tickets are held for 10 minutes while you pay via Stripe. All sales final unless the event is cancelled.
                Max {event.max_tickets_per_user} tickets per person.
              </p>
            </>
          )}
        </div>
      </div>

      <div className="md:col-span-7 md:col-start-1">
        <Collapsible lines={10} testId="event-description">
          {renderRich(event.description, { paraClassName: "text-ink-2 text-lg leading-relaxed max-w-2xl mt-4 first:mt-0" })}
        </Collapsible>

        {event.gallery && event.gallery.length > 0 && (
          <div className="mt-12">
            <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-ink-4 mb-4">Album · {event.gallery.length}</div>
            <div className="columns-2 sm:columns-3 gap-2">
              {event.gallery.map((g, i) => (
                <button
                  key={g.gallery_id}
                  onClick={() => setLbIndex(i)}
                  data-testid={`album-thumb-${i}`}
                  className="mb-2 block w-full break-inside-avoid relative group"
                >
                  {g.media_type === "video" ? (
                    <>
                      {/* Prefer the poster captured at upload: it renders at the same
                          size as a photo and costs one image request instead of a
                          video decode per tile. Items without a poster fall back. */}
                      {g.thumbnail_url && g.thumbnail_url !== g.image_url ? (
                        <img src={mediaUrl(g.thumbnail_url)} alt={g.caption || ""} loading="lazy" className="w-full object-cover" />
                      ) : (
                        <video src={mediaUrl(g.image_url)} className="w-full object-cover" muted preload="metadata" />
                      )}
                      <div className="absolute inset-0 flex items-center justify-center bg-scrim/20 group-hover:bg-scrim/10 transition-colors">
                        <Play size={28} className="text-ink" fill="white" />
                      </div>
                    </>
                  ) : (
                    <img
                      src={mediaUrl(g.thumbnail_url || g.image_url)}
                      alt={g.caption || ""}
                      loading="lazy"
                      className="w-full object-cover group-hover:opacity-80 transition-opacity"
                    />
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {lbIndex !== null && (
        <Lightbox
          items={event.gallery.map((g) => ({ url: g.image_url, thumbnail_url: g.thumbnail_url, media_type: g.media_type, caption: g.caption }))}
          index={lbIndex}
          onClose={() => setLbIndex(null)}
          onIndexChange={setLbIndex}
        />
      )}
    </div>
  );
}
