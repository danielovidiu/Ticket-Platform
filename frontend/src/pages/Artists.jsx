import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { http } from "../api";
import { mediaUrl } from "../lib/media";
import { useCorePageHeader } from "../lib/corePageHeader";
import PageHeader from "../components/PageHeader";

// How many discipline tags a tile shows before it stops listing them. Three fits the
// column at every breakpoint without wrapping to a third line; the rest are counted.
const SHOWN = 3;

// The roster's filter, in the shape the Events tab bar established. Fixed rather than a
// CMS setting: collab is a closed vocabulary of two on the server, so there is nothing
// here for an editor to configure that would not also need a migration.
const TABS = [
  ["all", "All"],
  ["resident", "Residents"],
  ["guest", "Guests"],
];

export default function Artists() {
  const [artists, setArtists] = useState([]);
  const [tab, setTab] = useState("all");
  const header = useCorePageHeader("artists");
  // Already A-Z from the server, which folds case — see list_artists. Sorting again here
  // would only be a second opinion that could disagree.
  useEffect(() => { http.get("/artists").then((r) => setArtists(r.data)).catch(() => {}); }, []);

  // Filtered here rather than refetched per tab: the roster is one short list that is
  // already loaded, so a request per click would add latency and nothing else.
  const shown = tab === "all" ? artists : artists.filter((a) => (a.collab || "resident") === tab);

  return (
    /* space-y rather than a margin on the grid: the header is CMS content and can be
       emptied, and a gap that belongs to the thing above it disappears with it. */
    <div className="max-w-[1400px] mx-auto px-6 md:px-10 py-16 space-y-12">
      <PageHeader
        header={header}
        eyebrowTestId="artists-eyebrow"
        headingTestId="artists-heading"
        aside={(
          <div className="flex gap-2" data-testid="artist-tabs">
            {TABS.map(([value, label]) => (
              <button key={value} onClick={() => setTab(value)} data-testid={`artist-tab-${value}`}
                      aria-pressed={tab === value}
                      className={`px-4 py-2 border font-mono-x text-xs uppercase tracking-[0.2em] ${tab === value ? "bg-ink text-page border-ink" : "border-ink/20 text-ink-2"}`}>
                {label}
              </button>
            ))}
          </div>
        )}
      />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {shown.map((a) => {
          const tags = a.disciplines || [];
          const rest = tags.length - SHOWN;
          return (
            // The same hover the Gallery tiles use: the border goes solid and the
            // photograph comes back into colour. These two grids are the site's index of
            // its own people and nights, and they now read as one kind of card; Shop is
            // deliberately not in the set — a garment has to be seen in its real colour
            // before it is clicked, so its tiles dim instead.
            //
            // This used to dim too, on the grounds that greyscale made the roster read as
            // a different card from the other grids. It did, while Gallery dimmed as well
            // — the answer was to make Gallery the one that reveals, not to keep all three
            // on the weaker hover.
            <Link key={a.artist_id} to={`/artists/${a.slug}`} data-testid={`artist-${a.slug}`}
                  className="group block border border-ink/10 hover:border-ink transition-colors">
              {a.image_url && (
                <div className="aspect-square overflow-hidden">
                  <img src={mediaUrl(a.image_url)} alt={a.name} loading="lazy" decoding="async"
                       className="w-full h-full object-cover grayscale group-hover:grayscale-0 transition duration-500" />
                </div>
              )}
              <div className="p-5">
                <div className="font-display uppercase text-xl font-bold tracking-tighter">{a.name}</div>
                {tags.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-x-2 gap-y-1 font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4"
                       data-testid={`artist-${a.slug}-disciplines`}>
                    {tags.slice(0, SHOWN).map((d) => <span key={d}>{d}</span>)}
                    {/* Text, not an anchor: the whole tile is already a link to this
                        artist, and an <a> inside an <a> is invalid and unclickable. */}
                    {rest > 0 && <span className="text-ink-3 group-hover:text-ink">+{rest} more</span>}
                  </div>
                )}
              </div>
            </Link>
          );
        })}
        {shown.length === 0 && (
          <div className="col-span-full border border-dashed border-ink/10 p-10 text-center text-ink-4 font-mono-x text-xs uppercase tracking-[0.3em]"
               data-testid="artists-empty">
            No {tab === "all" ? "artists" : `${tab}s`} yet
          </div>
        )}
      </div>
    </div>
  );
}
