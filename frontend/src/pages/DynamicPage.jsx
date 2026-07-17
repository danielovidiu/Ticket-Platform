import React, { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { http } from "../api";
import { BlockRenderer } from "../components/blocks";

export default function DynamicPage({ slugOverride }) {
  const params = useParams();
  const slug = slugOverride || params.slug;
  const [page, setPage] = useState(null);
  const [status, setStatus] = useState("loading");

  useEffect(() => {
    setStatus("loading");
    http.get(`/cms/pages/${slug}`)
      .then((r) => { setPage(r.data); setStatus("ok"); })
      .catch(() => setStatus("notfound"));
  }, [slug]);

  if (status === "loading") {
    return <div className="p-16 text-center font-mono-x text-xs uppercase tracking-[0.3em] text-zinc-500">Loading…</div>;
  }
  if (status === "notfound" || !page) {
    return (
      <div className="p-16 text-center">
        <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-zinc-500">404</div>
        <h1 className="font-display text-4xl md:text-6xl uppercase font-black tracking-tighter mt-3">Page not found</h1>
      </div>
    );
  }

  return (
    <div data-cms-page={slug}>
      {(page.blocks || []).map((b) => <BlockRenderer key={b.block_id} block={b} />)}
    </div>
  );
}
