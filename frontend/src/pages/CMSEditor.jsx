import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { http } from "../api";
import { useAuth } from "../auth";
import { toast } from "sonner";
import { ChevronUp, ChevronDown, Trash2, Plus, Eye, EyeOff, Undo2, Redo2, Smartphone, Monitor, Palette, FileText, History } from "lucide-react";
import { BlockRenderer } from "../components/blocks";
import { BLOCK_DEFAULTS, BLOCK_LABELS, BLOCK_TYPES, newBlockId, applyTheme } from "../lib/cms";
import { FormatToolbar } from "../lib/richText";
import ImageField from "../components/ImageField";

// Wait this long after the last edit before saving...
const AUTOSAVE_MS = 1200;
// ...but never leave work unsaved for longer than this. The debounce alone resets on
// every keystroke, so someone typing steadily for two minutes had nothing persisted for
// two minutes.
const AUTOSAVE_MAX_WAIT_MS = 5000;
// Consecutive edits to the SAME field within this window collapse into one undo entry.
// Without it every keystroke pushed its own, and the 50-step history held less than a
// sentence. Must stay above FIELD_MAX_WAIT_MS, or a continuous typing run would outpace
// the window and fragment into an entry per push.
const HISTORY_COALESCE_MS = 900;
const HISTORY_LIMIT = 50;

