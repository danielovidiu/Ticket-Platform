import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { http, errorText, setUnsavedWorkGuard } from "../api";
import { useAuth } from "../auth";
import { toast } from "sonner";
import { ChevronUp, ChevronDown, Trash2, Plus, Eye, EyeOff, Undo2, Redo2, Smartphone, Monitor, Palette, FileText, History, Home, CalendarRange } from "lucide-react";
import {
  BlockRenderer, HERO_SIZE_LIMITS, heroHeadingSize, HERO_HEIGHT_LIMITS, heroHeight, contentOffset,
  splitHeadingSize, SPLIT_RATIO_LIMITS, SPLIT_MAX_HEIGHT_LIMITS,
} from "../components/blocks";
import { BLOCK_DEFAULTS, BLOCK_LABELS, BLOCK_TYPES, newBlockId, applyTheme } from "../lib/cms";
import { THEME_PRESETS, presetIdFor, themeChoicePatch } from "../lib/themePresets";
import { failingPairs, AA_TEXT } from "../lib/contrast";
import { applyCustomFonts } from "../lib/fonts";
import { FormatToolbar } from "../lib/richText";
import ImageField from "../components/ImageField";
import VideoField from "../components/VideoField";
import AudioTracksField from "../components/AudioTracksField";
import FontPicker from "../components/FontPicker";
import { SOCIAL_PLATFORMS } from "../lib/social";
import FontManager from "../components/FontManager";
import { navChanged } from "../lib/nav";
import { useAutosave, useDebouncedField } from "../lib/useAutosave";
import {
  AUTOSAVE_INTERVAL_MS, anySaverDirty, firstSaverError, flushAllSavers,
  saverStates, setAutosaveEnabled, useAutosaveEnabled, useSaverRegistry,
} from "../lib/autosavePolicy";

