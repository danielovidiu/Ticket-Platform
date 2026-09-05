/**
 * Where the door's unsent scans live between losing signal and getting it back.
 *
 * Storage only — no React, no `http`, no imports at all. That is deliberate and it is the
 * same reason lib/albums.js exists: `auth.jsx` has to empty this queue on sign-out, and
 * auth.jsx is in the entry chunk while the scanner is a lazy route. Importing the hook
 * from auth pulled the whole of hooks/useScanner.js into the bundle every visitor
 * downloads — measured at +5.6 kB, with the Scan chunk shrinking by the same amount.
 * A leaf module is free to both.
 *
 * WHAT THE STORED STRINGS ARE. Ticket QR codes, not auth tokens and not PII. On their own
 * they admit nobody: /api/scan requires an authenticated admin or door session carried in
 * an httpOnly cookie, which nothing here can supply.
 *
 * WHAT THEY STILL ARE. A list of tickets sitting in plain localStorage on a device that is
 * often shared, sometimes borrowed and occasionally left on a table. So the queue is
 * bounded in three directions rather than kept forever — it previously had no expiry, no
 * cap and no clearing, so a tablet accumulated every code it had ever failed to send.
 */

/** How long a queued scan stays worth replaying. One day: long enough to cover a night
 *  that ran over plus the trip home, short enough that a forgotten tablet is not carrying
 *  last month's door around in it. */
export const SCAN_QUEUE_TTL_MS = 24 * 60 * 60 * 1000;

/** The most entries kept. A busy door scans a few hundred in a night, and anything past
 *  this means the device has been offline far longer than the TTL covers anyway. Also
 *  stops a stuck queue filling the origin's storage quota out from under the app. */
export const SCAN_QUEUE_MAX = 500;

const OFFLINE_KEY = "supersanity_scan_queue";

/**
 * The queue, with anything expired, malformed or unreadable dropped.
 *
 * Entries are `{ code, at }`. They used to be bare strings, so those are still accepted —
 * a device that went offline before this deploy has a queue in the old shape and its codes
 * are not worth discarding. They are read as having just arrived, which expires them one
 * TTL from now rather than instantly; the generous reading, since the alternative silently
 * throws away scans that the door believed were saved.
 */
export function readScanQueue(at = Date.now()) {
  let raw;
  try {
    raw = JSON.parse(localStorage.getItem(OFFLINE_KEY) || "[]");
  } catch {
    // Corrupt JSON, private mode, storage disabled. An unreadable queue is an empty one;
    // throwing here would take the scanner down over something the door cannot fix.
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => (typeof entry === "string" ? { code: entry, at } : entry))
    .filter((e) => e && typeof e.code === "string" && e.code
      && typeof e.at === "number" && at - e.at < SCAN_QUEUE_TTL_MS)
    .slice(-SCAN_QUEUE_MAX);
}

/** Replace the queue, keeping only the newest SCAN_QUEUE_MAX entries. */
export function writeScanQueue(entries) {
  try {
    localStorage.setItem(OFFLINE_KEY, JSON.stringify(entries.slice(-SCAN_QUEUE_MAX)));
  } catch {
    // Quota exceeded, or storage unavailable. Nothing useful to do here: the scan already
    // happened and the person is already through the door.
  }
}

/**
 * Empty it. Called from auth.jsx on sign-out.
 *
 * Door devices are shared between shifts, and a queue that survives sign-out hands the
 * next person a list of the last person's tickets. Everything else this app keeps in
 * localStorage is a preference or a cache of public data, and is deliberately left alone.
 */
export function clearScanQueue() {
  try {
    localStorage.removeItem(OFFLINE_KEY);
  } catch {
    // Nothing to clean up if storage cannot be reached.
  }
}
