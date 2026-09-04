import { useEffect, useRef, useSyncExternalStore } from "react";

/**
 * One save policy for the whole CMS, and the register every editable surface joins.
 *
 * The CMS grew five places that write: the block draft, page metadata, the theme, the
 * site settings and the events settings. Each arrived with its own idea of when to save,
 * which is how the site settings ended up issuing a PUT per letter typed — nobody
 * decided that, it was just the only surface that never got the debounce the others had.
 *
 * So the policy lives here rather than in any one of them:
 *
 *   OFF BY DEFAULT — nothing is written until someone asks. An editor rewriting a
 *                    paragraph is not publishing five drafts of it, and the database is
 *                    not asked to record a sentence one character at a time.
 *   ON = INTERVAL  — with autosave on, the FIRST edit arms a timer and further edits do
 *                    not push it back. A debounce that resets on every keystroke never
 *                    fires while someone is typing steadily; an interval writes once,
 *                    on the beat, however fast they type.
 *   ONE REGISTER   — every surface joins it, so "Save now", the unsaved-work guard and
 *                    the status indicator each ask one question instead of five, and a
 *                    sixth surface added later is covered by having joined.
 *
 * The preference is per person and per browser, so it lives in localStorage rather than
 * on the site record: it is a working habit, not a property of the site.
 */

const KEY = "supersanity.cms.autosave";

/** Long on purpose. This is the whole point of the interval — a save every fifteen
 *  seconds of continuous editing, not one per pause in typing. */
export const AUTOSAVE_INTERVAL_MS = 15000;

const read = () => {
  try {
    return window.localStorage.getItem(KEY) === "on";
  } catch {
    // Private windows and blocked site data both throw here. Off is the safe reading:
    // it is the default, and it never writes anything the editor did not ask for.
    return false;
  }
};

let enabled = read();
const listeners = new Set();
const notify = () => listeners.forEach((l) => l());

export function setAutosaveEnabled(on) {
  enabled = Boolean(on);
  try {
    window.localStorage.setItem(KEY, enabled ? "on" : "off");
  } catch {
    // The preference still holds for this session; it just will not outlive the tab.
  }
  notify();
}

export const isAutosaveEnabled = () => enabled;

/** Subscribe a component to the preference. */
export function useAutosaveEnabled() {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    () => enabled,
    () => false, // server render: the default
  );
}

/* ---- the register ---------------------------------------------------------------- */

const savers = new Set();
const registryListeners = new Set();
const notifyRegistry = () => registryListeners.forEach((l) => l());

/** Join the register for as long as the calling component is mounted.
 *
 * `entry` is read through a ref rather than captured, so a flush always calls the
 * current closure instead of the one that existed when the component first rendered.
 *
 * `signal` is whatever the caller wants the rest of the editor to notice — in practice
 * its dirty flag and its save state. It is a dependency, not a payload: when it changes,
 * subscribers re-render and ask the register their own questions again.
 *
 * This is cheap despite looking like it is not. Dirty flips false→true ONCE at the start
 * of an editing run and back at the end; it does not change per keystroke. Leaving it
 * out was the obvious economy and it was wrong: the toolbar never learned that the site
 * pane had unsaved work, so "Save now" sat disabled over a field full of it. */
export function useRegisteredSaver(entry, signal) {
  const ref = useRef(entry);
  ref.current = entry;
  useEffect(() => {
    const handle = { get current() { return ref.current; } };
    savers.add(handle);
    notifyRegistry();
    return () => { savers.delete(handle); notifyRegistry(); };
  }, []);
  useEffect(() => { notifyRegistry(); }, [signal]);
}

/** Write every surface holding unsaved work. Used by "Save now", by ⌘S, and by the
 *  guard that runs when a tab is being closed. */
export async function flushAllSavers() {
  await Promise.all([...savers].map((s) => {
    try { return s.current.flush(); } catch { return undefined; }
  }));
}

export const anySaverDirty = () => [...savers].some((s) => {
  try { return s.current.isDirty(); } catch { return false; }
});

/** Every registered surface's save state, for the one indicator that speaks for all of
 *  them. Reading it here rather than from each surface's return value is what lets a
 *  surface with no parent watching it — the site settings, the events tabs — report a
 *  failure at all. */
export const saverStates = () => [...savers].map((s) => {
  try { return s.current.getState?.() || "idle"; } catch { return "idle"; }
});

/** The first reason any surface has for its last failure, in the server's words.
 *  One line has room for one reason, and simultaneous failures share a cause far more
 *  often than not: one expired session, one unreachable backend. */
export const firstSaverError = () => {
  for (const s of savers) {
    try {
      const e = s.current.getError?.();
      if (e) return e;
    } catch { /* a surface mid-unmount has nothing to say */ }
  }
  return null;
};

let version = 0;
const bumpVersion = () => { version += 1; };
registryListeners.add(bumpVersion);

/** Re-renders the caller when a surface joins, leaves, or changes what it is signalling.
 *
 * The snapshot is a counter rather than the dirty flag itself: `useSyncExternalStore`
 * compares snapshots by identity, and a derived boolean would be recomputed — and
 * compared equal — for two genuinely different register states.
 */
export function useSaverRegistry() {
  return useSyncExternalStore(
    (fn) => { registryListeners.add(fn); return () => registryListeners.delete(fn); },
    () => version,
    () => 0,
  );
}
