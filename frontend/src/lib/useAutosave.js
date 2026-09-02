import { useCallback, useEffect, useRef, useState } from "react";
import { AUTOSAVE_INTERVAL_MS, useAutosaveEnabled, useRegisteredSaver } from "./autosavePolicy";
import { errorText } from "../api";

/**
 * The save policy the CMS uses everywhere something is edited.
 *
 * It was written once, inline, for the block draft — and the two other editable surfaces
 * never got it. Page title and nav label fired a PATCH plus two GETs on every keystroke;
 * the theme fired one per change, which for a colour picker is one per pixel dragged.
 * Neither debounced, neither ordered its writes, and neither could report a failure.
 *
 * When it writes is not its own decision any more — that is one policy for the whole
 * CMS, and it lives in autosavePolicy.js. This hook is how a surface obeys it.
 *
 * Four properties, and each exists because its absence was a bug:
 *
 *   INTERVAL      — with autosave on, the first edit of a run arms a timer and later
 *                   edits do not push it back. A debounce that resets on every keystroke
 *                   never fires while somebody is typing steadily.
 *   OFF IS OFF    — with autosave off, nothing is scheduled. The work stays dirty, says
 *                   so, and is written when a person asks.
 *   ONE IN FLIGHT — a save requested while one is running is queued and re-run with the
 *                   newest value afterwards. Without this a slow request can land after
 *                   a newer one and resurrect stale content.
 *   HONEST STATE  — "saved" means the server said so. A swallowed failure leaving the
 *                   editor claiming "Saved just now" is the worst outcome available.
 *   SAYS WHY      — and a failure carries the server's reason. "Save failed" alone is
 *                   true and useless: an expired session, a draft over the size limit
 *                   and a dead backend all produced that one string, so the first
 *                   question it raises is the one it cannot answer.
 *
 * The caller owns the value and passes `getPending`, read at write time rather than at
 * schedule time, so a save always writes the newest state rather than the snapshot that
 * happened to be current when the timer was armed.
 */
export function useAutosave({ getPending, save, intervalMs = AUTOSAVE_INTERVAL_MS }) {
  const [state, setState] = useState("idle"); // idle | saving | saved | error
  // Why the last save failed, in the server's words. Null whenever `state` is not
  // "error", so it cannot outlive the failure it describes.
  const [error, setError] = useState(null);
  const [savedAt, setSavedAt] = useState(null);
  const [dirty, setDirty] = useState(false);
  // Bumped when a save finishes with work still outstanding. `dirty` alone cannot
  // re-arm the interval: it was already true before the save and is still true after,
  // so the effect's dependencies never change and no new timer is ever set. The symptom
  // is the last thing you typed never being written at all.
  const [resume, setResume] = useState(0);

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
      setError(null);
      setState("saved");
      // Only clear the flag if nothing changed while the request was in the air.
      if (getPendingRef.current() === value) {
        setDirty(false);
        dirtySinceRef.current = 0;
      }
    } catch (err) {
      // Left dirty on purpose: the next edit re-arms the timer, so this retries on its
      // own, and the status says so meanwhile.
      //
      // The reason is logged in development. A bare `catch {}` here cost real time once:
      // the request was answering 200 and the editor was reporting a failure, and with
      // the exception swallowed there was nothing to say which half was lying.
      if (import.meta.env?.DEV) console.error("[autosave] save failed", err);
      setError(errorText(err, "Save failed"));
      setState("error");
    } finally {
      inFlightRef.current = false;
      if (queuedRef.current) {
        queuedRef.current = false;
        flush();
      } else {
        // Hand back to the interval rather than writing again straight away: someone
        // typing without pause would otherwise get one request per round trip, which is
        // the request-per-keystroke problem wearing a different hat.
        setResume((r) => r + 1);
      }
    }
  }, []);

  /** Call on every edit. Marks dirty and re-arms the timer. */
  const bump = useCallback(() => {
    if (!dirtySinceRef.current) dirtySinceRef.current = Date.now();
    // No revision counter. It existed to force a render per edit; nothing reads it now,
    // and a render inside the typing loop is exactly the lag being removed.
    setDirty(true);
  }, []);

  /** Adopt a value straight from the server: nothing pending, nothing to save. */
  const reset = useCallback((value) => {
    savedRef.current = value;
    dirtySinceRef.current = 0;
    setDirty(false);
    setError(null);
    setState("idle");
  }, []);

  const autosave = useAutosaveEnabled();

  /* The interval, and the reason `revision` is deliberately NOT a dependency.
   *
   * Listing it would re-arm the timer on every keystroke, which is a debounce wearing an
   * interval's clothes: someone typing steadily for a minute would push the deadline
   * ahead of themselves the whole time and nothing would ever be written. Depending only
   * on `dirty` means the clock starts at the first edit of a run and fires once, on the
   * beat, no matter how much is typed in between.
   *
   * With autosave off nothing is armed at all. The work stays dirty and visible as such,
   * and goes to the server when a person asks — "Save now", ⌘S, or the guard on the way
   * out of the tab. */
  useEffect(() => {
    if (!autosave || !dirty) return undefined;
    const t = setTimeout(flush, intervalMs);
    return () => clearTimeout(t);
  }, [autosave, dirty, flush, intervalMs, resume]);

  // Joining the register is what lets one Save button, one status line and one unsaved
  // guard cover a surface without knowing it exists.
  // The signal is what tells the toolbar this surface has work outstanding — `state` as
  // well as `dirty`, so a failed save keeps "Save now" live rather than going quiet.
  // `getState` and `getError` are read through the register rather than returned to a
  // parent, because two of the five surfaces have no parent watching them: the site
  // settings and the events tabs were failing entirely silently — their `state` was
  // never read anywhere, so a rejected write left no trace on screen at all.
  useRegisteredSaver(
    { flush, isDirty: () => dirty, getState: () => state, getError: () => error },
    `${dirty}:${state}:${error || ""}`,
  );

  return { state, error, savedAt, dirty, bump, flush, reset };
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
