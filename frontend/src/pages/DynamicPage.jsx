import React, { useEffect, useState } from "react";
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
    return <div className="p-16 text-center font-mono-x text-xs uppercase tracking-[0.3em] text-zinc-500">Loading…</div>;
  }
  if (status === "notfound" || !page) {
    // At the root, "not found" means nobody has chosen a homepage — a setting, not a bad
    // URL. Saying "404 Page not found" there sends an editor looking for the wrong fault.
    if (home) {
      return (
        <div className="p-16 text-center">
          <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-zinc-500">Nothing here yet</div>
          <h1 className="font-display text-4xl md:text-6xl uppercase font-black tracking-tighter mt-3">No homepage set</h1>
          <p className="mt-6 text-zinc-400 text-sm">
            Pick one in the CMS — open Navigation and use the ⌂ button on the page that should answer this address.
          </p>
        </div>
      );
    }
    return (
      <div className="p-16 text-center">
        <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-zinc-500">404</div>
        <h1 className="font-display text-4xl md:text-6xl uppercase font-black tracking-tighter mt-3">Page not found</h1>
      </div>
    );
  }

  return (
    <div data-cms-page={page.slug || slug}>
      {(page.blocks || []).map((b) => <BlockRenderer key={b.block_id} block={b} />)}
    </div>
  );
}
