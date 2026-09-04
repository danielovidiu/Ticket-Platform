import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { http } from "../api";
import { mediaUrl } from "../lib/media";
import BackLink from "../components/BackLink";
import { renderRich } from "../lib/richText";
import ExpandableText from "../components/ExpandableText";
import { SOCIAL_PLATFORMS } from "../lib/social";

const BIO_LIMIT = 200;
const BIO_PARA = "text-ink-2 text-lg leading-relaxed max-w-xl";

/**
 * The bio, short by default.
 *
 * The collapse/expand behaviour is shared with the album description (see
 * components/ExpandableText); what is particular to a bio is the 200-character limit and
 * that the expanded form goes through the RICH renderer, so headings, lists and links
 * come back rather than being read as literal asterisks.
 */
export function Bio({ text }) {
  return (
    <ExpandableText
      text={text}
      limit={BIO_LIMIT}
      className="mt-8"
      paraClassName={BIO_PARA}
      testId="artist-bio"
      renderExpanded={(value) => renderRich(value, { paraClassName: `${BIO_PARA} mt-4 first:mt-0` })}
    />
  );
}

/** One tile in the gallery strip below an artist's identity block. */
function Tile({ to, image, title, meta }) {
  const inner = (
    <>
      {image && (
        <div className="aspect-[4/3] overflow-hidden">
          <img src={mediaUrl(image)} alt={title}
               className="w-full h-full object-cover grayscale group-hover:grayscale-0 transition duration-500" />
        </div>
      )}
      <div className="p-4">
        <div className="font-display uppercase text-lg font-bold tracking-tighter">{title}</div>
        {meta && <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 mt-1">{meta}</div>}
      </div>
    </>
  );
  const cls = "group block border border-ink/10";
  // `to` is optional: a tile without a destination still renders, as a plain div.
  return to ? <Link to={to} className={cls}>{inner}</Link> : <div className={cls}>{inner}</div>;
}

export default function ArtistDetail() {
  const { slug } = useParams();
  const [a, setA] = useState(null);
  useEffect(() => { http.get(`/artists/${slug}`).then((r) => setA(r.data)).catch(() => {}); }, [slug]);
  if (!a) return <div className="p-16 text-center font-mono-x text-ink-4">Loading…</div>;

  // Ordered by SOCIAL_PLATFORMS, not by the key order of the stored object.
  //
  // `links` is a bag whose iteration order is whatever the admin form happened to write,
  // so sorting the constant alone changed the form's fields and left these buttons in
  // insertion order — the artist above still read YouTube, Facebook, SoundCloud,
  // Instagram. Walking the vocabulary instead means one A-Z list drives both.
  //
  // Anything stored under a key the vocabulary does not know still renders, after the
  // known ones and sorted, rather than disappearing because it was not in the list.
  const stored = Object.entries(a.links || {}).filter(([, v]) => v);
  const known = SOCIAL_PLATFORMS
    .map((p) => stored.find(([k]) => k === p.key))
    .filter(Boolean);
  const unknown = stored
    .filter(([k]) => !SOCIAL_PLATFORMS.some((p) => p.key === k))
    .sort(([a1], [b1]) => a1.localeCompare(b1));
  const links = [...known, ...unknown];
  const disciplines = a.disciplines || [];
  const albums = a.albums || [];
  const hasOther = a.other_project_name || a.other_project_url;

  return (
    <div className="max-w-[1400px] mx-auto px-6 md:px-10 py-16">
      <BackLink to="/artists" testId="artist-back">All artists</BackLink>
      <div className="grid md:grid-cols-12 gap-10 mt-6">
        {a.image_url && (
          <div className="md:col-span-5">
            <div className="aspect-square overflow-hidden border border-ink/10"><img src={mediaUrl(a.image_url)} alt={a.name} loading="lazy" decoding="async" className="w-full h-full object-cover" /></div>
          </div>
        )}
        <div className={a.image_url ? "md:col-span-7" : "md:col-span-12"}>
          <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-ink-4">Artist</div>
          <h1 className="font-display text-6xl md:text-8xl uppercase font-black tracking-tighter mt-2 leading-none">{a.name}</h1>

          {disciplines.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2" data-testid="artist-disciplines">
              {disciplines.map((d) => (
                <span key={d} className="px-3 py-1 border border-ink/20 font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-3">{d}</span>
              ))}
            </div>
          )}

          {a.bio && <Bio text={a.bio} />}

          {links.length > 0 && (
            <div className="mt-8 flex gap-3 flex-wrap">
              {links.map(([k, v]) => {
                const platform = SOCIAL_PLATFORMS.find((p) => p.key === k);
                return <a key={k} href={v} target="_blank" rel="noreferrer" className="btn-primary">{platform ? platform.label : k}</a>;
              })}
            </div>
          )}

          {hasOther && (
            <div className="mt-10" data-testid="artist-other-project">
              <div className="font-mono-x text-[10px] uppercase tracking-[0.3em] text-ink-4">Other projects</div>
              <div className="mt-2">
                {a.other_project_url ? (
                  <a href={a.other_project_url} target="_blank" rel="noreferrer"
                     className="font-display uppercase text-xl tracking-tighter underline underline-offset-4 hover:text-ink">
                    {a.other_project_name || a.other_project_url}
                  </a>
                ) : (
                  <span className="font-display uppercase text-xl tracking-tighter">{a.other_project_name}</span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* The galleries sit below the fold, full width — they are the body of evidence,
          not part of the identity block above. */}
      {albums.length > 0 && (
        <section className="mt-20" data-testid="artist-albums">
          <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-ink-4 hairline-b pb-3">Gallery</div>
          <div className="mt-6 grid grid-cols-1 md:grid-cols-3 gap-4">
            {albums.map((al) => (
              <Tile key={al.album_id} to={`/gallery/${al.slug}`}
                    image={al.cover?.thumbnail_url || al.cover?.image_url}
                    title={al.title}
                    meta={`${al.count} ${al.count === 1 ? "image" : "images"}`} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