// When the draft is written is autosavePolicy.js's decision now, not this file's — the
// debounce and ceiling that used to live here were one of five different answers to the
// same question, and the site settings pane's answer was "on every keystroke".
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
  // Why the last draft write failed, in the server's words. The block draft does not
  // go through useAutosave — it predates it — so it carries its own.
  const [saveError, setSaveError] = useState(null);
  const [dirty, setDirty] = useState(false);
  // Bumped when a write finishes with work still outstanding. `dirty` was already true
  // before the save and is still true after, so it cannot re-arm the interval on its
  // own and the last thing typed would never be written.
  const [saveTick, setSaveTick] = useState(0);
  const autosaveOn = useAutosaveEnabled();
  const [theme, setTheme] = useState(null);
  const [customFonts, setCustomFonts] = useState([]);
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

  /** Refetch the uploaded faces and install them. Called on mount and after every
   * upload or delete, so a font is selectable in the picker — and visible in the live
   * preview — the moment it finishes uploading. */
  const loadFonts = useCallback(async () => {
    const { data } = await http.get("/admin/cms/fonts");
    setCustomFonts(data);
    applyCustomFonts(data);
    return data;
  }, []);

  // Load fonts + pages + theme
  useEffect(() => {
    if (!user || (user.role !== "admin" && user.role !== "editor")) return;
    http.get("/admin/cms/pages").then((r) => {
      setPages(r.data);
      // Open the first *editable* page. Core nav rows sort into this list by nav_order
      // and can be first, and they have no blocks to open.
      const firstPage = r.data.find((p) => p.kind !== "core");
      if (firstPage && !currentId) setCurrentId(firstPage.page_id);
    });
    // Fonts before the theme, for the same reason ThemeLoader does it in that order: the
    // @font-face rules have to exist before --font-display names one of them, and
    // ensureFontLoaded needs to know which families are uploads so it doesn't go looking
    // for them on Google.
    loadFonts()
      .catch(() => {})
      .then(() => http.get("/admin/cms/theme"))
      .then((r) => {
        setTheme(r.data);
        applyTheme(r.data.draft || r.data.published);
      })
      .catch(() => {});
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
  // The unload/visibility/⌘S listeners are installed once; these keep them pointed at the
  // current closures rather than the ones that existed on first render.
  const flushAllRef = useRef(() => {});
  const unsavedRef = useRef(() => false);
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
      setSaveError(null);
      setSaveState("saved");
      // Only clear the flag if nothing was typed while the request was in the air.
      if (pageRef.current?.draft === snapshot) {
        setDirty(false);
        dirtySinceRef.current = 0;
      }
    } catch (err) {
      // Failures used to be swallowed, which left the editor claiming "Saved just now"
      // while the work existed only in this tab. The next edit re-arms the timer, so
      // this retries on its own; the status line says so meanwhile.
      //
      // A bare `catch {}` stood here even after the state was made honest, so the status
      // line could say a save had failed and nothing — not the UI, not the console —
      // could say why. `http` attaches the server's reason to every rejection now, and
      // this is where it earns its keep: an expired session and a draft over the size
      // limit are one string apart, and the difference is the whole diagnosis.
      if (import.meta.env?.DEV) console.error("[cms] draft save failed", err);
      setSaveError(errorText(err, "Save failed"));
      setSaveState("error");
    } finally {
      inFlightRef.current = false;
      if (queuedRef.current) { queuedRef.current = false; saveNow(); }
      else setSaveTick((t) => t + 1);
    }
  }, []);

  // Debounced, but with a ceiling: the plain debounce reset on every keystroke, so
  // continuous typing was never interrupted long enough to trigger a save at all.
  useEffect(() => {
    // Same policy as every other surface: off means nothing is scheduled, on means one
    // write per interval. `revision` stays out of the dependencies deliberately — with
    // it the timer restarts on every keystroke and a steady typist is never written.
    if (!autosaveOn || !dirty) return undefined;
    const t = setTimeout(saveNow, AUTOSAVE_INTERVAL_MS);
    return () => clearTimeout(t);
  }, [autosaveOn, dirty, saveNow, saveTick]);

  // Last lines of defence for work still sitting in the debounce window.
  useEffect(() => {
    const onBeforeUnload = (e) => {
      if (unsavedRef.current()) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    const onVisibility = () => { if (document.visibilityState === "hidden") flushAllRef.current(); };
    const onKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); flushAllRef.current(); }
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

  /** Switching pages replaces `page` wholesale — flush first or the last edit is lost.
   *  Metadata too: a half-typed title belongs to the page being left, not the one
   *  being opened. */
  const selectPage = useCallback((pid) => {
    if (pid === pageRef.current?.page_id) return;
    flushAllRef.current();
    setCurrentId(pid);
  }, []);

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
    // A page only enters the nav on its first publish — /cms/nav filters unpublished out.
    navChanged();
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
    // The server rejects slugs that are reserved by a built-in route or that could never
    // be routed to. Those refusals have to reach the person typing: without this catch
    // the promise rejected, the dialog stayed open with no message, and the one failure
    // the reserved list exists to make visible was invisible again.
    try {
      const r = await http.post("/admin/cms/pages", { slug, title, nav_label: title });
      setPages([...pages, r.data]);
      setCurrentId(r.data.page_id);
      setShowNewPage(false);
      toast.success("Page created");
    } catch (e) {
      const d = e.response?.data?.detail;
      toast.error(typeof d === "string" ? d : "Could not create that page");
    }
  };
  const deletePage = async (pid) => {
    if (!window.confirm("Delete this page?")) return;
    await http.delete(`/admin/cms/pages/${pid}`);
    const r = await http.get("/admin/cms/pages");
    setPages(r.data);
    setCurrentId(r.data.find((p) => p.kind !== "core")?.page_id || null);
    navChanged();
  };
  /** Make this page answer "/". Exactly one page can, so this is a radio, not a toggle. */
  const setAsHome = async (p) => {
    try {
      await http.post(`/admin/cms/pages/${p.page_id}/home`);
      const r = await http.get("/admin/cms/pages");
      setPages(r.data);
      navChanged(); // its nav link becomes "/" instead of /p/<slug>
      toast.success(`“${p.nav_label || p.title}” is now the homepage`);
    } catch (e) {
      const d = e.response?.data?.detail;
      toast.error(typeof d === "string" ? d : "Could not set the homepage");
    }
  };
  /** Hide or show a row in the site nav.
   *
   * For a core link this is the only removal there is — the route behind it stays live
   * either way. For an authored page it is the same `in_nav` the props panel exposes as
   * a checkbox, just reachable without opening the page first. */
  const toggleNavVisibility = async (p) => {
    const next = !p.in_nav;
    await http.patch(`/admin/cms/pages/${p.page_id}`, { in_nav: next });
    const r = await http.get("/admin/cms/pages");
    setPages(r.data);
    // The props panel renders its checkbox from `page`, not from `pages`. Without this
    // the two disagree about the page currently open until it is reselected.
    if (pageRef.current?.page_id === p.page_id) {
      const merged = { ...pageRef.current, in_nav: next };
      pageRef.current = merged;
      setPage(merged);
    }
    navChanged();
  };
  /**
   * Page metadata — title, nav label, nav visibility.
   *
   * This used to PATCH and then re-fetch the whole page list on EVERY KEYSTROKE, with no
   * debounce and no ordering: typing "Mission" was seven writes and fourteen reads, and
   * two of those writes could land out of order and leave the title one character behind
   * what is on screen. It now edits locally and rides the same autosave the draft does.
   */
  const metaPendingRef = useRef(null);

  const saveMeta = useCallback(async (patch) => {
    const p = pageRef.current;
    if (!p) return;
    const r = await http.patch(`/admin/cms/pages/${p.page_id}`, patch);
    // The response carries the server's copy of the draft, which is behind whatever is
    // pending locally — keep the local draft and take only the metadata.
    const merged = { ...r.data, draft: pageRef.current?.draft || r.data.draft };
    pageRef.current = merged;
    setPage(merged);
    const list = await http.get("/admin/cms/pages");
    setPages(list.data);
    // title / nav_label / in_nav all show up in the header.
    navChanged();
  }, []);

  const metaSave = useAutosave({
    getPending: () => metaPendingRef.current,
    save: saveMeta,
  });

  /** Apply metadata locally at once, and let the autosave carry it to the server. */
  const updatePageMeta = useCallback((patch) => {
    const p = pageRef.current;
    if (!p) return;
    const merged = { ...p, ...patch };
    pageRef.current = merged;
    setPage(merged);
    // Accumulate, so a title edit followed by a nav-label edit within one debounce
    // window is one request carrying both rather than the second discarding the first.
    metaPendingRef.current = { ...(metaPendingRef.current || {}), ...patch };
    metaSave.bump();
  }, [metaSave]);
  /** Save a new page order. The arrows and the drag handler both go through here, so
   *  the two cannot drift apart.
   *
   *  Optimistic: the list already shows `next` before the request goes out, because a
   *  row that snaps back to its old position for the length of a round trip reads as a
   *  failed drag. On an actual failure it re-reads the server rather than leaving the
   *  sidebar showing an order that was never saved — which is the bug this whole area
   *  had in a different form. */
  const persistOrder = async (next) => {
    setPages(next);
    try {
      await http.post("/admin/cms/pages/reorder", { order: next.map((p) => p.page_id) });
      navChanged();
    } catch {
      toast.error("Could not save the new order");
      const r = await http.get("/admin/cms/pages");
      setPages(r.data);
    }
  };

  const movePage = (idx, dir) => {
    const j = idx + dir;
    if (j < 0 || j >= pages.length) return;
    const next = [...pages];
    [next[idx], next[j]] = [next[j], next[idx]];
    persistOrder(next);
  };

  // ----- Nav drag & drop -----
  // Its own ref, deliberately not shared with the block list's `dragIdx`: both lists are
  // on screen at once and a drag started in one must not be droppable into the other.
  const navDragIdx = useRef(null);
  const onNavDragStart = (i) => (e) => {
    navDragIdx.current = i;
    e.dataTransfer.effectAllowed = "move";
  };
  const onNavDragOver = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; };
  const onNavDrop = (i) => (e) => {
    e.preventDefault();
    const from = navDragIdx.current;
    navDragIdx.current = null;
    if (from == null || from === i) return;
    const next = [...pages];
    const [moved] = next.splice(from, 1);
    next.splice(i, 0, moved);
    persistOrder(next);
  };

  // ----- Theme -----
  /**
   * Theme draft. Applied to the live preview immediately and written on the same
   * autosave as everything else.
   *
   * It used to PATCH on every change — which for a colour picker is a request per pixel
   * dragged, with no ordering, so the colour that landed last was whichever response the
   * network happened to deliver last rather than the one the editor chose.
   */
  const themePendingRef = useRef(null);

  const themeSave = useAutosave({
    getPending: () => themePendingRef.current,
    save: (draft) => http.patch("/admin/cms/theme", { draft }),
  });

  const setThemeDraft = useCallback((patch) => {
    setTheme((prev) => {
      const nextDraft = { ...(prev?.draft || prev?.published || {}), ...patch };
      themePendingRef.current = nextDraft;
      applyTheme(nextDraft);
      return { ...prev, draft: nextDraft };
    });
    themeSave.bump();
  }, [themeSave]);
  const publishTheme = async () => {
    // Publish snapshots what the SERVER holds, so anything still in the debounce window
    // has to go up first or it silently doesn't get published.
    await themeSave.flush();
    await http.post("/admin/cms/theme/publish");
    toast.success("Theme published");
    const r = await http.get("/admin/cms/theme");
    setTheme(r.data);
  };

  /** Blocks, metadata and theme save independently; the header reports the one that
   * most needs attention. An error anywhere outranks a save in flight, which outranks
   * "saved". */
  // Re-render when a pane joins or leaves the register, so the button below is asking
  // about the surfaces that are actually on screen.
  useSaverRegistry();
  // Naming meta and theme individually left the other two registered surfaces out: a
  // failed footer or events-tabs save did not keep "Save now" live. The register knows
  // all of them, including any added later.
  const anythingPending = dirty || anySaverDirty()
    || saveState === "error" || saverStates().includes("error");

  /** Everything, in one press. The register is what makes this cover the site and events
   *  panes too — panes this component does not otherwise know exist. */
  const saveEverythingNow = useCallback(() => {
    saveNow();
    flushAllSavers();
  }, [saveNow]);

  useEffect(() => {
    flushAllRef.current = saveEverythingNow;
    unsavedRef.current = () =>
      (!!pageRef.current && pageRef.current.draft !== savedDraftRef.current) || anySaverDirty();
  }, [saveEverythingNow, metaSave.dirty, themeSave.dirty]);

  // The same question `beforeunload` asks, asked by the 401 handler before it sends
  // anyone to a login form. This editor is the one screen in the app whose contents
  // exist nowhere but the tab they are typed into.
  useEffect(() => setUnsavedWorkGuard(() => unsavedRef.current()), []);

  const selectedBlock = useMemo(
    () => (selectedId ? blocks.find((b) => b.block_id === selectedId) || null : null),
    [blocks, selectedId],
  );

  if (loading) return <div className="p-16 font-mono-x text-ink-4">Loading…</div>;
  if (!user || (user.role !== "admin" && user.role !== "editor")) return <div className="p-16 text-center font-mono-x">Access denied. CMS is for admin / editor roles.</div>;

  const previewWidth = device === "mobile" ? "min(420px, 100%)" : "100%";

  return (
    <div className="h-full flex flex-col bg-page text-ink overflow-hidden">
      {/* TOP BAR */}
      <div className="hairline-b bg-page px-4 py-3 flex items-center gap-3 flex-wrap">
        <div className="font-display uppercase font-black tracking-tighter text-lg">SUPERSANITY<span className="text-brand">/</span>CMS</div>
        <div className="hidden md:block h-6 border-l border-ink/10 mx-2" />
        <select value={currentId || ""} onChange={(e) => selectPage(e.target.value)} data-testid="page-select" className="input-x !py-1.5 !px-2 max-w-[280px]">
          {pages.map((p) => <option key={p.page_id} value={p.page_id}>{p.title} — /p/{p.slug}</option>)}
        </select>
        <button onClick={() => setShowNewPage(true)} data-testid="new-page-btn" className="btn-primary !py-1.5 !px-3 !text-xs"><Plus size={14} className="inline" /> New page</button>

        <div className="flex-1" />

        <div className="hidden md:flex items-center gap-2">
          {/* historyTick is read here purely so these two re-render when the ref-held
              stacks change; the entries themselves never drive a render. */}
          <button onClick={undo} disabled={historyTick >= 0 && undoRef.current.length === 0} title="Undo" data-testid="cms-undo" className="p-2 border border-ink/20 hover:bg-ink hover:text-page disabled:opacity-30 disabled:pointer-events-none"><Undo2 size={14} /></button>
          <button onClick={redo} disabled={redoRef.current.length === 0} title="Redo" data-testid="cms-redo" className="p-2 border border-ink/20 hover:bg-ink hover:text-page disabled:opacity-30 disabled:pointer-events-none"><Redo2 size={14} /></button>
        </div>

        <div className="flex items-center border border-ink/20">
          <button onClick={() => setDevice("desktop")} className={`p-2 ${device==="desktop"?"bg-ink text-page":""}`}><Monitor size={14} /></button>
          <button onClick={() => setDevice("mobile")} className={`p-2 ${device==="mobile"?"bg-ink text-page":""}`}><Smartphone size={14} /></button>
        </div>

        {/* One indicator for the whole editor. Blocks, page metadata and the theme are
            three different requests, and an editor does not care which of them is in
            flight — they care whether their work is safe. Worst state wins. */}
        <SaveStatus
          state={worstState([saveState, ...saverStates()])}
          detail={saveError || firstSaverError()}
          savedAt={savedAt}
          dirty={dirty || metaSave.dirty || anySaverDirty()}
        />
        {/* Off by default, and per person: it is a working habit, not a property of the
            site. On, it writes once every AUTOSAVE_INTERVAL_MS of continuous editing —
            which is the point of an interval over a debounce, and the reason the
            database is no longer asked to record a sentence one letter at a time. */}
        <button onClick={() => setAutosaveEnabled(!autosaveOn)}
                data-testid="autosave-toggle" aria-pressed={autosaveOn}
                title={autosaveOn
                  ? `Autosave on — saving every ${Math.round(AUTOSAVE_INTERVAL_MS / 1000)}s`
                  : "Autosave off — your work is saved when you ask"}
                className={`!py-1.5 !px-3 !text-xs font-mono-x uppercase tracking-[0.2em] border ${
                  autosaveOn ? "bg-ink text-page border-ink" : "border-ink/20 text-ink-4 hover:text-ink"}`}>
          Auto {autosaveOn ? "on" : "off"}
        </button>
        <button onClick={saveEverythingNow} disabled={!anythingPending} title="Save draft now (⌘S)"
                data-testid="save-draft-btn" className="btn-primary !py-1.5 !px-3 !text-xs disabled:opacity-30">
          Save now
        </button>
        {page && <a href={`/p/${page.slug}`} target="_blank" rel="noreferrer" className="btn-primary !py-1.5 !px-3 !text-xs">View live</a>}
        <button onClick={publish} data-testid="publish-page-btn" className="btn-accent !py-2 !px-4 !text-xs">Publish</button>
      </div>

      {/* MAIN 3-COLUMN */}
      <div className="flex-1 grid grid-cols-12 min-h-0">
        {/* LEFT: pages + blocks */}
        <aside className="col-span-12 md:col-span-3 xl:col-span-2 border-r border-ink/10 overflow-y-auto p-3 space-y-4">
          <div>
            <div className="font-mono-x text-[10px] uppercase tracking-[0.3em] text-ink-4">Navigation</div>
            {/* Dragging has no affordance of its own, so say so. The arrows stay: they
                are the keyboard-reachable path, and drag-and-drop is not. */}
            <div className="font-mono-x text-[9px] uppercase tracking-[0.2em] text-ink-5 mt-1 mb-2">Drag to reorder</div>
            {/* One list, in nav order, holding both authored pages and the built-in
                sections. The arrows reorder across the whole thing, which is the only
                way the two kinds can be interleaved — before this, core links were
                hardcoded in the header and always came last. */}
            <ul className="space-y-1">
              {pages.map((p, i) => {
                const core = p.kind === "core";
                return (
                  <li key={p.page_id}
                      data-testid={`cms-nav-row-${p.slug}`}
                      draggable
                      onDragStart={onNavDragStart(i)}
                      onDragOver={onNavDragOver}
                      onDrop={onNavDrop(i)}
                      title="Drag to reorder"
                      className={`flex items-center justify-between border px-2 py-1.5 text-xs cursor-move ${p.page_id === currentId ? "border-ink bg-ink/10" : "border-ink/10"} ${p.in_nav === false ? "opacity-50" : ""}`}>
                    {core ? (
                      <span className="flex-1 truncate text-ink-3" title={`Built-in section — ${p.route}`}>
                        {p.nav_label || p.title}
                        <span className="ml-1 text-[9px] uppercase tracking-[0.2em] text-ink-5">link</span>
                      </span>
                    ) : (
                      <button onClick={() => selectPage(p.page_id)} className="text-left flex-1 truncate">
                        {p.title}
                        {p.is_home && <span className="ml-1 text-[9px] uppercase tracking-[0.2em] text-ink-4">home</span>}
                      </button>
                    )}
                    <div className="flex items-center gap-1">
                      {!core && (
                        <button onClick={() => setAsHome(p)} disabled={!!p.is_home}
                                title={p.is_home ? "This page answers /" : "Make this the homepage"}
                                data-testid={`cms-nav-home-${p.slug}`}
                                className={p.is_home ? "text-ink" : "text-ink-5 hover:text-ink"}>
                          <Home size={12} />
                        </button>
                      )}
                      <button onClick={() => movePage(i, -1)} title="Move up" className="text-ink-4 hover:text-ink"><ChevronUp size={12} /></button>
                      <button onClick={() => movePage(i, 1)} title="Move down" className="text-ink-4 hover:text-ink"><ChevronDown size={12} /></button>
                      {/* Every row can be hidden from the nav. For an authored page this
                          is the same in_nav the props panel exposes, reachable without
                          opening the page; for a core link it is the only removal there
                          is. Deleting stays exclusive to authored pages. */}
                      <button onClick={() => toggleNavVisibility(p)}
                              title={p.in_nav === false ? "Show in nav" : "Hide from nav"}
                              data-testid={`cms-nav-toggle-${p.slug}`}
                              className="text-ink-4 hover:text-ink">
                        {p.in_nav === false ? <EyeOff size={12} /> : <Eye size={12} />}
                      </button>
                      {!core && (
                        <button onClick={() => deletePage(p.page_id)} title="Delete page"
                                className="text-ink-4 hover:text-brand"><Trash2 size={12} /></button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>

          <div>
            <div className="font-mono-x text-[10px] uppercase tracking-[0.3em] text-ink-4 mb-2">Add block</div>
            <div className="grid grid-cols-2 gap-1">
              {BLOCK_TYPES.map((t) => (
                <button key={t} onClick={() => addBlock(t)} data-testid={`add-block-${t}`} className="text-left border border-ink/10 hover:border-ink p-2 text-[11px] uppercase tracking-wider">{BLOCK_LABELS[t]}</button>
              ))}
            </div>
          </div>

          {page && (
            <div>
              <div className="font-mono-x text-[10px] uppercase tracking-[0.3em] text-ink-4 mb-2">Structure</div>
              <ul className="space-y-1">
                {blocks.map((b, i) => (
                  <li key={b.block_id}
                      draggable
                      onDragStart={onDragStart(i)}
                      onDragOver={onDragOver}
                      onDrop={onDrop(i)}
                      className={`flex items-center gap-1 border px-2 py-1.5 text-xs cursor-move ${b.block_id === selectedId ? "border-ink bg-ink/10" : "border-ink/10"} ${b.enabled === false ? "opacity-40" : ""}`}>
                    <button onClick={() => selectBlock(b.block_id)} className="text-left flex-1 truncate">{BLOCK_LABELS[b.type] || b.type}</button>
                    <button onClick={() => toggleBlock(i)} title="Toggle visibility" className="text-ink-4 hover:text-ink">{b.enabled === false ? <EyeOff size={12} /> : <Eye size={12} />}</button>
                    <button onClick={() => moveBlock(i, -1)} className="text-ink-4 hover:text-ink"><ChevronUp size={12} /></button>
                    <button onClick={() => moveBlock(i, 1)} className="text-ink-4 hover:text-ink"><ChevronDown size={12} /></button>
                    <button onClick={() => removeBlock(i)} className="text-ink-4 hover:text-brand"><Trash2 size={12} /></button>
                  </li>
                ))}
                {blocks.length === 0 && <li className="text-ink-4 text-xs border border-dashed border-ink/10 p-3 text-center">Empty page — pick a block above</li>}
              </ul>
            </div>
          )}
        </aside>

        {/* CENTER: live preview */}
        <main className="col-span-12 md:col-span-6 xl:col-span-7 overflow-y-auto bg-page" data-testid="cms-preview">
          <div className="mx-auto py-4 transition-all duration-300" style={{ width: previewWidth }}>
            <div className="border border-ink/10">
              {page ? (
                blocks.length === 0 ? (
                  <div className="p-24 text-center text-ink-4 font-mono-x text-xs uppercase tracking-[0.3em]">
                    Empty. Add blocks from the left.
                  </div>
                ) : (
                  blocks.map((b) => (
                    <PreviewBlock key={b.block_id} block={b} selected={b.block_id === selectedId} onSelect={selectBlock} />
                  ))
                )
              ) : (
                <div className="p-24 text-center text-ink-4 font-mono-x text-xs uppercase tracking-[0.3em]">Select or create a page</div>
              )}
            </div>
          </div>
        </main>

        {/* RIGHT: properties / theme / versions */}
        <aside className="col-span-12 md:col-span-3 border-l border-ink/10 overflow-y-auto">
          <div className="flex border-b border-ink/10">
            <button onClick={() => setRightTab("props")} className={`flex-1 py-2 text-[11px] uppercase tracking-[0.2em] font-mono-x ${rightTab==="props"?"bg-ink text-page":""}`}><FileText size={12} className="inline mr-1" /> Props</button>
            <button onClick={() => setRightTab("theme")} className={`flex-1 py-2 text-[11px] uppercase tracking-[0.2em] font-mono-x ${rightTab==="theme"?"bg-ink text-page":""}`}><Palette size={12} className="inline mr-1" /> Theme</button>
            <button onClick={() => setRightTab("versions")} className={`flex-1 py-2 text-[11px] uppercase tracking-[0.2em] font-mono-x ${rightTab==="versions"?"bg-ink text-page":""}`}><History size={12} className="inline mr-1" /> Versions</button>
            <button onClick={() => setRightTab("site")} data-testid="cms-tab-site" className={`flex-1 py-2 text-[11px] uppercase tracking-[0.2em] font-mono-x ${rightTab==="site"?"bg-ink text-page":""}`}><CalendarRange size={12} className="inline mr-1" /> Site</button>
          </div>

          <div className="p-4">
            {rightTab === "props" && (selectedBlock ? (
              <PropsEditor block={selectedBlock} onChange={updateProps} pageMeta={page} onPageMeta={updatePageMeta} />
            ) : page ? (
              <PageMetaEditor page={page} onChange={updatePageMeta} />
            ) : null)}
            {rightTab === "theme" && theme && (
              <ThemeEditor theme={theme.draft || theme.published} onChange={setThemeDraft} onPublish={publishTheme}
                           customFonts={customFonts} onFontsChanged={loadFonts} />
            )}
            {rightTab === "versions" && page && (
              <VersionList page={page} onRevert={revert} />
            )}
            {rightTab === "site" && (
              <div className="space-y-6">
                <SiteContentEditor />
                <div className="pt-2 border-t border-ink/10" />
                <CorePagesEditor />
                <div className="pt-2 border-t border-ink/10" />
                <EventsSettingsEditor />
              </div>
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
         className={`relative group cursor-pointer ${selected ? "outline outline-2 outline-[color:var(--accent)]" : "hover:outline hover:outline-1 hover:outline-ink/40"}`}>
      <div className={`absolute top-2 left-2 z-30 font-mono-x text-[9px] uppercase tracking-[0.2em] bg-page text-ink px-2 py-1 border border-ink/20 ${selected ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
        {BLOCK_LABELS[block.type]}
      </div>
      <BlockRenderer block={block} preview />
    </div>
  );
});

/** The state that most needs attention, across the editor's independent savers.
 * An error outranks a save in flight, which outranks a completed one. */
const STATE_RANK = { error: 3, saving: 2, saved: 1, idle: 0 };
function worstState(states) {
  return states.reduce((worst, s) => (STATE_RANK[s] > STATE_RANK[worst] ? s : worst), "idle");
}

/** Honest save indicator. Its own component with its own interval, so the clock ticking
 * doesn't re-render the editor (and the preview) every few seconds. The label it replaced
 * was memoized on the save timestamp, so it read "Saved just now" indefinitely — including
 * while there were unsaved changes sitting in the debounce window. */
function SaveStatus({ state, detail, savedAt, dirty }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);

  // A freshly opened page has nothing pending — the server's draft is what's on screen.
  let label = "No changes";
  let tone = "text-ink-4";
  if (state === "saving") { label = "Saving…"; }
  // The reason, when the server gave one. "Save failed — retrying" is true and answers
  // none of the questions it raises; "Save failed — your session expired" ends the
  // investigation at the status line, which is where it should have ended all along.
  else if (state === "error") { label = `Save failed — ${detail || "retrying"}`; tone = "text-brand"; }
  else if (dirty) { label = "Unsaved changes"; tone = "text-ink"; }
  else if (savedAt) {
    const s = Math.floor((Date.now() - savedAt) / 1000);
    label = s < 5 ? "Saved just now" : s < 60 ? `Saved ${s}s ago` : `Saved ${Math.floor(s / 60)}m ago`;
  }
  return (
    // `title` because the reason can outrun the space: the line is one row in a toolbar
    // and a validation message is a sentence.
    <div data-testid="cms-save-status" title={label}
         className={`font-mono-x text-[10px] uppercase tracking-[0.25em] hidden md:block truncate max-w-[22rem] ${tone}`}>
      {label}
    </div>
  );
}

// -------------- Props editor --------------

/**
 * Nothing may rewrite what was typed. `autoCapitalize` and `autoCorrect` are ON by
 * default on iOS and in some desktop contexts, which capitalises the first letter of a
 * field and "corrects" words the author meant — an artist name in lower case, a stylised
 * title. The CMS records the author's text, so both are off everywhere it takes input.
 *
 * `spellCheck` stays on: it underlines, it does not change anything.
 */
const RAW_TEXT_PROPS = { autoCapitalize: "off", autoCorrect: "off", autoComplete: "off", spellCheck: true };

function TextField({ value, onCommit, testId }) {
  const { local, onChange, flush } = useDebouncedField(value, onCommit);
  return (
    <input value={local} data-testid={testId} onChange={(e) => onChange(e.target.value)} onBlur={flush}
           {...RAW_TEXT_PROPS} className="input-x !py-2 !text-sm" />
  );
}

function TextareaField({ value, onCommit, rows, testId }) {
  const { local, onChange, flush } = useDebouncedField(value, onCommit);
  return (
    <textarea rows={rows || 4} value={local} data-testid={testId} onChange={(e) => onChange(e.target.value)} onBlur={flush}
              {...RAW_TEXT_PROPS} className="input-x !py-2 !text-sm" />
  );
}

function ListField({ value, onCommit }) {
  // Held as text while editing so a blank line mid-typing doesn't drop an item.
  const { local, onChange, flush } = useDebouncedField((value || []).join("\n"), (text) =>
    onCommit(text.split("\n").filter(Boolean)));
  return (
    <textarea rows={5} value={local} onChange={(e) => onChange(e.target.value)} onBlur={flush}
              {...RAW_TEXT_PROPS} className="input-x !py-2 !text-sm font-mono-x" />
  );
}

/**
 * The site's own words: both wordmarks, and everything the footer says apart from its
 * links. The links are CMS pages, ticked with "Show in footer" on the page itself, so
 * they cannot point at a page that does not exist.
 *
 * Saves on blur rather than through the draft/publish cycle the pages and theme use:
 * there is no preview of a footer to review, and a two-step publish for eight fields
 * reads as ceremony.
 */
/* Hoisted OUT of SiteContentEditor, and that is the whole bug fix.
 *
 * It was declared inside the component body, so every render produced a NEW component
 * type. React cannot know that two function identities mean the same thing, so it
 * unmounted the old subtree and mounted a fresh one — on every keystroke. TextField's
 * debounce lives in state that was thrown away each time, and its unmount effect flushes
 * whatever was pending, so each character both lost the debounce and forced the flush it
 * was supposed to prevent. One PUT per letter, and the typing lag that goes with
 * remounting an input mid-word.
 *
 * A component that closes over props belongs outside the thing that renders it. */
function SiteField({ label, value, onCommit, testId, hint }) {
  return (
    <label className="block">
      <div className="text-[10px] uppercase tracking-[0.2em] text-ink-3 font-mono-x mb-1">{label}</div>
      <TextField value={value || ""} onCommit={onCommit} testId={testId} />
      {hint && <div className="mt-1 font-mono-x text-[9px] uppercase tracking-[0.15em] text-ink-5">{hint}</div>}
    </label>
  );
}

function SiteContentEditor() {
  const [state, setState] = useState(null);
  // What the next write should carry, held in a ref so the save reads the newest value at
  // write time rather than the snapshot current when the timer was armed.
  const pendingRef = useRef(null);

  const pushToServer = useCallback(async (serialized) => {
    const { social, pages, ...rest } = JSON.parse(serialized);
    const { data } = await http.put("/admin/cms/site", { ...rest, social: social || {} });
    // The server's answer is adopted for the pieces it derives (the footer page list),
    // but NOT for the fields being typed into: overwriting those mid-sentence is how an
    // editor loses the end of a word to a reply from a request they started three
    // characters ago.
    setState((cur) => ({ ...cur, pages: data.pages }));
  }, []);

  const siteSave = useAutosave({
    getPending: () => (pendingRef.current ? JSON.stringify(pendingRef.current) : undefined),
    save: pushToServer,
  });

  useEffect(() => {
    http.get("/admin/cms/site").then((r) => {
      setState(r.data);
      pendingRef.current = r.data;
      siteSave.reset(JSON.stringify(r.data));
      if (r.data?.nav_size) {
        document.documentElement.style.setProperty("--nav-size", `${r.data.nav_size}px`);
      }
      // `!= null` rather than a truthiness test: 0 is a real setting here and would be
      // skipped by the check above it, leaving the preview at the default while the
      // saved value said otherwise.
      for (const [key, prop] of [["text_inset_sm", "--text-inset-sm"], ["text_inset_lg", "--text-inset-lg"]]) {
        if (r.data?.[key] != null) {
          document.documentElement.style.setProperty(prop, `${r.data[key]}px`);
        }
      }
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!state) return <div className="text-[11px] text-ink-4 font-mono-x uppercase tracking-[0.2em]">Loading…</div>;

  /** Apply locally at once; the policy decides when it reaches the server. */
  const save = (patch) => {
    const next = { ...(pendingRef.current || state), ...patch };
    pendingRef.current = next;
    setState(next);
    siteSave.bump();
  };

  return (
    <div className="space-y-4" data-testid="site-content">
      {/* One wordmark now, not two. The footer's was removed with the footer's first
          row; a second field for a place that no longer shows one is a control whose
          only effect is to look like it has one. */}
      <div className="font-mono-x text-[10px] uppercase tracking-[0.3em] text-ink-4">Wordmark</div>
      <SiteField label="Header" value={state.header_wordmark} testId="site-header_wordmark"
                 onCommit={(v) => save({ header_wordmark: v })} />
      <label className="block">
        <div className="text-[10px] uppercase tracking-[0.2em] text-ink-3 font-mono-x mb-1">
          Menu text size: {state.nav_size ?? 11}px
        </div>
        <input type="range" min="8" max="32" value={state.nav_size ?? 11} data-testid="site-nav-size"
               onChange={(e) => {
                 const px = Number(e.target.value);
                 // Painted immediately as well as saved. The size reaches visitors through
                 // the render-blocking stylesheet, which this already-loaded page will not
                 // re-fetch — so without this the slider moves, the value saves, and the
                 // header does not budge until a reload. That is exactly how the previous
                 // version of this control read as broken.
                 document.documentElement.style.setProperty("--nav-size", `${px}px`);
                 save({ nav_size: px });
               }} className="w-full" />
        <div className="mt-1 font-mono-x text-[9px] uppercase tracking-[0.15em] text-ink-5 leading-relaxed">
          The header nav. The phone menu follows it up but never below its own size.
        </div>
      </label>

      <div className="font-mono-x text-[10px] uppercase tracking-[0.3em] text-ink-4 pt-4">Text inset</div>
      <div className="font-mono-x text-[9px] uppercase tracking-[0.15em] text-ink-5 leading-relaxed">
        How far text sits from the edge of the screen. Photos are never inset — they keep
        running to the corner, which is what a curved screen can afford to lose.
      </div>
      {[
        { key: "text_inset_sm", prop: "--text-inset-sm", label: "Phone", fallback: 16 },
        { key: "text_inset_lg", prop: "--text-inset-lg", label: "Desktop", fallback: 24 },
      ].map(({ key, prop, label, fallback }) => (
        <label className="block" key={key}>
          <div className="text-[10px] uppercase tracking-[0.2em] text-ink-3 font-mono-x mb-1">
            {label}: {state[key] ?? fallback}px
          </div>
          <input type="range" min="0" max="64" value={state[key] ?? fallback} data-testid={`site-${key}`}
                 onChange={(e) => {
                   const px = Number(e.target.value);
                   // Painted here as well as saved, for the same reason the nav size is:
                   // the value reaches visitors through the render-blocking stylesheet,
                   // which this already-loaded page will not re-fetch.
                   document.documentElement.style.setProperty(prop, `${px}px`);
                   save({ [key]: px });
                 }} className="w-full" />
        </label>
      ))}

      <div className="font-mono-x text-[10px] uppercase tracking-[0.3em] text-ink-4 pt-4">Footer</div>
      {/* Description, the two column headings and the contact address were all removed
          with the rows and columns that carried them. Their values are still stored and
          still returned by the API — nothing was deleted — but nothing renders them, and
          an editable field with no effect anywhere is the same bug as a save that
          silently does not save. */}
      <SiteField label="Copyright name" value={state.copyright_name} testId="site-copyright_name"
                 hint="The year is always the current one"
                 onCommit={(v) => save({ copyright_name: v })} />

      <div className="pt-2 text-[10px] text-ink-4 leading-relaxed" data-testid="site-footer-pages">
        Footer links: {(state.pages || []).map((p) => p.label).join(" · ") || "none yet"}.
        <br />Chosen per page with “Show in footer”. A page in the footer is kept out of
        the main navigation.
        <br />Anything the footer should link to is a page here — including the notices a
        jurisdiction requires, such as ANPC and SAL. Make the page, tick “Show in footer”,
        and it joins the row.
      </div>

      <div className="font-mono-x text-[10px] uppercase tracking-[0.3em] text-ink-4 pt-4">Social</div>
      <div className="space-y-2">
        {SOCIAL_PLATFORMS.map((pl) => (
          <label key={pl.key} className="block">
            <div className="text-[10px] uppercase tracking-[0.2em] text-ink-3 font-mono-x mb-1">{pl.label}</div>
            <TextField value={state.social?.[pl.key] || ""} testId={`site-social-${pl.key}`}
                       onCommit={(v) => save({ social: { ...(state.social || {}), [pl.key]: v } })} />
          </label>
        ))}
      </div>
      {/* No local "Saving…" line. There is one indicator for the whole editor in the
          toolbar, and a second one here answered the same question differently. */}
    </div>
  );
}

const EVENT_TAB_LABELS = { all: "All", upcoming: "Upcoming", past: "Past" };

/**
 * Which tabs the /events page offers, and which one it opens on.
 *
 * Lives in the CMS rather than in the admin because it is a content decision — what
 * slices of the programme a visitor is offered — not an operational one. /events is a
 * React route with no blocks to edit, so this panel is the only place it can be authored.
 *
 * Saves immediately rather than through the draft/publish cycle the pages and theme use:
 * there is no preview of a tab bar to review, and a two-step publish for two fields
 * reads as ceremony.
 */
function EventsSettingsEditor() {
  const [state, setState] = useState(null);
  const pendingRef = useRef(null);

  const pushToServer = useCallback(async (serialized) => {
    const next = JSON.parse(serialized);
    await http.put("/admin/cms/events-settings", {
      tabs: next.tabs, default_tab: next.default_tab,
    });
  }, []);

  // Ticking a box is not typing, so this one was never the cause of a request storm.
  // It joins the same policy anyway: "autosave is off" has to mean the same thing in
  // every pane, or the toggle is a suggestion rather than a setting.
  const tabsSave = useAutosave({
    getPending: () => (pendingRef.current
      ? JSON.stringify({ tabs: pendingRef.current.tabs, default_tab: pendingRef.current.default_tab })
      : undefined),
    save: pushToServer,
  });

  useEffect(() => {
    http.get("/admin/cms/events-settings").then((r) => {
      setState(r.data);
      pendingRef.current = r.data;
      tabsSave.reset(JSON.stringify({ tabs: r.data.tabs, default_tab: r.data.default_tab }));
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!state) return <div className="text-[11px] text-ink-4 font-mono-x uppercase tracking-[0.2em]">Loading…</div>;

  const save = (next) => {
    const merged = { ...state, ...next };
    pendingRef.current = merged;
    setState(merged);
    tabsSave.bump();
  };

  const toggle = (t) => {
    const tabs = state.tabs.includes(t) ? state.tabs.filter((x) => x !== t) : [...state.tabs, t];
    if (tabs.length === 0) { toast.error("Keep at least one tab"); return; }
    // Follow the default along rather than leaving it pointing at a tab nobody can reach.
    const default_tab = tabs.includes(state.default_tab) ? state.default_tab : tabs[0];
    save({ tabs, default_tab });
  };

  const ordered = (state.available_tabs || ["all", "upcoming", "past"]);

  return (
    <div data-testid="events-settings">
      <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4">Events page tabs</div>
      <div className="mt-3 space-y-2">
        {ordered.map((t) => (
          <label key={t} className="flex items-center gap-2 text-xs cursor-pointer">
            <input type="checkbox" checked={state.tabs.includes(t)}
                   onChange={() => toggle(t)} data-testid={`events-tab-${t}`} />
            <span className="uppercase tracking-[0.15em] font-mono-x">{EVENT_TAB_LABELS[t] || t}</span>
          </label>
        ))}
      </div>

      <div className="mt-5 font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4">Opens on</div>
      <select value={state.default_tab}
              onChange={(e) => save({ tabs: state.tabs, default_tab: e.target.value })}
              className="input-x w-full mt-2 !py-2 !text-sm" data-testid="events-default-tab">
        {state.tabs.map((t) => <option key={t} value={t}>{EVENT_TAB_LABELS[t] || t}</option>)}
      </select>

      <div className="mt-4 text-[10px] text-ink-4 leading-relaxed">
        One tab on its own hides the bar and applies that filter silently — there is
        nothing to choose between.
      </div>
    </div>
  );
}

/**
 * The eyebrow and name at the top of the four built-in section pages.
 *
 * These pages are React routes with no blocks, so the left rail cannot open them and
 * there is nowhere else their two lines of type could be authored. Same reasoning, and
 * the same immediate save, as the Events tab panel above it — two short strings per page
 * do not need a draft to review.
 *
 * Clearing a box is a real edit, not a reset: the line disappears from the page and what
 * was under it moves up. The built-in wording is one button away for anyone who wants it
 * back, which is what makes emptying safe to offer.
 */
function CorePagesEditor() {
  const [pages, setPages] = useState(null);
  const [defaults, setDefaults] = useState({});
  const pendingRef = useRef(null);

  const pushToServer = useCallback(async (serialized) => {
    await http.put("/admin/cms/core-pages", { pages: JSON.parse(serialized) });
  }, []);

  const headersSave = useAutosave({
    getPending: () => (pendingRef.current ? JSON.stringify(pendingRef.current) : undefined),
    save: pushToServer,
  });

  useEffect(() => {
    http.get("/admin/cms/core-pages").then((r) => {
      setPages(r.data.pages);
      setDefaults(r.data.defaults || {});
      pendingRef.current = r.data.pages;
      headersSave.reset(JSON.stringify(r.data.pages));
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!pages) return <div className="text-[11px] text-ink-4 font-mono-x uppercase tracking-[0.2em]">Loading…</div>;

  const edit = (slug, patch) => {
    const next = { ...pages, [slug]: { ...pages[slug], ...patch } };
    pendingRef.current = next;
    setPages(next);
    headersSave.bump();
  };

  return (
    <div data-testid="core-pages-settings">
      <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4">Built-in page headings</div>
      <div className="mt-1 text-[10px] text-ink-4 leading-relaxed">
        Empty a box and that line goes; the rest of the page moves up.
      </div>

      {Object.keys(pages).map((slug) => {
        const value = pages[slug];
        const fallback = defaults[slug] || {};
        const isDefault = value.eyebrow === (fallback.eyebrow || "") && value.heading === (fallback.heading || "");
        return (
          <div key={slug} className="mt-5">
            <div className="flex items-baseline justify-between gap-2">
              <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-3">/{slug}</div>
              {!isDefault && (
                <button onClick={() => edit(slug, { eyebrow: fallback.eyebrow || "", heading: fallback.heading || "" })}
                        data-testid={`core-page-reset-${slug}`}
                        className="font-mono-x text-[9px] uppercase tracking-[0.2em] text-ink-5 hover:text-ink">Reset</button>
              )}
            </div>
            <input value={value.eyebrow} onChange={(e) => edit(slug, { eyebrow: e.target.value })}
                   placeholder="Eyebrow" aria-label={`${slug} eyebrow`}
                   data-testid={`core-page-eyebrow-${slug}`}
                   className="input-x w-full mt-2 !py-2 !text-sm" />
            <input value={value.heading} onChange={(e) => edit(slug, { heading: e.target.value })}
                   placeholder="Name" aria-label={`${slug} name`}
                   data-testid={`core-page-heading-${slug}`}
                   className="input-x w-full mt-2 !py-2 !text-sm" />
          </div>
        );
      })}
    </div>
  );
}

const FIELDS = {
  hero: [
    { k: "eyebrow", label: "Eyebrow" },
    { k: "heading", label: "Heading", type: "textarea" },
    { k: "body", label: "Body", type: "textarea", format: true },
    { k: "image_url", label: "Background image", type: "image" },
    // Phones only, and named for what it decides rather than for the CSS it sets. A wide
    // photograph loses most of its width to the crop on a 375px screen, and this says
    // which part of it is the part worth keeping.
    { k: "mobile_focus", label: "Mobile view", type: "select", options: ["left", "center", "right"],
      fallback: "center", when: (v) => !!v.image_url },
    { k: "full_frame", label: "Full frame (edge to edge)", type: "checkbox", fallback: true },
    { k: "overlay", label: "Overlay", type: "select", options: ["gradient", "solid", "none"], fallback: "gradient" },
    { k: "overlay_color", label: "Overlay colour", type: "color", fallback: "#050505", when: (v) => v.overlay === "solid" },
    { k: "overlay_opacity", label: "Overlay opacity", type: "range", min: 0, max: 100, fallback: 45, when: (v) => v.overlay === "solid" },
    { k: "heading_size_desktop", label: "Heading size — desktop", type: "size", breakpoint: "desktop" },
    { k: "heading_size_mobile", label: "Heading size — mobile", type: "size", breakpoint: "mobile" },
    { k: "text_case", label: "Text case", type: "select", options: ["as-typed", "uppercase"], fallback: "uppercase" },
    { k: "cta_label", label: "Primary CTA label" },
    { k: "cta_href", label: "Primary CTA link" },
    { k: "cta_style", label: "Primary CTA style", type: "select", options: ["accent", "outline"] },
    { k: "second_cta_label", label: "Secondary CTA label" },
    { k: "second_cta_href", label: "Secondary CTA link" },
    { k: "align", label: "Text align (horizontal)", type: "select", options: ["left", "center", "right"] },
    // Was a top/middle/bottom select. Three steps could put a hero's words in three
    // places and nowhere else, and on a photograph the spot they need is usually none of
    // the three, because a face or a horizon is in the way. `contentOffset` still reads
    // the old field, so a hero published under a name keeps exactly where it sat.
    { k: "content_offset", label: "Text position — down from the top", type: "offset", fallback: 100 },
    // Replaces a short/medium/tall select. Those were 50/70/85vh, and `heroHeight`
    // still resolves them, so a hero published under a name keeps its exact height.
    { k: "height_vh", label: "Height (% of screen)", type: "size", unit: "vh" },
  ],
  rich_text: [
    { k: "content", label: "Content (markdown-ish)", type: "textarea", rows: 12, format: true },
    { k: "full_width", label: "Full width (edge to edge)", type: "checkbox" },
  ],
  _background: [
    { k: "image_url", label: "Photo", type: "image" },
    { k: "_note", label: "", type: "note",
      text: "Sits behind every other block on this page. Add it once — anything else you add lands on top of it." },
    { k: "overlay_color", label: "Overlay colour", type: "color" },
    { k: "overlay_opacity", label: "Overlay opacity", type: "range", min: 0, max: 100, fallback: 40 },
    { k: "full_frame", label: "Full frame (edge to edge)", type: "checkbox" },
  ],
  image: [
    { k: "image_url", label: "Image", type: "image" },
    { k: "caption", label: "Caption" },
    { k: "full_width", label: "Full width (edge to edge)", type: "checkbox" },
    { k: "aspect", label: "Aspect ratio", type: "select", options: ["natural", "1:1", "4:3", "3:4", "16:9", "21:9", "3:2", "16:10"] },
  ],
  gallery_grid: [
    { k: "heading", label: "Heading" },
    { k: "limit", label: "Max items", type: "number" },
    { k: "full_width", label: "Full width (edge to edge)", type: "checkbox" },
  ],
  events_grid: [
    { k: "eyebrow", label: "Eyebrow" },
    { k: "heading", label: "Heading" },
    { k: "limit", label: "Max events", type: "number" },
    { k: "layout", label: "Layout", type: "select", options: ["grid-1", "grid-2", "grid-3"] },
    { k: "card_aspect", label: "Card aspect", type: "select", options: ["1:1", "4:3", "16:9", "16:10", "3:2", "3:4"] },
    { k: "full_width", label: "Full width (edge to edge)", type: "checkbox" },
  ],
  artists_grid: [
    { k: "eyebrow", label: "Eyebrow" },
    { k: "heading", label: "Heading" },
    { k: "limit", label: "Max artists", type: "number" },
    { k: "layout", label: "Layout", type: "select", options: ["grid-2", "grid-3", "grid-4"] },
    { k: "card_aspect", label: "Card aspect", type: "select", options: ["1:1", "4:3", "3:4", "16:10"] },
    { k: "full_width", label: "Full width (edge to edge)", type: "checkbox" },
  ],
  marquee: [
    { k: "items", label: "Fallback items (used only when there are no upcoming events)", type: "list" },
    { k: "full_width", label: "Full width (edge to edge)", type: "checkbox", fallback: true },
  ],
  contact_form: [
    { k: "heading", label: "Heading" },
    { k: "success_message", label: "Success message", type: "textarea", rows: 2 },
    { k: "full_width", label: "Full width (edge to edge)", type: "checkbox" },
  ],
  newsletter: [
    { k: "heading", label: "Heading" },
    { k: "body", label: "Body", type: "textarea", format: true },
    { k: "cta_label", label: "Button label" },
    { k: "full_width", label: "Full width (edge to edge)", type: "checkbox" },
  ],
  video: [
    { k: "url", label: "YouTube / Vimeo / SoundCloud / Bandcamp URL" },
    { k: "file_url", label: "Or upload a video file", type: "video" },
    { k: "autoplay", label: "Autoplay (always muted — browsers require it)", type: "checkbox" },
    { k: "loop", label: "Loop", type: "checkbox" },
    { k: "muted", label: "Start muted", type: "checkbox" },
    { k: "controls", label: "Show player controls (uploaded files)", type: "checkbox" },
    { k: "file_url_mobile", label: "Mobile cut (optional)", type: "video",
      fileKey: "file_url_mobile", posterKey: "poster_url_mobile" },
    { k: "aspect", label: "Aspect ratio — desktop", type: "select", options: ["16:9", "21:9", "4:3", "1:1", "3:4", "16:10", "3:2"],
      // SoundCloud and Bandcamp render as a fixed-height player strip and ignore this.
      // Hidden rather than left visible: a control that looks editable and changes
      // nothing is the same bug the hero's overlay boolean had.
      when: (v) => !/soundcloud\.com|bandcamp\.com/i.test(v.url || "") },
    { k: "aspect_mobile", label: "Aspect ratio — mobile", type: "select",
      options: ["9:16", "4:5", "1:1", "3:4", "4:3", "16:9"],
      when: (v) => !/soundcloud\.com|bandcamp\.com/i.test(v.url || "") },
    { k: "embed_height", label: "Player height (px)",
      // The mirror of the rule above: only audio embeds are sized by height, and blank
      // means the default for what is playing — a playlist gets more room than a track.
      when: (v) => /soundcloud\.com|bandcamp\.com/i.test(v.url || "") },
    { k: "caption", label: "Caption" },
    { k: "full_width", label: "Full width (edge to edge)", type: "checkbox" },
  ],
  image_band: [
    { k: "image_url", label: "Background image", type: "image" },
    // Hidden for the fixed variant: that photo is drawn at full width with its height
    // left free, so there is no horizontal crop for this to choose from. A control that
    // looks editable and changes nothing is the bug the overlay boolean had.
    { k: "mobile_focus", label: "Mobile view", type: "select", options: ["left", "center", "right"],
      fallback: "center", when: (v) => !!v.image_url && !v.fixed_bg },
    { k: "fixed_bg", label: "Fixed background (photo stays put as you scroll)", type: "checkbox",
      // Desktop only: mobile browsers ignore background-attachment, so the fixed variant
      // shows no photo below md rather than a broken version of the effect.
      when: (v) => !!v.image_url },
    { k: "overlay_color", label: "Overlay colour", type: "color", fallback: "#050505" },
    { k: "overlay_opacity", label: "Overlay opacity", type: "range", min: 0, max: 100, fallback: 50 },
    { k: "eyebrow", label: "Eyebrow" },
    { k: "heading", label: "Heading", type: "textarea" },
    { k: "body", label: "Body", type: "textarea", format: true },
    { k: "cta_label", label: "Button label" },
    { k: "cta_href", label: "Button link" },
    { k: "cta_style", label: "Button style", type: "select", options: ["outline", "accent"], fallback: "outline" },
    { k: "text_case", label: "Text case", type: "select", options: ["as-typed", "uppercase"], fallback: "as-typed" },
    { k: "align", label: "Text align (horizontal)", type: "select", options: ["left", "center", "right"] },
    { k: "content_y", label: "Text position (vertical)", type: "select", options: ["top", "middle", "bottom"], fallback: "middle" },
    { k: "height", label: "Height", type: "select", options: ["short", "medium", "tall"], fallback: "medium" },
    { k: "full_width", label: "Full width (edge to edge)", type: "checkbox", fallback: true },
  ],
  custom_html: [
    { k: "html", label: "HTML", type: "textarea", rows: 10 },
    { k: "full_width", label: "Full width (edge to edge)", type: "checkbox" },
  ],
  text_panel: [
    { k: "heading", label: "Heading" },
    { k: "content", label: "Content (markdown-ish)", type: "textarea", rows: 10, format: true },
    { k: "height", label: "Panel height (px)", type: "size", unit: "px",
      limits: { min: 80, max: 1200, fallback: 320 } },
    { k: "width", label: "Width", type: "select", options: ["narrow", "normal", "wide"], fallback: "normal" },
    { k: "align", label: "Panel position", type: "select", options: ["left", "center", "right"], fallback: "center" },
    { k: "text_align", label: "Text align", type: "select", options: ["left", "center", "right"], fallback: "left" },
    { k: "full_width", label: "Full width (edge to edge)", type: "checkbox" },
  ],
  spacer: [{ k: "height", label: "Height (e.g. 4rem, 120px)" }],
  split: [
    { k: "direction", label: "Direction", type: "select", options: ["image-left", "image-right"] },
    { k: "image_url", label: "Image", type: "image" },
    // "natural" first, and the default on new blocks: the element takes the height of the
    // photograph rather than cropping every photograph to the same shape. The named
    // ratios stay for blocks that want one, and for every block already published.
    { k: "aspect", label: "Image aspect", type: "select", options: ["natural", "1:1", "4:3", "3:4", "16:9", "16:10", "3:2"] },
    { k: "eyebrow", label: "Eyebrow" },
    { k: "heading", label: "Heading", type: "textarea" },
    { k: "heading_size_desktop", label: "Heading size — desktop", type: "size", breakpoint: "desktop",
      current: splitHeadingSize },
    { k: "heading_size_mobile", label: "Heading size — mobile", type: "size", breakpoint: "mobile",
      current: splitHeadingSize },
    { k: "text_case", label: "Text case", type: "select", options: ["as-typed", "uppercase"], fallback: "uppercase" },
    { k: "body", label: "Body", type: "textarea", format: true },
    { k: "align", label: "Text align (horizontal)", type: "select", options: ["left", "center", "right"], fallback: "left" },
    { k: "content_y", label: "Text position (vertical)", type: "select", options: ["top", "middle", "bottom"], fallback: "middle" },
    { k: "cta_label", label: "CTA label" },
    { k: "cta_href", label: "CTA link" },
    { k: "full_width", label: "Full width (edge to edge)", type: "checkbox" },
  ],
  split_audio: [
    { k: "direction", label: "Direction", type: "select", options: ["image-left", "image-right"] },
    // The block's own control: how the width is shared out. At 50 the two halves meet in
    // the middle of the block, which is where "image central" lands.
    { k: "ratio", label: "Image width (share of the block)", type: "range",
      min: SPLIT_RATIO_LIMITS.min, max: SPLIT_RATIO_LIMITS.max, fallback: SPLIT_RATIO_LIMITS.fallback },
    { k: "image_url", label: "Image", type: "image" },
    // No aspect control on purpose: the photograph keeps its own proportions here and
    // this is the only thing that limits it.
    { k: "max_height", label: "Max height", type: "size", unit: "px", limits: SPLIT_MAX_HEIGHT_LIMITS },
    { k: "eyebrow", label: "Eyebrow" },
    { k: "heading", label: "Heading", type: "textarea" },
    { k: "heading_size_desktop", label: "Heading size — desktop", type: "size", breakpoint: "desktop",
      current: splitHeadingSize },
    { k: "heading_size_mobile", label: "Heading size — mobile", type: "size", breakpoint: "mobile",
      current: splitHeadingSize },
    { k: "text_case", label: "Text case", type: "select", options: ["as-typed", "uppercase"], fallback: "as-typed" },
    { k: "body", label: "Body", type: "textarea", format: true },
    { k: "align", label: "Text align (horizontal)", type: "select", options: ["left", "center", "right"], fallback: "left" },
    { k: "content_y", label: "Text position (vertical)", type: "select", options: ["top", "middle", "bottom"], fallback: "middle" },
    { k: "cta_label", label: "Primary CTA label" },
    { k: "cta_href", label: "Primary CTA link" },
    { k: "cta_style", label: "Primary CTA style", type: "select", options: ["outline", "accent"], fallback: "outline" },
    { k: "second_cta_label", label: "Secondary CTA label" },
    { k: "second_cta_href", label: "Secondary CTA link" },
    { k: "tracks", label: "Audio tracks", type: "tracks" },
    { k: "full_width", label: "Full width (edge to edge)", type: "checkbox" },
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
                {...RAW_TEXT_PROPS} className="input-x !py-2 !text-sm" />
    </>
  );
}

/**
 * A pixel size, set two ways: drag the slider to find it, type the number when you know
 * it. Both write the same value, so neither is the "real" control.
 *
 * The number box keeps its own text while being typed — a bare `Number(input)` would
 * turn a half-typed "1" into a 1px heading and yank the slider to its floor between
 * keystrokes. It commits on a pause like every other field here.
 *
 * The placeholder shows what the block renders at TODAY when nothing has been set, which
 * for a hero saved before this existed is its old named step rather than a guess.
 */
function SizeField({ value, limits, current, unit = "px", onCommit, testId }) {
  const isSet = value !== undefined && value !== null && value !== "";
  const { local, onChange, flush } = useDebouncedField(isSet ? String(value) : "", (text) => {
    const trimmed = text.trim();
    // Cleared on purpose means "go back to the default", not "zero pixels".
    if (trimmed === "") return onCommit(undefined);
    const n = Number(trimmed);
    if (Number.isNaN(n)) return;
    onCommit(Math.min(limits.max, Math.max(limits.min, Math.round(n))));
  });

  return (
    <div className="flex items-center gap-3" data-testid={testId}>
      <input
        type="range" min={limits.min} max={limits.max} step={1} value={current}
        onChange={(e) => onCommit(Number(e.target.value))}
        data-testid={`${testId}-range`} className="flex-1"
      />
      <div className="flex items-center gap-1 shrink-0">
        <input
          type="text" inputMode="numeric" value={local} placeholder={String(current)}
          onChange={(e) => onChange(e.target.value)} onBlur={flush}
          {...RAW_TEXT_PROPS}
          data-testid={`${testId}-number`}
          className="input-x !py-1 !px-2 !text-xs w-14 text-right font-mono-x"
        />
        <span className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4">{unit}</span>
      </div>
    </div>
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
      <div className="font-mono-x text-[10px] uppercase tracking-[0.3em] text-ink-4">{BLOCK_LABELS[block.type]}</div>
      {fields.filter((f) => (f.when ? f.when(v) : true)).map((f) => {
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
        // Prose, not a control. Some blocks do something the panel cannot show — the page
        // background is behind everything rather than in the run of blocks — and a
        // sentence in the panel beats an editor discovering it by publishing.
        if (f.type === "note") {
          return (
            <p key={key} data-testid={`${testId}-note`}
               className="text-[10px] leading-relaxed text-ink-4 border-l border-ink/20 pl-2">
              {f.text}
            </p>
          );
        }
        // Same reason as the image field, plus one more: an upload fills the file and its
        // poster together, so this one commits a patch rather than a single value.
        // A list of uploads, each with a name of its own — same reason as the two above,
        // and it manages a whole array rather than a single value.
        if (f.type === "tracks") {
          return <AudioTracksField key={key} label={f.label} value={v[f.k]}
                                   onChange={commitField(f.k)} testId={testId} />;
        }
        if (f.type === "video") {
          const fileKey = f.fileKey || "file_url";
          const posterKey = f.posterKey || "poster_url";
          return <VideoField key={key} label={f.label}
                             value={v[fileKey] || ""} posterValue={v[posterKey] || ""}
                             fileKey={fileKey} posterKey={posterKey}
                             onPatch={(patch) => onChange(blockId, patch, `${blockId}:${f.k}`)} testId={testId} />;
        }
        return (
          <label key={key} className="block">
            <div className="text-[10px] uppercase tracking-[0.2em] text-ink-3 font-mono-x mb-1">{f.label}</div>
            {f.type === "textarea" && f.format ? (
              <FormattedTextareaField f={f} value={v[f.k] || ""} onCommit={commitField(f.k)} testId={testId} />
            ) : f.type === "textarea" ? (
              <TextareaField value={v[f.k] || ""} rows={f.rows} onCommit={commitField(f.k)} testId={testId} />
            ) : f.type === "select" ? (
              <select value={v[f.k] ?? f.fallback ?? ""} onChange={(e) => commitField(f.k)(e.target.value)}
                      data-testid={testId} className="input-x !py-2 !text-sm">
                {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : f.type === "checkbox" ? (
              <div className="flex items-center gap-2 pt-1">
                <input type="checkbox" checked={v[f.k] ?? f.fallback ?? false} data-testid={testId}
                       onChange={(e) => commitField(f.k)(e.target.checked)} />
                <span className="text-xs text-ink-3">{f.label}</span>
              </div>
            ) : f.type === "number" ? (
              <input type="number" value={v[f.k] ?? ""} onChange={(e) => commitField(f.k)(Number(e.target.value))} className="input-x !py-2 !text-sm" />
            ) : f.type === "color" ? (
              <div className="flex items-center gap-2">
                <input type="color" value={v[f.k] ?? f.fallback ?? "#050505"} onChange={(e) => commitField(f.k)(e.target.value)}
                       data-testid={testId} className="h-8 w-12 bg-transparent border border-ink/20 p-0" />
                <span className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4">{v[f.k] ?? f.fallback ?? "#050505"}</span>
              </div>
            ) : f.type === "size" ? (
              <SizeField
                value={v[f.k]} testId={testId} onCommit={commitField(f.k)}
                unit={f.unit || "px"}
                // Three shapes share this control: the hero's heading sizes (per
                // breakpoint), the hero's height (vh), and anything that just names its
                // own bounds. Without the last case a panel height in px would silently
                // borrow the hero's 10-100vh limits.
                limits={f.limits || (f.breakpoint ? HERO_SIZE_LIMITS[f.breakpoint] : HERO_HEIGHT_LIMITS)}
                /* The placeholder has to be what the block renders at TODAY, which is a
                   question only the block can answer: a split with no size set is at
                   30/48px and a hero with none is at 48/72. `f.current` is that block's
                   own resolver; the hero's is the default because it was here first. */
                current={f.limits
                  ? (Number(v[f.k]) || f.limits.fallback)
                  : f.breakpoint ? (f.current || heroHeadingSize)(v)[f.breakpoint] : heroHeight(v)}
              />
            ) : f.type === "offset" ? (
              /* A slider from the top of the image to the bottom, with the three places
                 the old select offered marked on it — so the control both replaces it
                 and shows where its values used to land. */
              <div>
                <div className="flex items-center gap-3">
                  <input type="range" min={0} max={100} step={1}
                         value={contentOffset(v, f.fallback)}
                         onChange={(e) => commitField(f.k)(Number(e.target.value))}
                         data-testid={testId} className="flex-1" />
                  <span className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 w-12 text-right">
                    {contentOffset(v, f.fallback)}%
                  </span>
                </div>
                <div className="mt-1 flex justify-between font-mono-x text-[9px] uppercase tracking-[0.15em] text-ink-5">
                  {[["Top", 0], ["Middle", 50], ["Bottom", 100]].map(([label, at]) => (
                    <button key={at} type="button" onClick={() => commitField(f.k)(at)}
                            data-testid={`${testId}-${at}`}
                            className="hover:text-ink">{label}</button>
                  ))}
                </div>
              </div>
            ) : f.type === "range" ? (
              <div className="flex items-center gap-3">
                <input type="range" min={f.min ?? 0} max={f.max ?? 100} value={v[f.k] ?? f.fallback ?? 0}
                       onChange={(e) => commitField(f.k)(Number(e.target.value))}
                       data-testid={testId} className="flex-1" />
                <span className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4 w-10 text-right">{v[f.k] ?? f.fallback ?? 0}%</span>
              </div>
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
      <div className="font-mono-x text-[10px] uppercase tracking-[0.3em] text-ink-4">Page</div>
      <label className="block">
        <div className="text-[10px] uppercase tracking-[0.2em] text-ink-3 font-mono-x mb-1">Title</div>
        <TextField value={page.title || ""} onCommit={(val) => onChange({ title: val })} testId="cms-page-title" />
      </label>
      <label className="block">
        <div className="text-[10px] uppercase tracking-[0.2em] text-ink-3 font-mono-x mb-1">Nav label</div>
        <TextField value={page.nav_label || page.title || ""} onCommit={(val) => onChange({ nav_label: val })} testId="cms-page-nav-label" />
      </label>
      {/* A page is in the top nav or in the footer, never both — the server enforces it,
          and these mirror that so the panel does not show an impossible state for the
          moment between the click and the response. */}
      <label className="block flex items-center gap-2 mt-2"><input type="checkbox" checked={!!page.in_nav}
        onChange={(e) => onChange(e.target.checked ? { in_nav: true, in_footer: false } : { in_nav: false })} />
        <span className="text-xs text-ink-2">Show in main navigation</span></label>
      <label className="block flex items-center gap-2"><input type="checkbox" checked={!!page.in_footer} data-testid="cms-page-in-footer"
        onChange={(e) => onChange(e.target.checked ? { in_footer: true, in_nav: false } : { in_footer: false })} />
        <span className="text-xs text-ink-2">Show in footer</span></label>
      <div className="pt-3 text-xs text-ink-4">
        Slug: <span className="font-mono-x">/p/{page.slug}</span> (immutable)<br />
        Tip: click any block in the preview to edit its properties here.
      </div>
    </div>
  );
}

/* Exported for its test. The theme dropdown is the one control an editor uses to pick
   a whole look, and it is worth asserting against the rendered <select> rather than
   against the data behind it. */
export function ThemeEditor({ theme, onChange, onPublish, customFonts, onFontsChanged }) {
  const setColor = (k, v) => onChange({ colors: { ...(theme.colors || {}), [k]: v } });
  const setFont = async (k, v) => {
    await onChange({ fonts: { ...(theme.fonts || {}), [k]: v } });
    // `in_use` is derived from the theme server-side, so picking a font is exactly the
    // moment it goes stale — and it is the flag that warns before a delete. Refetch.
    onFontsChanged().catch(() => {});
  };
  /** Choosing a theme.
   *
   * Dark and Light rewrite the five neutrals and keep the accent and fonts, which is
   * what they have always done: the alternative, a `light` flag components branch on,
   * means every colour needs two values and every new component has to remember both.
   * A named theme like Supersanity replaces the document instead. themeChoicePatch
   * owns that branch; this just applies whatever it returns, in one onChange so the
   * change is one autosave, one undo and one live repaint. */
  const activeTheme = theme.mode || "dark";
  const matchesExactly = presetIdFor(theme);
  const contrastWarnings = failingPairs(theme.colors);
  const chooseTheme = async (id) => {
    const patch = themeChoicePatch(id, theme.colors);
    if (!patch) return;
    await onChange(patch);
    // Same reason as setFont: `in_use` is derived from the theme server-side, and a
    // named theme can swap all three families at once.
    onFontsChanged().catch(() => {});
  };
  return (
    <div className="space-y-4">
      <div className="font-mono-x text-[10px] uppercase tracking-[0.3em] text-ink-4">Colors</div>
      {[["bg", "Background"], ["surface", "Surface"], ["text", "Text"], ["textMuted", "Text muted"], ["accent", "Accent"], ["accentFg", "Accent text"], ["success", "Success"]].map(([k, label]) => (
        <label key={k} className="block">
          <div className="text-[10px] uppercase tracking-[0.2em] text-ink-3 font-mono-x mb-1">{label}</div>
          <div className="flex items-center gap-2">
            <input type="color" value={theme.colors?.[k] || "#000000"} onChange={(e) => setColor(k, e.target.value)} className="w-10 h-10 bg-transparent border border-ink/20" />
            <input value={theme.colors?.[k] || ""} onChange={(e) => setColor(k, e.target.value)} className="input-x !py-1.5 !text-xs font-mono-x flex-1" />
          </div>
        </label>
      ))}

      {/* Mode flips keep the accent so a customer's brand colour survives them, which
          means a red picked on the dark theme can land below AA on the light one. That
          is caught here rather than by overwriting their colour. */}
      {contrastWarnings.length > 0 && (
        <div data-testid="contrast-warnings"
             className="border border-brand px-3 py-2 font-mono-x text-[10px] uppercase tracking-[0.15em] leading-relaxed">
          <div className="text-brand mb-1">Below AA ({AA_TEXT}:1)</div>
          {contrastWarnings.map((w) => (
            <div key={w.label} className="text-ink-3">{w.label} &middot; {w.ratio.toFixed(2)}:1</div>
          ))}
        </div>
      )}

      <div className="font-mono-x text-[10px] uppercase tracking-[0.3em] text-ink-4 pt-4">Fonts</div>
      {[["display", "Display / headings"], ["body", "Body"], ["mono", "Mono / labels"]].map(([k, label]) => (
        <FontPicker key={k} label={label} value={theme.fonts?.[k] || ""} custom={customFonts}
                    testId={`font-${k}`} onChange={(v) => setFont(k, v)} />
      ))}

      <div className="font-mono-x text-[10px] uppercase tracking-[0.3em] text-ink-4 pt-4">Your fonts</div>
      <FontManager fonts={customFonts} onChanged={onFontsChanged} />

      <div className="font-mono-x text-[10px] uppercase tracking-[0.3em] text-ink-4 pt-4">Layout</div>
      <label className="block">
        <div className="text-[10px] uppercase tracking-[0.2em] text-ink-3 font-mono-x mb-1">Border radius: {theme.radius || 0}px</div>
        <input type="range" min="0" max="24" value={theme.radius || 0} onChange={(e) => onChange({ radius: Number(e.target.value) })} className="w-full" />
      </label>
      <label className="block">
        <div className="text-[10px] uppercase tracking-[0.2em] text-ink-3 font-mono-x mb-1">Button style</div>
        <select value={theme.button_style || "sharp"} onChange={(e) => onChange({ button_style: e.target.value })} className="input-x !py-2 !text-sm">
          <option value="sharp">Sharp (0px)</option>
          <option value="pill">Pill (fully rounded)</option>
        </select>
      </label>
      <label className="block">
        <div className="text-[10px] uppercase tracking-[0.2em] text-ink-3 font-mono-x mb-1">Theme</div>
        <select value={activeTheme} data-testid="theme-mode-select"
                onChange={(e) => chooseTheme(e.target.value)} className="input-x !py-2 !text-sm">
          {THEME_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
        <div className="mt-1 font-mono-x text-[9px] uppercase tracking-[0.15em] text-ink-5 leading-relaxed">
          {THEME_PRESETS.find((p) => p.id === activeTheme)?.note}
          {matchesExactly === null && " · edited"}
        </div>
      </label>

      <button onClick={onPublish} data-testid="publish-theme-btn" className="btn-accent w-full mt-6">PUBLISH THEME</button>
    </div>
  );
}

function VersionList({ page, onRevert }) {
  const versions = page.versions || [];
  return (
    <div className="space-y-2">
      <div className="font-mono-x text-[10px] uppercase tracking-[0.3em] text-ink-4">History (last {versions.length})</div>
      {versions.length === 0 && <div className="text-xs text-ink-4 border border-dashed border-ink/10 p-3">Publish once to create the first version.</div>}
      {versions.map((v) => (
        <div key={v.version_id} className="border border-ink/10 p-2 flex items-center justify-between">
          <div>
            <div className="font-mono-x text-[10px] uppercase tracking-[0.2em] text-ink-4">{new Date(v.published_at).toLocaleString("en-GB")}</div>
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
    <div className="fixed inset-0 bg-scrim/80 z-50 flex items-center justify-center p-4">
      <div className="border border-ink/20 bg-[color:var(--surface,#0F0F0F)] p-6 w-full max-w-md space-y-3">
        <div className="font-display uppercase text-xl font-black tracking-tighter">New Page</div>
        <input placeholder="Title (e.g. About)" value={title} onChange={(e) => { setTitle(e.target.value); setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")); }} className="input-x" />
        <input placeholder="slug" value={slug} onChange={(e) => setSlug(e.target.value)} data-testid="new-page-slug" className="input-x font-mono-x" />
        <div className="text-xs text-ink-4">URL will be <span className="font-mono-x">/{slug || "…"}</span></div>
        {/* Pages share the root with the built-in sections now, so some words are taken.
            The server has the authoritative list and refuses them; this is only a hint,
            so the two can't disagree about which ones. */}
        <div className="font-mono-x text-[10px] uppercase tracking-[0.15em] text-ink-5 leading-relaxed">
          Some names are taken by built-in pages (events, shop, cart, login…)
        </div>
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="btn-primary">Cancel</button>
          <button onClick={() => title && slug && onCreate(slug, title)} data-testid="create-page-btn" className="btn-accent">Create</button>
        </div>
      </div>
    </div>
  );
}