export default function CMSEditor() {
  const { user, loading } = useAuth();
  const [pages, setPages] = useState([]);
  const [currentId, setCurrentId] = useState(null);
  const [page, setPage] = useState(null);
  // Selection is by block_id, not index: edits are debounced now, so a commit can land
  // after the selection moved and an index would by then point at a different block.
  const [selectedId, setSelectedId] = useState(null);
  const [device, setDevice] = useState("desktop");
  const [rightTab, setRightTab] = useState("props"); // props | theme | versions
  const [savedAt, setSavedAt] = useState(null);
  const [saveState, setSaveState] = useState("idle"); // idle | saving | saved | error
  const [dirty, setDirty] = useState(false);
  const [theme, setTheme] = useState(null);
  const [showNewPage, setShowNewPage] = useState(false);

  // `page` drives rendering; pageRef is what mutations read. It is updated synchronously
  // inside commit(), so two edits in the same tick still compose instead of the second
  // overwriting the first from a stale render snapshot.
  const pageRef = useRef(null);
  // History lives in refs rather than state: pushing it from inside a setState updater
  // would double up under StrictMode, and nothing renders from the entries themselves.
  const undoRef = useRef([]);
  const redoRef = useRef([]);
  const [historyTick, setHistoryTick] = useState(0); // re-renders the undo/redo buttons
  const lastEditRef = useRef({ key: null, at: 0 });
  const savedDraftRef = useRef(null); // identity of the last draft the server acknowledged
  const dirtySinceRef = useRef(0);
  const [revision, setRevision] = useState(0); // bumps per edit; re-arms the save timer

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

  /** Adopt a page straight from the server: nothing to save, no history behind it. */
  const loadPage = useCallback((p) => {
    pageRef.current = p;
    savedDraftRef.current = p?.draft || null;
    setPage(p);
    setDirty(false);
    setSaveState("idle");
    undoRef.current = [];
    redoRef.current = [];
    lastEditRef.current = { key: null, at: 0 };
    setHistoryTick((t) => t + 1);
  }, []);

  // Load current page
  useEffect(() => {
    if (!currentId) return;
    http.get(`/admin/cms/pages/${currentId}`).then((r) => {
      loadPage(r.data);
      setSelectedId(null);
    });
  }, [currentId, loadPage]);

  // Memoized so the empty-page fallback isn't a fresh array identity on every render,
  // which would defeat the memoization downstream of it.
  const blocks = useMemo(() => page?.draft?.blocks || [], [page]);

  // ----- History -----
  /** Record the pre-edit state, unless this edit continues the previous one.
   *
   * `coalesceKey` identifies "the same thing being edited" — one block's one field.
   * Typing runs push a commit every few hundred ms, and collapsing them means undo
   * steps back over a whole phrase instead of one letter. Structural edits pass no key
   * and therefore always get their own entry. */
  const pushHistory = useCallback((prevBlocks, coalesceKey) => {
    const now = Date.now();
    const last = lastEditRef.current;
    const continues = coalesceKey != null && coalesceKey === last.key && now - last.at < HISTORY_COALESCE_MS;
    lastEditRef.current = { key: coalesceKey ?? null, at: now };
    if (continues) return;
    undoRef.current = [...undoRef.current.slice(-(HISTORY_LIMIT - 1)), prevBlocks];
    redoRef.current = [];
    setHistoryTick((t) => t + 1);
  }, []);

  /** The single write path for the draft.
   *
   * Takes an updater over the CURRENT blocks (read from pageRef, which is written
   * synchronously below) rather than a precomputed array off a render snapshot, so a
   * debounced field commit that lands late still composes with whatever happened since.
   * Returning the same array means "nothing changed" and is a no-op. */
  const commit = useCallback((updater, coalesceKey) => {
    const prev = pageRef.current;
    if (!prev) return;
    const prevBlocks = prev.draft.blocks;
    const nextBlocks = typeof updater === "function" ? updater(prevBlocks) : updater;
    if (nextBlocks === prevBlocks) return;

    pushHistory(prevBlocks, coalesceKey);
    const nextPage = { ...prev, draft: { blocks: nextBlocks } };
    pageRef.current = nextPage;
    setPage(nextPage);
    if (!dirtySinceRef.current) dirtySinceRef.current = Date.now();
    setDirty(true);
    setRevision((r) => r + 1);
  }, [pushHistory]);

  const applyHistory = useCallback((from, to) => {
    const prev = pageRef.current;
    if (!prev || from.current.length === 0) return;
    const blocksToApply = from.current[from.current.length - 1];
    from.current = from.current.slice(0, -1);
    to.current = [...to.current, prev.draft.blocks];
    // An undo must never be folded into the typing run that preceded it.
    lastEditRef.current = { key: null, at: 0 };
    const nextPage = { ...prev, draft: { blocks: blocksToApply } };
    pageRef.current = nextPage;
    setPage(nextPage);
    if (!dirtySinceRef.current) dirtySinceRef.current = Date.now();
    setDirty(true);
    setRevision((r) => r + 1);
    setHistoryTick((t) => t + 1);
  }, []);

  const undo = useCallback(() => applyHistory(undoRef, redoRef), [applyHistory]);
  const redo = useCallback(() => applyHistory(redoRef, undoRef), [applyHistory]);

  // ----- Saving -----
  const inFlightRef = useRef(false);
  const queuedRef = useRef(false);

  /** Write the current draft. Never runs two requests at once: a save requested while
   * one is in flight is queued and re-run with the newest draft afterwards, so a slow
   * request can't land after a newer one and resurrect stale content. */
  const saveNow = useCallback(async () => {
    const p = pageRef.current;
    if (!p) return;
    if (p.draft === savedDraftRef.current) return; // nothing new
    if (inFlightRef.current) { queuedRef.current = true; return; }

    const snapshot = p.draft;
    inFlightRef.current = true;
    setSaveState("saving");
    try {
      await http.patch(`/admin/cms/pages/${p.page_id}`, { draft: snapshot });
      savedDraftRef.current = snapshot;
      setSavedAt(Date.now());
      setSaveState("saved");
      // Only clear the flag if nothing was typed while the request was in the air.
      if (pageRef.current?.draft === snapshot) {
        setDirty(false);
        dirtySinceRef.current = 0;
      }
    } catch {
      // Failures used to be swallowed, which left the editor claiming "Saved just now"
      // while the work existed only in this tab. The next edit re-arms the timer, so
      // this retries on its own; the status line says so meanwhile.
      setSaveState("error");
    } finally {
      inFlightRef.current = false;
      if (queuedRef.current) { queuedRef.current = false; saveNow(); }
    }
  }, []);

  // Debounced, but with a ceiling: the plain debounce reset on every keystroke, so
  // continuous typing was never interrupted long enough to trigger a save at all.
  useEffect(() => {
    if (!dirty) return undefined;
    const elapsed = dirtySinceRef.current ? Date.now() - dirtySinceRef.current : 0;
    const wait = Math.max(0, Math.min(AUTOSAVE_MS, AUTOSAVE_MAX_WAIT_MS - elapsed));
    const t = setTimeout(saveNow, wait);
    return () => clearTimeout(t);
  }, [revision, dirty, saveNow]);

  // Last lines of defence for work still sitting in the debounce window.
  useEffect(() => {
    const onBeforeUnload = (e) => {
      if (pageRef.current && pageRef.current.draft !== savedDraftRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    const onVisibility = () => { if (document.visibilityState === "hidden") saveNow(); };
    const onKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); saveNow(); }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [saveNow]);

  /** Switching pages replaces `page` wholesale — flush first or the last edit is lost. */
  const selectPage = useCallback((pid) => {
    if (pid === pageRef.current?.page_id) return;
    saveNow();
    setCurrentId(pid);
  }, [saveNow]);

  // ----- Block ops -----
  const selectBlock = useCallback((id) => setSelectedId(id), []);

  const addBlock = (type) => {
    const b = { block_id: newBlockId(), type, enabled: true, props: BLOCK_DEFAULTS[type]() };
    commit((prev) => {
      const after = prev.findIndex((x) => x.block_id === selectedId);
      const idx = after < 0 ? prev.length : after + 1;
      return [...prev.slice(0, idx), b, ...prev.slice(idx)];
    });
    setSelectedId(b.block_id);
  };
  const moveBlock = (i, dir) => {
    commit((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };
  const removeBlock = (i) => {
    const removed = blocks[i];
    commit((prev) => prev.filter((_, k) => k !== i));
    if (removed && removed.block_id === selectedId) setSelectedId(null);
  };
  const toggleBlock = (i) => commit((prev) => {
    const next = [...prev];
    next[i] = { ...next[i], enabled: next[i].enabled === false };
    return next;
  });
  /** Targets a block by id, so a debounced field commit still hits the right block even
   * if the selection moved while it was pending. */
  const updateProps = useCallback((blockId, patch, coalesceKey) => {
    commit(
      (prev) => prev.map((b) => (b.block_id === blockId ? { ...b, props: { ...b.props, ...patch } } : b)),
      coalesceKey,
    );
  }, [commit]);

  // ----- Drag & drop reorder -----
  const dragIdx = useRef(null);
  const onDragStart = (i) => (e) => { dragIdx.current = i; e.dataTransfer.effectAllowed = "move"; };
  const onDragOver = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; };
  const onDrop = (i) => (e) => {
    e.preventDefault();
    const from = dragIdx.current;
    dragIdx.current = null;
    if (from == null || from === i) return;
    commit((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(i, 0, moved);
      return next;
    });
  };

  // ----- Publish / revert -----
  const publish = async () => {
    // Publish snapshots what the SERVER holds as the draft, so anything still sitting in
    // the debounce window has to go up first or it silently doesn't get published.
    await saveNow();
    await http.post(`/admin/cms/pages/${page.page_id}/publish`);
    toast.success("Published live");
    const r = await http.get(`/admin/cms/pages/${page.page_id}`);
    loadPage(r.data);
  };
  const revert = async (version_id) => {
    await http.post(`/admin/cms/pages/${page.page_id}/revert/${version_id}`);
    toast.success("Version loaded into draft");
    const r = await http.get(`/admin/cms/pages/${page.page_id}`);
    loadPage(r.data);
    setSelectedId(null);
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
    // The response carries the server's copy of the draft, which is behind whatever is
    // pending locally — keep the local draft and take only the metadata.
    const r = await http.patch(`/admin/cms/pages/${page.page_id}`, patch);
    const merged = { ...r.data, draft: pageRef.current?.draft || r.data.draft };
    pageRef.current = merged;
    setPage(merged);
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

  const selectedBlock = useMemo(
    () => (selectedId ? blocks.find((b) => b.block_id === selectedId) || null : null),
    [blocks, selectedId],
  );

  if (loading) return <div className="p-16 font-mono-x text-zinc-500">Loading…</div>;
  if (!user || (user.role !== "admin" && user.role !== "editor")) return <div className="p-16 text-center font-mono-x">Access denied. CMS is for admin / editor roles.</div>;

  const previewWidth = device === "mobile" ? "min(420px, 100%)" : "100%";

  return (
    <div className="h-full flex flex-col bg-[color:var(--bg,#050505)] text-white overflow-hidden">
      {/* TOP BAR */}
      <div className="hairline-b bg-black px-4 py-3 flex items-center gap-3 flex-wrap">
        <div className="font-display uppercase font-black tracking-tighter text-lg">SUPERSANITY<span className="text-[color:var(--accent)]">/</span>CMS</div>
        <div className="hidden md:block h-6 border-l border-white/10 mx-2" />
        <select value={currentId || ""} onChange={(e) => selectPage(e.target.value)} data-testid="page-select" className="input-x !py-1.5 !px-2 max-w-[280px]">
          {pages.map((p) => <option key={p.page_id} value={p.page_id}>{p.title} — /p/{p.slug}</option>)}
        </select>
        <button onClick={() => setShowNewPage(true)} data-testid="new-page-btn" className="btn-primary !py-1.5 !px-3 !text-xs"><Plus size={14} className="inline" /> New page</button>

        <div className="flex-1" />

        <div className="hidden md:flex items-center gap-2">
          {/* historyTick is read here purely so these two re-render when the ref-held
              stacks change; the entries themselves never drive a render. */}
          <button onClick={undo} disabled={historyTick >= 0 && undoRef.current.length === 0} title="Undo" data-testid="cms-undo" className="p-2 border border-white/20 hover:bg-white hover:text-black disabled:opacity-30 disabled:pointer-events-none"><Undo2 size={14} /></button>
          <button onClick={redo} disabled={redoRef.current.length === 0} title="Redo" data-testid="cms-redo" className="p-2 border border-white/20 hover:bg-white hover:text-black disabled:opacity-30 disabled:pointer-events-none"><Redo2 size={14} /></button>
        </div>

        <div className="flex items-center border border-white/20">
          <button onClick={() => setDevice("desktop")} className={`p-2 ${device==="desktop"?"bg-white text-black":""}`}><Monitor size={14} /></button>
          <button onClick={() => setDevice("mobile")} className={`p-2 ${device==="mobile"?"bg-white text-black":""}`}><Smartphone size={14} /></button>
        </div>

        <SaveStatus state={saveState} savedAt={savedAt} dirty={dirty} />
        <button onClick={saveNow} disabled={!dirty && saveState !== "error"} title="Save draft now (⌘S)"
                data-testid="save-draft-btn" className="btn-primary !py-1.5 !px-3 !text-xs disabled:opacity-30">
          Save now
        </button>
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
                  <button onClick={() => selectPage(p.page_id)} className="text-left flex-1 truncate">{p.title}</button>
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
                      className={`flex items-center gap-1 border px-2 py-1.5 text-xs cursor-move ${b.block_id === selectedId ? "border-white bg-white/10" : "border-white/10"} ${b.enabled === false ? "opacity-40" : ""}`}>
                    <button onClick={() => selectBlock(b.block_id)} className="text-left flex-1 truncate">{BLOCK_LABELS[b.type] || b.type}</button>
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
                  blocks.map((b) => (
                    <PreviewBlock key={b.block_id} block={b} selected={b.block_id === selectedId} onSelect={selectBlock} />
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
              <PropsEditor block={selectedBlock} onChange={updateProps} pageMeta={page} onPageMeta={updatePageMeta} />
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

/** One block in the live preview.
 *
 * Memoized, and that is the point: without it every keystroke re-rendered every block on
 * the page, because the props inputs are driven from the editor's top-level state. Only
 * the block whose props actually changed (plus the two whose selection outline moved)
 * re-renders now. `onSelect` must stay referentially stable for this to hold. */
const PreviewBlock = React.memo(function PreviewBlock({ block, selected, onSelect }) {
  return (
    <div onClick={() => onSelect(block.block_id)}
         className={`relative group cursor-pointer ${selected ? "outline outline-2 outline-[color:var(--accent)]" : "hover:outline hover:outline-1 hover:outline-white/40"}`}>
      <div className={`absolute top-2 left-2 z-30 font-mono-x text-[9px] uppercase tracking-[0.2em] bg-black text-white px-2 py-1 border border-white/20 ${selected ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
        {BLOCK_LABELS[block.type]}
      </div>
      <BlockRenderer block={block} />
    </div>
  );
});

/** Honest save indicator. Its own component with its own interval, so the clock ticking
 * doesn't re-render the editor (and the preview) every few seconds. The label it replaced
 * was memoized on the save timestamp, so it read "Saved just now" indefinitely — including
 * while there were unsaved changes sitting in the debounce window. */
function SaveStatus({ state, savedAt, dirty }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);

  // A freshly opened page has nothing pending — the server's draft is what's on screen.
  let label = "No changes";
  let tone = "text-zinc-500";
  if (state === "saving") { label = "Saving…"; }
  else if (state === "error") { label = "Save failed — retrying"; tone = "text-[color:var(--accent)]"; }
  else if (dirty) { label = "Unsaved changes"; tone = "text-white"; }
  else if (savedAt) {
    const s = Math.floor((Date.now() - savedAt) / 1000);
    label = s < 5 ? "Saved just now" : s < 60 ? `Saved ${s}s ago` : `Saved ${Math.floor(s / 60)}m ago`;
  }
  return (
    <div data-testid="cms-save-status" className={`font-mono-x text-[10px] uppercase tracking-[0.25em] hidden md:block ${tone}`}>
      {label}
    </div>
  );
}

// -------------- Props editor --------------

// Text fields keep their own value while you type and push upward on this delay. Binding
// them straight to the editor's state meant a full preview re-render inside every
// keystroke, and once that render outlasts the gap between two keys, React writes the
// older state back into the input and the characters typed in between are lost.
const FIELD_DEBOUNCE_MS = 250;
// ...and the same ceiling the autosave needs, for the same reason: a debounce that resets
// on every keystroke never elapses for someone typing steadily, which would freeze the
// preview mid-sentence and starve the autosave of anything to save. Kept below
// HISTORY_COALESCE_MS so a continuous run still collapses into one undo entry.
const FIELD_MAX_WAIT_MS = 600;

function useDebouncedField(external, onCommit) {
  const [local, setLocal] = useState(external);
  const localRef = useRef(external);
  const pushedRef = useRef(external);
  const timer = useRef(null);
  const pendingSinceRef = useRef(0);
  // The commit callback changes identity every render; a pending timeout must call the
  // latest one rather than the closure it was created with.
  const commitRef = useRef(onCommit);
  useEffect(() => { commitRef.current = onCommit; });

  // Adopt changes that came from somewhere else — undo, revert, a version being loaded.
  // Values this field pushed itself come back identical and are ignored, which is what
  // keeps the caret from jumping mid-word.
  useEffect(() => {
    if (external !== pushedRef.current) {
      pushedRef.current = external;
      localRef.current = external;
      setLocal(external);
    }
  }, [external]);

  const push = useCallback((val) => {
    pushedRef.current = val;
    pendingSinceRef.current = 0;
    commitRef.current(val);
  }, []);

  const onChange = useCallback((val) => {
    localRef.current = val;
    setLocal(val);
    if (!pendingSinceRef.current) pendingSinceRef.current = Date.now();
    const waited = Date.now() - pendingSinceRef.current;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => push(val), Math.max(0, Math.min(FIELD_DEBOUNCE_MS, FIELD_MAX_WAIT_MS - waited)));
  }, [push]);

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    if (localRef.current !== pushedRef.current) push(localRef.current);
  }, [push]);

  // Blur covers clicking away; unmount covers switching block or page mid-word. Commits
  // target the block by id, so a flush landing after the selection moved is still safe.
  useEffect(() => () => {
    clearTimeout(timer.current);
    if (localRef.current !== pushedRef.current) push(localRef.current);
  }, [push]);

  return { local, onChange, flush };
}

function TextField({ value, onCommit, testId }) {
  const { local, onChange, flush } = useDebouncedField(value, onCommit);
  return (
    <input value={local} data-testid={testId} onChange={(e) => onChange(e.target.value)} onBlur={flush}
           className="input-x !py-2 !text-sm" />
  );
}

function TextareaField({ value, onCommit, rows, testId }) {
  const { local, onChange, flush } = useDebouncedField(value, onCommit);
  return (
    <textarea rows={rows || 4} value={local} data-testid={testId} onChange={(e) => onChange(e.target.value)} onBlur={flush}
              className="input-x !py-2 !text-sm" />
  );
}

function ListField({ value, onCommit }) {
  // Held as text while editing so a blank line mid-typing doesn't drop an item.
  const { local, onChange, flush } = useDebouncedField((value || []).join("\n"), (text) =>
    onCommit(text.split("\n").filter(Boolean)));
  return (
    <textarea rows={5} value={local} onChange={(e) => onChange(e.target.value)} onBlur={flush}
              className="input-x !py-2 !text-sm font-mono-x" />
  );
}

const FIELDS = {
  hero: [
    { k: "eyebrow", label: "Eyebrow (small caps)" },
    { k: "heading", label: "Heading", type: "textarea" },
    { k: "body", label: "Body", type: "textarea", format: true },
    { k: "image_url", label: "Background image", type: "image" },
    { k: "cta_label", label: "Primary CTA label" },
    { k: "cta_href", label: "Primary CTA link" },
    { k: "cta_style", label: "Primary CTA style", type: "select", options: ["accent", "outline"] },
    { k: "second_cta_label", label: "Secondary CTA label" },
    { k: "second_cta_href", label: "Secondary CTA link" },
    { k: "align", label: "Align", type: "select", options: ["left", "center", "right"] },
    { k: "height", label: "Height", type: "select", options: ["short", "medium", "tall"] },
  ],
  rich_text: [{ k: "content", label: "Content (markdown-ish)", type: "textarea", rows: 12, format: true }],
  image: [
    { k: "image_url", label: "Image", type: "image" },
    { k: "caption", label: "Caption" },
    { k: "full_width", label: "Full width", type: "checkbox" },
    { k: "aspect", label: "Aspect ratio", type: "select", options: ["natural", "1:1", "4:3", "3:4", "16:9", "21:9", "3:2", "16:10"] },
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
    { k: "card_aspect", label: "Card aspect", type: "select", options: ["1:1", "4:3", "16:9", "16:10", "3:2", "3:4"] },
  ],
  artists_grid: [
    { k: "eyebrow", label: "Eyebrow" },
    { k: "heading", label: "Heading" },
    { k: "limit", label: "Max artists", type: "number" },
    { k: "layout", label: "Layout", type: "select", options: ["grid-2", "grid-3", "grid-4"] },
    { k: "card_aspect", label: "Card aspect", type: "select", options: ["1:1", "4:3", "3:4", "16:10"] },
  ],
  marquee: [{ k: "items", label: "Fallback items (used only when there are no upcoming events)", type: "list" }],
  cta_banner: [
    { k: "heading", label: "Heading", type: "textarea" },
    { k: "body", label: "Body", type: "textarea", format: true },
    { k: "cta_label", label: "Button label" },
    { k: "cta_href", label: "Button link" },
  ],
  contact_form: [
    { k: "heading", label: "Heading" },
    { k: "success_message", label: "Success message" },
  ],
  newsletter: [
    { k: "heading", label: "Heading" },
    { k: "body", label: "Body", type: "textarea", format: true },
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
    { k: "image_url", label: "Image", type: "image" },
    { k: "aspect", label: "Image aspect", type: "select", options: ["1:1", "4:3", "3:4", "16:9", "16:10", "3:2"] },
    { k: "eyebrow", label: "Eyebrow" },
    { k: "heading", label: "Heading" },
    { k: "body", label: "Body", type: "textarea", format: true },
    { k: "cta_label", label: "CTA label" },
    { k: "cta_href", label: "CTA link" },
  ],
};

function FormattedTextareaField({ f, value, onCommit, testId }) {
  const ref = useRef(null);
  const { local, onChange, flush } = useDebouncedField(value, onCommit);
  return (
    <>
      {/* The toolbar rewrites the whole value (wrapping the selection), which is a
          discrete edit rather than typing — take it locally and push it straight up so
          the preview reflects the formatting immediately. */}
      <FormatToolbar textareaRef={ref} value={local} onChange={(val) => { onChange(val); flush(); }} />
      <textarea ref={ref} rows={f.rows || 4} value={local} data-testid={testId}
                onChange={(e) => onChange(e.target.value)} onBlur={flush}
                className="input-x !py-2 !text-sm" />
    </>
  );
}

function PropsEditor({ block, onChange }) {
  const fields = FIELDS[block.type] || [];
  const v = block.props || {};
  const blockId = block.block_id;
  // One patch per field. The coalesce key is what lets a typing run collapse into a
  // single undo entry while an edit to a different field starts a new one.
  const commitField = useCallback(
    (key) => (val) => onChange(blockId, { [key]: val }, `${blockId}:${key}`),
    [onChange, blockId],
  );

  return (
    <div className="space-y-4">
      <div className="font-mono-x text-[10px] uppercase tracking-[0.3em] text-zinc-500">{BLOCK_LABELS[block.type]}</div>
      {fields.map((f) => {
        // Keyed by block AND field: selecting another block must give the text fields
        // fresh local state rather than leaving the previous block's text on screen.
        const key = `${blockId}:${f.k}`;
        const testId = `cms-${f.k}`;

        // Image fields render outside the <label>: they carry their own caption plus
        // buttons and a file input, and clicking a label activates its first control,
        // which would fire the wrong one.
        if (f.type === "image") {
          return <ImageField key={key} label={f.label} value={v[f.k] || ""} onChange={commitField(f.k)} testId={testId} />;
        }
        return (
          <label key={key} className="block">
            <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-400 font-mono-x mb-1">{f.label}</div>
            {f.type === "textarea" && f.format ? (
              <FormattedTextareaField f={f} value={v[f.k] || ""} onCommit={commitField(f.k)} testId={testId} />
            ) : f.type === "textarea" ? (
              <TextareaField value={v[f.k] || ""} rows={f.rows} onCommit={commitField(f.k)} testId={testId} />
            ) : f.type === "select" ? (
              <select value={v[f.k] || ""} onChange={(e) => commitField(f.k)(e.target.value)} className="input-x !py-2 !text-sm">
                {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : f.type === "checkbox" ? (
              <div className="flex items-center gap-2 pt-1"><input type="checkbox" checked={!!v[f.k]} onChange={(e) => commitField(f.k)(e.target.checked)} /> <span className="text-xs text-zinc-400">{f.label}</span></div>
            ) : f.type === "number" ? (
              <input type="number" value={v[f.k] ?? ""} onChange={(e) => commitField(f.k)(Number(e.target.value))} className="input-x !py-2 !text-sm" />
            ) : f.type === "list" ? (
              <ListField value={v[f.k]} onCommit={commitField(f.k)} />
            ) : (
              <TextField value={v[f.k] || ""} onCommit={commitField(f.k)} testId={testId} />
            )}
          </label>
        );
      })}
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
  const fontSuggestions = [
    "Clash Display", "Space Grotesk", "Inter", "Manrope", "Playfair Display",
    "IBM Plex Mono", "JetBrains Mono", "Archivo", "Bebas Neue", "Anton",
    "Syne", "Fraunces", "Rubik", "DM Sans", "Instrument Serif",
    "Big Shoulders Display", "Unbounded", "Cormorant Garamond", "Public Sans", "Geist"
  ];
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
      <div className="text-[10px] font-mono-x text-zinc-500">Type any Google Font name — it will load automatically.</div>
      <datalist id="cms-font-suggestions">
        {fontSuggestions.map((f) => <option key={f} value={f} />)}
      </datalist>
      {[["display", "Display / headings"], ["body", "Body"], ["mono", "Mono / labels"]].map(([k, label]) => (
        <label key={k} className="block">
          <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-400 font-mono-x mb-1">{label}</div>
          <input
            value={theme.fonts?.[k] || ""}
            onChange={(e) => setFont(k, e.target.value)}
            list="cms-font-suggestions"
            placeholder="e.g. Syne"
            data-testid={`font-${k}-input`}
            className="input-x !py-2 !text-sm"
            style={{ fontFamily: theme.fonts?.[k] ? `"${theme.fonts[k]}"` : undefined }}
          />
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
