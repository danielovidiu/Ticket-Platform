import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The save policy the CMS uses everywhere something is edited.
 *
 * It was written once, inline, for the block draft — and the two other editable surfaces
 * never got it. Page title and nav label fired a PATCH plus two GETs on every keystroke;
 * the theme fired one per change, which for a colour picker is one per pixel dragged.
 * Neither debounced, neither ordered its writes, and neither could report a failure.
 *
 * Four properties, and each exists because its absence was a bug:
 *
 *   DEBOUNCE      — wait for a pause before writing, so typing is not a request per key.
 *   CEILING       — but never wait longer than `maxWait`. A plain debounce resets on
 *                   every keystroke, so someone typing steadily for two minutes had
 *                   nothing persisted for two minutes.
 *   ONE IN FLIGHT — a save requested while one is running is queued and re-run with the
 *                   newest value afterwards. Without this a slow request can land after
 *                   a newer one and resurrect stale content.
 *   HONEST STATE  — "saved" means the server said so. A swallowed failure leaving the
 *                   editor claiming "Saved just now" is the worst outcome available.
 *
 * The caller owns the value and passes `getPending`, read at write time rather than at
 * schedule time, so a save always writes the newest state rather than the snapshot that
 * happened to be current when the timer was armed.
 */
export function useAutosave({ getPending, save, delay = 1200, maxWait = 5000 }) {
  const [state, setState] = useState("idle"); // idle | saving | saved | error
  const [savedAt, setSavedAt] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [revision, setRevision] = useState(0);

  const savedRef = useRef(undefined);   // what the server last acknowledged
  const dirtySinceRef = useRef(0);
  const inFlightRef = useRef(false);
  const queuedRef = useRef(false);
  // Both change identity every render; a pending timer must call the current ones.
  const getPendingRef = useRef(getPending);
  const saveRef = useRef(save);
  useEffect(() => { getPendingRef.current = getPending; saveRef.current = save; });

  const flush = useCallback(async () => {
    const value = getPendingRef.current();
    if (value === undefined || value === savedRef.current) return;
    if (inFlightRef.current) { queuedRef.current = true; return; }

    inFlightRef.current = true;
    setState("saving");
    try {
      await saveRef.current(value);
      savedRef.current = value;
      setSavedAt(Date.now());
      setState("saved");
      // Only clear the flag if nothing changed while the request was in the air.
      if (getPendingRef.current() === value) {
        setDirty(false);
        dirtySinceRef.current = 0;
      }
    } catch {
      // Left dirty on purpose: the next edit re-arms the timer, so this retries on its
      // own, and the status says so meanwhile.
      setState("error");
    } finally {
      inFlightRef.current = false;
      if (queuedRef.current) { queuedRef.current = false; flush(); }
    }
  }, []);

  /** Call on every edit. Marks dirty and re-arms the timer. */
  const bump = useCallback(() => {
    if (!dirtySinceRef.current) dirtySinceRef.current = Date.now();
    setDirty(true);
    setRevision((r) => r + 1);
  }, []);

  /** Adopt a value straight from the server: nothing pending, nothing to save. */
  const reset = useCallback((value) => {
    savedRef.current = value;
    dirtySinceRef.current = 0;
    setDirty(false);
    setState("idle");
  }, []);

  useEffect(() => {
    if (!dirty) return undefined;
    const elapsed = dirtySinceRef.current ? Date.now() - dirtySinceRef.current : 0;
    const wait = Math.max(0, Math.min(delay, maxWait - elapsed));
    const t = setTimeout(flush, wait);
    return () => clearTimeout(t);
  }, [revision, dirty, flush, delay, maxWait]);

  return { state, savedAt, dirty, bump, flush, reset };
}

/**
 * Local state for a text input that pushes upward on a pause.
 *
 * Binding an input straight to editor state means a full re-render inside every
 * keystroke; once that render outlasts the gap between two keys, React writes the older
 * state back into the input and the characters typed in between are lost. Keeping the
 * value here and pushing on a delay is what makes typing feel like typing.
 *
 * The same ceiling applies for the same reason: a debounce that never elapses starves
 * whatever is downstream of it.
 */
export const FIELD_DEBOUNCE_MS = 250;
export const FIELD_MAX_WAIT_MS = 600;

export function useDebouncedField(external, onCommit, { delay = FIELD_DEBOUNCE_MS, maxWait = FIELD_MAX_WAIT_MS } = {}) {
  const [local, setLocal] = useState(external);
  const localRef = useRef(external);
  const pushedRef = useRef(external);
  const timer = useRef(null);
  const pendingSinceRef = useRef(0);
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
    timer.current = setTimeout(() => push(val), Math.max(0, Math.min(delay, maxWait - waited)));
  }, [push, delay, maxWait]);

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    if (localRef.current !== pushedRef.current) push(localRef.current);
  }, [push]);

  // Blur covers clicking away; unmount covers switching block or page mid-word.
  useEffect(() => () => {
    clearTimeout(timer.current);
    if (localRef.current !== pushedRef.current) push(localRef.current);
  }, [push]);

  return { local, onChange, flush };
}
