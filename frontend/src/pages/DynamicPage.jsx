import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { http } from "../api";
import { BlockRenderer } from "../components/blocks";

/**
 * Renders a CMS page.
 *
 * `home` asks the server which page answers "/" instead of naming one. The root used to
 * request the slug `home` outright, which meant the front page depended on a string that
 * is immutable through the API — a site whose homepage was authored under any other slug
 * served a 404 at its own root, unfixable from the CMS.
 */
export default function DynamicPage({ slugOverride, home }) {
  const params = useParams();
  const slug = slugOverride || params.slug;
  const [page, setPage] = useState(null);
  const [status, setStatus] = useState("loading");

  useEffect(() => {
    let stale = false;
    setStatus("loading");
    http.get(home ? "/cms/home" : `/cms/pages/${slug}`)
      .then((r) => { if (!stale) { setPage(r.data); setStatus("ok"); } })
      .catch(() => { if (!stale) setStatus("notfound"); });
    return () => { stale = true; };
  }, [slug, home]);

  if (status === "loading") {
    return <div className="p-16 text-center font-mono-x text-xs uppercase tracking-[0.3em] text-ink-4">Loading…</div>;
  }
  if (status === "notfound" || !page) {
    // At the root, "not found" means nobody has chosen a homepage — a setting, not a bad
    // URL. Saying "404 Page not found" there sends an editor looking for the wrong fault.
    if (home) {
      return (
        <div className="p-16 text-center">
          <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-ink-4">Nothing here yet</div>
          <h1 className="font-display text-4xl md:text-6xl uppercase font-black tracking-tighter mt-3">No homepage set</h1>
          <p className="mt-6 text-ink-3 text-sm">
            Pick one in the CMS — open Navigation and use the ⌂ button on the page that should answer this address.
          </p>
        </div>
      );
    }
    return (
      <div className="p-16 text-center">
        <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-ink-4">404</div>
        <h1 className="font-display text-4xl md:text-6xl uppercase font-black tracking-tighter mt-3">Page not found</h1>
      </div>
    );
  }

  /* The page background is lifted out of the run of blocks.
   *
   * It has to paint under everything else, and a negative z-index cannot do that here:
   * the app wraps its pages in an opaque `.App` div, and an in-flow block box's
   * background paints above negative-z content. Placing the two explicitly — backdrop at
   * z-0, blocks at z-10 — puts both in the positioned painting step, where tree order and
   * z-index decide rather than an ancestor's fill.
   *
   * Only the first is used. Two backdrops would stack with one invisible under the other,
   * and silently ignoring the extra beats rendering something nobody can see. */
  const blocks = page.blocks || [];
  const background = blocks.find((b) => b.type === "_background");
  const rest = background ? blocks.filter((b) => b !== background) : blocks;

  return (
    <div data-cms-page={page.slug || slug} className={background ? "relative" : undefined}>
      {background && <BlockRenderer key={background.block_id} block={background} />}
      <div className={background ? "relative z-10" : undefined}>
        {rest.map((b) => <BlockRenderer key={b.block_id} block={b} />)}
      </div>
    </div>
  );
}
