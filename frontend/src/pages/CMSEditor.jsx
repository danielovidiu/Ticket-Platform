import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { http } from "../api";
import { useAuth } from "../auth";
import { toast } from "sonner";
import { ChevronUp, ChevronDown, Trash2, Plus, Eye, EyeOff, Undo2, Redo2, Smartphone, Monitor, Palette, FileText, History } from "lucide-react";
import { BlockRenderer } from "../components/blocks";
import { BLOCK_DEFAULTS, BLOCK_LABELS, BLOCK_TYPES, newBlockId, applyTheme } from "../lib/cms";

const AUTOSAVE_MS = 1200;

export default function CMSEditor() {
  const { user, loading } = useAuth();
  const [pages, setPages] = useState([]);
  const [currentId, setCurrentId] = useState(null);
  const [page, setPage] = useState(null);
  const [selectedIdx, setSelectedIdx] = useState(null);
  const [device, setDevice] = useState("desktop");
  const [rightTab, setRightTab] = useState("props"); // props | theme | versions
  const [undoStack, setUndoStack] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  const [savedAt, setSavedAt] = useState(null);
  const [theme, setTheme] = useState(null);
  const [showNewPage, setShowNewPage] = useState(false);

  // Load pages + theme
  useEffect(() => {
    if (!user || (user.role !== "admin" && user.role !== "editor")) return;
    http.get("/admin/cms/pages").then((r) => {
      setPages(r.data);
      if (r.data[0] && !currentId) setCurrentId(r.data[0].page_id);
    });
    http.get("/admin/cms/theme").then((r) => {
      setTheme(r.data);
      applyTheme(r.data.draft || r.data.published);
    });
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load current page
  useEffect(() => {
    if (!currentId) return;
    http.get(`/admin/cms/pages/${currentId}`).then((r) => {
      setPage(r.data);
      setSelectedIdx(null);
      setUndoStack([]); setRedoStack([]);
    });
  }, [currentId]);

  const blocks = page?.draft?.blocks || [];

  // ----- Undo/redo helpers -----
  const commit = useCallback((newBlocks, opts = {}) => {
    if (!page) return;
    setUndoStack((u) => [...u.slice(-49), page.draft.blocks]);
    if (!opts.keepRedo) setRedoStack([]);
    setPage({ ...page, draft: { blocks: newBlocks } });
  }, [page]);

  const undo = () => {
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1];
    setUndoStack((u) => u.slice(0, -1));
    setRedoStack((r) => [...r, page.draft.blocks]);
    setPage({ ...page, draft: { blocks: prev } });
  };
  const redo = () => {
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    setRedoStack((r) => r.slice(0, -1));
    setUndoStack((u) => [...u, page.draft.blocks]);
    setPage({ ...page, draft: { blocks: next } });
  };

  // ----- Autosave -----
  const savingRef = useRef(null);
  useEffect(() => {
    if (!page) return;
    clearTimeout(savingRef.current);
    savingRef.current = setTimeout(async () => {
      try {
        await http.patch(`/admin/cms/pages/${page.page_id}`, { draft: page.draft });
        setSavedAt(Date.now());
      } catch (e) { /* silent */ }
    }, AUTOSAVE_MS);
    return () => clearTimeout(savingRef.current);
  }, [page]);

  // ----- Block ops -----
  const addBlock = (type) => {
    const b = { block_id: newBlockId(), type, enabled: true, props: BLOCK_DEFAULTS[type]() };
    const idx = selectedIdx == null ? blocks.length : selectedIdx + 1;
    const next = [...blocks.slice(0, idx), b, ...blocks.slice(idx)];
    commit(next);
    setSelectedIdx(idx);
  };
  const moveBlock = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= blocks.length) return;
    const next = [...blocks];
    [next[i], next[j]] = [next[j], next[i]];
    commit(next);
    setSelectedIdx(j);
  };
  const removeBlock = (i) => { commit(blocks.filter((_, k) => k !== i)); setSelectedIdx(null); };
  const toggleBlock = (i) => { const next = [...blocks]; next[i] = { ...next[i], enabled: next[i].enabled === false ? true : false }; commit(next); };
  const updateProps = (i, patch) => { const next = [...blocks]; next[i] = { ...next[i], props: { ...next[i].props, ...patch } }; commit(next); };

  // ----- Drag & drop reorder -----
  const dragIdx = useRef(null);
  const onDragStart = (i) => (e) => { dragIdx.current = i; e.dataTransfer.effectAllowed = "move"; };
  const onDragOver = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; };
  const onDrop = (i) => (e) => {
    e.preventDefault();
    const from = dragIdx.current;
    if (from == null || from === i) return;
    const next = [...blocks];
    const [moved] = next.splice(from, 1);
    next.splice(i, 0, moved);
    commit(next); setSelectedIdx(i);
    dragIdx.current = null;
  };

  // ----- Publish / revert -----
  const publish = async () => {
    await http.post(`/admin/cms/pages/${page.page_id}/publish`);
    toast.success("Published live");
    const r = await http.get(`/admin/cms/pages/${page.page_id}`);
    setPage(r.data);
  };
  const revert = async (version_id) => {
    await http.post(`/admin/cms/pages/${page.page_id}/revert/${version_id}`);
    toast.success("Version loaded into draft");
    const r = await http.get(`/admin/cms/pages/${page.page_id}`);
    setPage(r.data); setSelectedIdx(null); setUndoStack([]); setRedoStack([]);
  };

  // ----- Pages CRUD -----
  const createPage = async (slug, title) => {
    const r = await http.post("/admin/cms/pages", { slug, title, nav_label: title });
    setPages([...pages, r.data]);
    setCurrentId(r.data.page_id);
    setShowNewPage(false);
    toast.success("Page created");
  };
  const deletePage = async (pid) => {
    if (!window.confirm("Delete this page?")) return;
    await http.delete(`/admin/cms/pages/${pid}`);
    const r = await http.get("/admin/cms/pages");
    setPages(r.data);
    setCurrentId(r.data[0]?.page_id || null);
  };
  const updatePageMeta = async (patch) => {
    const r = await http.patch(`/admin/cms/pages/${page.page_id}`, patch);
    setPage(r.data);
    const list = await http.get("/admin/cms/pages");
    setPages(list.data);
  };
  const movePage = async (idx, dir) => {
    const j = idx + dir;
    if (j < 0 || j >= pages.length) return;
    const order = pages.map((p) => p.page_id);
    [order[idx], order[j]] = [order[j], order[idx]];
    await http.post("/admin/cms/pages/reorder", { order });
    const r = await http.get("/admin/cms/pages");
    setPages(r.data);
  };

  // ----- Theme -----
  const setThemeDraft = async (patch) => {
    const nextDraft = { ...(theme?.draft || theme?.published || {}), ...patch };
    setTheme({ ...theme, draft: nextDraft });
    applyTheme(nextDraft);
    await http.patch("/admin/cms/theme", { draft: nextDraft });
  };
  const publishTheme = async () => {
    await http.post("/admin/cms/theme/publish");
    toast.success("Theme published");
    const r = await http.get("/admin/cms/theme");
    setTheme(r.data);
  };

  const selectedBlock = selectedIdx != null ? blocks[selectedIdx] : null;

  const savedLabel = useMemo(() => {
    if (!savedAt) return "Not saved";
    const s = Math.floor((Date.now() - savedAt) / 1000);
    return s < 5 ? "Saved just now" : `Saved ${s}s ago`;
  }, [savedAt]);

  if (loading) return <div className="p-16 font-mono-x text-zinc-500">Loading…</div>;
  if (!user || (user.role !== "admin" && user.role !== "editor")) return <div className="p-16 text-center font-mono-x">Access denied. CMS is for admin / editor roles.</div>;

  const previewWidth = device === "mobile" ? "min(420px, 100%)" : "100%";

  return (
    <div className="h-screen flex flex-col bg-[color:var(--bg,#050505)] text-white overflow-hidden">
      {/* TOP BAR */}
      <div className="hairline-b bg-black px-4 py-3 flex items-center gap-3 flex-wrap">
        <div className="font-display uppercase font-black tracking-tighter text-lg">UMBRA<span className="text-[color:var(--accent)]">/</span>CMS</div>
        <div className="hidden md:block h-6 border-l border-white/10 mx-2" />
        <select value={currentId || ""} onChange={(e) => setCurrentId(e.target.value)} data-testid="page-select" className="input-x !py-1.5 !px-2 max-w-[280px]">
          {pages.map((p) => <option key={p.page_id} value={p.page_id}>{p.title} — /p/{p.slug}</option>)}
        </select>
        <button onClick={() => setShowNewPage(true)} data-testid="new-page-btn" className="btn-primary !py-1.5 !px-3 !text-xs"><Plus size={14} className="inline" /> New page</button>

        <div className="flex-1" />

        <div className="hidden md:flex items-center gap-2">
          <button onClick={undo} disabled={undoStack.length === 0} title="Undo" className="p-2 border border-white/20 hover:bg-white hover:text-black disabled:opacity-30 disabled:pointer-events-none"><Undo2 size={14} /></button>
          <button onClick={redo} disabled={redoStack.length === 0} title="Redo" className="p-2 border border-white/20 hover:bg-white hover:text-black disabled:opacity-30 disabled:pointer-events-none"><Redo2 size={14} /></button>
        </div>

        <div className="flex items-center border border-white/20">
          <button onClick={() => setDevice("desktop")} className={`p-2 ${device==="desktop"?"bg-white text-black":""}`}><Monitor size={14} /></button>
          <button onClick={() => setDevice("mobile")} className={`p-2 ${device==="mobile"?"bg-white text-black":""}`}><Smartphone size={14} /></button>
        </div>

        <div className="font-mono-x text-[10px] uppercase tracking-[0.25em] text-zinc-500 hidden md:block">{savedLabel}</div>
        {page && <a href={`/p/${page.slug}`} target="_blank" rel="noreferrer" className="btn-primary !py-1.5 !px-3 !text-xs">View live</a>}
        <button onClick={publish} data-testid="publish-page-btn" className="btn-accent !py-2 !px-4 !text-xs">Publish</button>
      </div>

      {/* MAIN 3-COLUMN */}
      <div className="flex-1 grid grid-cols-12 min-h-0">
        {/* LEFT: pages + blocks */}
        <aside className="col-span-12 md:col-span-3 xl:col-span-2 border-r border-white/10 overflow-y-auto p-3 space-y-4">
          <div>
            <div className="font-mono-x text-[10px] uppercase tracking-[0.3em] text-zinc-500 mb-2">Pages</div>
            <ul className="space-y-1">
              {pages.map((p, i) => (
                <li key={p.page_id} className={`flex items-center justify-between border px-2 py-1.5 text-xs ${p.page_id === currentId ? "border-white bg-white/10" : "border-white/10"}`}>
                  <button onClick={() => setCurrentId(p.page_id)} className="text-left flex-1 truncate">{p.title}</button>
                  <div className="flex items-center gap-1">
                    <button onClick={() => movePage(i, -1)} className="text-zinc-500 hover:text-white"><ChevronUp size={12} /></button>
                    <button onClick={() => movePage(i, 1)} className="text-zinc-500 hover:text-white"><ChevronDown size={12} /></button>
                    <button onClick={() => deletePage(p.page_id)} className="text-zinc-500 hover:text-[color:var(--accent)]"><Trash2 size={12} /></button>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <div className="font-mono-x text-[10px] uppercase tracking-[0.3em] text-zinc-500 mb-2">Add block</div>
            <div className="grid grid-cols-2 gap-1">
              {BLOCK_TYPES.map((t) => (
                <button key={t} onClick={() => addBlock(t)} data-testid={`add-block-${t}`} className="text-left border border-white/10 hover:border-white p-2 text-[11px] uppercase tracking-wider">{BLOCK_LABELS[t]}</button>
              ))}
            </div>
          </div>

          {page && (
            <div>
              <div className="font-mono-x text-[10px] uppercase tracking-[0.3em] text-zinc-500 mb-2">Structure</div>
              <ul className="space-y-1">
                {blocks.map((b, i) => (
                  <li key={b.block_id}
                      draggable
                      onDragStart={onDragStart(i)}
                      onDragOver={onDragOver}
                      onDrop={onDrop(i)}
                      className={`flex items-center gap-1 border px-2 py-1.5 text-xs cursor-move ${i === selectedIdx ? "border-white bg-white/10" : "border-white/10"} ${b.enabled === false ? "opacity-40" : ""}`}>
                    <button onClick={() => setSelectedIdx(i)} className="text-left flex-1 truncate">{BLOCK_LABELS[b.type] || b.type}</button>
                    <button onClick={() => toggleBlock(i)} title="Toggle visibility" className="text-zinc-500 hover:text-white">{b.enabled === false ? <EyeOff size={12} /> : <Eye size={12} />}</button>
                    <button onClick={() => moveBlock(i, -1)} className="text-zinc-500 hover:text-white"><ChevronUp size={12} /></button>
                    <button onClick={() => moveBlock(i, 1)} className="text-zinc-500 hover:text-white"><ChevronDown size={12} /></button>
                    <button onClick={() => removeBlock(i)} className="text-zinc-500 hover:text-[color:var(--accent)]"><Trash2 size={12} /></button>
                  </li>
                ))}
                {blocks.length === 0 && <li className="text-zinc-500 text-xs border border-dashed border-white/10 p-3 text-center">Empty page — pick a block above</li>}
              </ul>
            </div>
          )}
        </aside>

        {/* CENTER: live preview */}
        <main className="col-span-12 md:col-span-6 xl:col-span-7 overflow-y-auto bg-[color:var(--bg,#050505)]" data-testid="cms-preview">
          <div className="mx-auto py-4 transition-all duration-300" style={{ width: previewWidth }}>
            <div className="border border-white/10">
              {page ? (
                blocks.length === 0 ? (
                  <div className="p-24 text-center text-zinc-500 font-mono-x text-xs uppercase tracking-[0.3em]">
                    Empty. Add blocks from the left.
                  </div>
                ) : (
                  blocks.map((b, i) => (
                    <div key={b.block_id}
                         onClick={() => setSelectedIdx(i)}
                         className={`relative group cursor-pointer ${i === selectedIdx ? "outline outline-2 outline-[color:var(--accent)]" : "hover:outline hover:outline-1 hover:outline-white/40"}`}>
                      <div className={`absolute top-2 left-2 z-30 font-mono-x text-[9px] uppercase tracking-[0.2em] bg-black text-white px-2 py-1 border border-white/20 ${i === selectedIdx ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>{BLOCK_LABELS[b.type]}</div>
                      <BlockRenderer block={b} />
                    </div>
                  ))
                )
              ) : (
                <div className="p-24 text-center text-zinc-500 font-mono-x text-xs uppercase tracking-[0.3em]">Select or create a page</div>
              )}
            </div>
          </div>
        </main>

        {/* RIGHT: properties / theme / versions */}
        <aside className="col-span-12 md:col-span-3 border-l border-white/10 overflow-y-auto">
          <div className="flex border-b border-white/10">
            <button onClick={() => setRightTab("props")} className={`flex-1 py-2 text-[11px] uppercase tracking-[0.2em] font-mono-x ${rightTab==="props"?"bg-white text-black":""}`}><FileText size={12} className="inline mr-1" /> Props</button>
            <button onClick={() => setRightTab("theme")} className={`flex-1 py-2 text-[11px] uppercase tracking-[0.2em] font-mono-x ${rightTab==="theme"?"bg-white text-black":""}`}><Palette size={12} className="inline mr-1" /> Theme</button>
            <button onClick={() => setRightTab("versions")} className={`flex-1 py-2 text-[11px] uppercase tracking-[0.2em] font-mono-x ${rightTab==="versions"?"bg-white text-black":""}`}><History size={12} className="inline mr-1" /> Versions</button>
          </div>

          <div className="p-4">
            {rightTab === "props" && (selectedBlock ? (
              <PropsEditor block={selectedBlock} onChange={(patch) => updateProps(selectedIdx, patch)} pageMeta={page} onPageMeta={updatePageMeta} />
            ) : page ? (
              <PageMetaEditor page={page} onChange={updatePageMeta} />
            ) : null)}
            {rightTab === "theme" && theme && (
              <ThemeEditor theme={theme.draft || theme.published} onChange={setThemeDraft} onPublish={publishTheme} />
            )}
            {rightTab === "versions" && page && (
              <VersionList page={page} onRevert={revert} />
            )}
          </div>
        </aside>
      </div>

      {showNewPage && <NewPageModal onClose={() => setShowNewPage(false)} onCreate={createPage} />}
    </div>
  );
}

// -------------- Props editor --------------
const FIELDS = {
  hero: [
    { k: "eyebrow", label: "Eyebrow (small caps)" },
    { k: "heading", label: "Heading", type: "textarea" },
    { k: "body", label: "Body", type: "textarea" },
    { k: "image_url", label: "Background image URL" },
    { k: "cta_label", label: "Primary CTA label" },
    { k: "cta_href", label: "Primary CTA link" },
    { k: "cta_style", label: "Primary CTA style", type: "select", options: ["accent", "outline"] },
    { k: "second_cta_label", label: "Secondary CTA label" },
    { k: "second_cta_href", label: "Secondary CTA link" },
    { k: "align", label: "Align", type: "select", options: ["left", "center", "right"] },
    { k: "height", label: "Height", type: "select", options: ["short", "medium", "tall"] },
  ],
  rich_text: [{ k: "content", label: "Content (markdown-ish)", type: "textarea", rows: 12 }],
  image: [
    { k: "image_url", label: "Image URL" },
    { k: "caption", label: "Caption" },
    { k: "full_width", label: "Full width", type: "checkbox" },
  ],
  gallery_grid: [
    { k: "heading", label: "Heading" },
    { k: "limit", label: "Max items", type: "number" },
  ],
  events_grid: [
    { k: "eyebrow", label: "Eyebrow" },
    { k: "heading", label: "Heading" },
    { k: "limit", label: "Max events", type: "number" },
    { k: "layout", label: "Layout", type: "select", options: ["grid-1", "grid-2", "grid-3"] },
  ],
  artists_grid: [
    { k: "eyebrow", label: "Eyebrow" },
    { k: "heading", label: "Heading" },
    { k: "limit", label: "Max artists", type: "number" },
    { k: "layout", label: "Layout", type: "select", options: ["grid-2", "grid-3", "grid-4"] },
  ],
  marquee: [{ k: "items", label: "Items (one per line)", type: "list" }],
  cta_banner: [
    { k: "heading", label: "Heading", type: "textarea" },
    { k: "body", label: "Body", type: "textarea" },
    { k: "cta_label", label: "Button label" },
    { k: "cta_href", label: "Button link" },
  ],
  contact_form: [
    { k: "heading", label: "Heading" },
    { k: "success_message", label: "Success message" },
  ],
  newsletter: [
    { k: "heading", label: "Heading" },
    { k: "body", label: "Body" },
    { k: "cta_label", label: "Button label" },
  ],
  video: [
    { k: "url", label: "YouTube / Vimeo URL" },
    { k: "caption", label: "Caption" },
  ],
  custom_html: [{ k: "html", label: "HTML", type: "textarea", rows: 10 }],
  spacer: [{ k: "height", label: "Height (e.g. 4rem, 120px)" }],
  split: [
    { k: "direction", label: "Direction", type: "select", options: ["image-left", "image-right"] },
    { k: "image_url", label: "Image URL" },
    { k: "eyebrow", label: "Eyebrow" },
    { k: "heading", label: "Heading" },
    { k: "body", label: "Body", type: "textarea" },
    { k: "cta_label", label: "CTA label" },
    { k: "cta_href", label: "CTA link" },
  ],
};

function PropsEditor({ block, onChange }) {
  const fields = FIELDS[block.type] || [];
  const v = block.props || {};
  return (
    <div className="space-y-4">
      <div className="font-mono-x text-[10px] uppercase tracking-[0.3em] text-zinc-500">{BLOCK_LABELS[block.type]}</div>
      {fields.map((f) => (
        <label key={f.k} className="block">
          <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-400 font-mono-x mb-1">{f.label}</div>
          {f.type === "textarea" ? (
            <textarea rows={f.rows || 4} value={v[f.k] || ""} onChange={(e) => onChange({ [f.k]: e.target.value })} className="input-x !py-2 !text-sm" />
          ) : f.type === "select" ? (
            <select value={v[f.k] || ""} onChange={(e) => onChange({ [f.k]: e.target.value })} className="input-x !py-2 !text-sm">
              {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : f.type === "checkbox" ? (
            <div className="flex items-center gap-2 pt-1"><input type="checkbox" checked={!!v[f.k]} onChange={(e) => onChange({ [f.k]: e.target.checked })} /> <span className="text-xs text-zinc-400">{f.label}</span></div>
          ) : f.type === "number" ? (
            <input type="number" value={v[f.k] ?? ""} onChange={(e) => onChange({ [f.k]: Number(e.target.value) })} className="input-x !py-2 !text-sm" />
          ) : f.type === "list" ? (
            <textarea rows={5} value={(v[f.k] || []).join("\n")} onChange={(e) => onChange({ [f.k]: e.target.value.split("\n").filter(Boolean) })} className="input-x !py-2 !text-sm font-mono-x" />
          ) : (
            <input value={v[f.k] || ""} onChange={(e) => onChange({ [f.k]: e.target.value })} className="input-x !py-2 !text-sm" />
          )}
        </label>
      ))}
    </div>
  );
}

function PageMetaEditor({ page, onChange }) {
  return (
    <div className="space-y-3">
      <div className="font-mono-x text-[10px] uppercase tracking-[0.3em] text-zinc-500">Page</div>
      <label className="block">
        <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-400 font-mono-x mb-1">Title</div>
        <input value={page.title} onChange={(e) => onChange({ title: e.target.value })} className="input-x !py-2 !text-sm" />
      </label>
      <label className="block">
        <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-400 font-mono-x mb-1">Nav label</div>
        <input value={page.nav_label || page.title} onChange={(e) => onChange({ nav_label: e.target.value })} className="input-x !py-2 !text-sm" />
      </label>
      <label className="block flex items-center gap-2 mt-2"><input type="checkbox" checked={!!page.in_nav} onChange={(e) => onChange({ in_nav: e.target.checked })} /> <span className="text-xs text-zinc-300">Show in main navigation</span></label>
      <div className="pt-3 text-xs text-zinc-500">
        Slug: <span className="font-mono-x">/p/{page.slug}</span> (immutable)<br />
        Tip: click any block in the preview to edit its properties here.
      </div>
    </div>
  );
}

function ThemeEditor({ theme, onChange, onPublish }) {
  const setColor = (k, v) => onChange({ colors: { ...(theme.colors || {}), [k]: v } });
  const setFont = (k, v) => onChange({ fonts: { ...(theme.fonts || {}), [k]: v } });
  const fontChoices = ["Clash Display", "Space Grotesk", "Inter", "Manrope", "Playfair Display", "IBM Plex Mono", "JetBrains Mono", "Archivo", "Bebas Neue", "Anton"];
  return (
    <div className="space-y-4">
      <div className="font-mono-x text-[10px] uppercase tracking-[0.3em] text-zinc-500">Colors</div>
      {[["bg", "Background"], ["surface", "Surface"], ["text", "Text"], ["textMuted", "Text muted"], ["accent", "Accent"], ["accentFg", "Accent text"], ["success", "Success"]].map(([k, label]) => (
        <label key={k} className="block">
          <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-400 font-mono-x mb-1">{label}</div>
          <div className="flex items-center gap-2">
            <input type="color" value={theme.colors?.[k] || "#000000"} onChange={(e) => setColor(k, e.target.value)} className="w-10 h-10 bg-transparent border border-white/20" />
            <input value={theme.colors?.[k] || ""} onChange={(e) => setColor(k, e.target.value)} className="input-x !py-1.5 !text-xs font-mono-x flex-1" />
          </div>
        </label>
      ))}

      <div className="font-mono-x text-[10px] uppercase tracking-[0.3em] text-zinc-500 pt-4">Fonts</div>
      {[["display", "Display / headings"], ["body", "Body"], ["mono", "Mono / labels"]].map(([k, label]) => (
        <label key={k} className="block">
          <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-400 font-mono-x mb-1">{label}</div>
          <select value={theme.fonts?.[k] || ""} onChange={(e) => setFont(k, e.target.value)} className="input-x !py-2 !text-sm">
            {fontChoices.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </label>
      ))}

      <div className="font-mono-x text-[10px] uppercase tracking-[0.3em] text-zinc-500 pt-4">Layout</div>
      <label className="block">
        <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-400 font-mono-x mb-1">Border radius: {theme.radius || 0}px</div>
        <input type="range" min="0" max="24" value={theme.radius || 0} onChange={(e) => onChange({ radius: Number(e.target.value) })} className="w-full" />
      </label>
      <label className="block">
        <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-400 font-mono-x mb-1">Button style</div>
        <select value={theme.button_style || "sharp"} onChange={(e) => onChange({ button_style: e.target.value })} className="input-x !py-2 !text-sm">
          <option value="sharp">Sharp (0px)</option>
          <option value="pill">Pill (fully rounded)</option>
        </select>
      </label>
      <label className="block">
        <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-400 font-mono-x mb-1">Mode</div>
        <select value={theme.mode || "dark"} onChange={(e) => onChange({ mode: e.target.value })} className="input-x !py-2 !text-sm">
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </label>

      <button onClick={onPublish} data-testid="publish-theme-btn" className="btn-accent w-full mt-6">PUBLISH THEME</button>
    </div>
  );
}

function VersionList({ page, onRevert }) {
  const versions = page.versions || [];
  return (
    <div className="space-y-2">
      <div className="font-mono-x text-[10px] uppercase tracking-[0.3em] text-zinc-500">History (last {versions.length})</div>
      {versions.length === 0 && <div className="text-xs text-zinc-500 border border-dashed border-white/10 p-3">Publish once to create the first version.</div>}
      {versions.map((v) => (
        <div key={v.version_id} className="border border-white/10 p-2 flex items-center justify-between">
          <div>
            <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-zinc-500">{new Date(v.published_at).toLocaleString("en-GB")}</div>
            <div className="text-xs">{v.blocks?.length || 0} blocks</div>
          </div>
          <button onClick={() => onRevert(v.version_id)} className="btn-primary !py-1.5 !px-2 !text-[10px]">Revert</button>
        </div>
      ))}
    </div>
  );
}

function NewPageModal({ onClose, onCreate }) {
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  return (
    <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
      <div className="border border-white/20 bg-[color:var(--surface,#0F0F0F)] p-6 w-full max-w-md space-y-3">
        <div className="font-display uppercase text-xl font-black tracking-tighter">New Page</div>
        <input placeholder="Title (e.g. About)" value={title} onChange={(e) => { setTitle(e.target.value); setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")); }} className="input-x" />
        <input placeholder="slug" value={slug} onChange={(e) => setSlug(e.target.value)} className="input-x font-mono-x" />
        <div className="text-xs text-zinc-500">URL will be <span className="font-mono-x">/p/{slug || "…"}</span></div>
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="btn-primary">Cancel</button>
          <button onClick={() => title && slug && onCreate(slug, title)} data-testid="create-page-btn" className="btn-accent">Create</button>
        </div>
      </div>
    </div>
  );
}
