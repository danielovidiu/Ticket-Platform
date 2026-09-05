/**
 * The door's offline queue, and the three bounds it did not used to have.
 *
 * The stored strings are ticket QR codes. They admit nobody on their own — /api/scan wants
 * an authenticated admin or door session in an httpOnly cookie — but they are still a list
 * of tickets on a device that gets shared between shifts, so how long they live matters.
 */
import {
  readScanQueue,
  writeScanQueue,
  clearScanQueue,
  SCAN_QUEUE_TTL_MS,
  SCAN_QUEUE_MAX,
} from "./scanQueue";

const KEY = "supersanity_scan_queue";
const raw = () => JSON.parse(localStorage.getItem(KEY) || "[]");

beforeEach(() => localStorage.clear());

describe("what comes back out", () => {
  test("a written entry round-trips", () => {
    writeScanQueue([{ code: "SNTY-AAA1111", at: 1_000 }]);
    expect(readScanQueue(1_000)).toEqual([{ code: "SNTY-AAA1111", at: 1_000 }]);
  });

  test("an empty or absent queue reads as empty", () => {
    expect(readScanQueue()).toEqual([]);
    localStorage.setItem(KEY, "[]");
    expect(readScanQueue()).toEqual([]);
  });
});

describe("entries expire", () => {
  test("one inside the TTL survives", () => {
    writeScanQueue([{ code: "FRESH", at: 0 }]);
    expect(readScanQueue(SCAN_QUEUE_TTL_MS - 1).map((e) => e.code)).toEqual(["FRESH"]);
  });

  test("one past the TTL is dropped", () => {
    writeScanQueue([{ code: "STALE", at: 0 }]);
    expect(readScanQueue(SCAN_QUEUE_TTL_MS + 1)).toEqual([]);
  });

  test("exactly at the TTL is already too old", () => {
    // The boundary is stated rather than left to chance: `at - e.at < TTL`.
    writeScanQueue([{ code: "EDGE", at: 0 }]);
    expect(readScanQueue(SCAN_QUEUE_TTL_MS)).toEqual([]);
  });

  test("the fresh ones survive alongside the stale", () => {
    writeScanQueue([
      { code: "OLD", at: 0 },
      { code: "NEW", at: SCAN_QUEUE_TTL_MS },
    ]);
    expect(readScanQueue(SCAN_QUEUE_TTL_MS + 10).map((e) => e.code)).toEqual(["NEW"]);
  });
});

describe("the queue is bounded", () => {
  test("writing more than the cap keeps the NEWEST", () => {
    const many = Array.from({ length: SCAN_QUEUE_MAX + 50 },
      (_, i) => ({ code: `C${i}`, at: 1_000 }));
    writeScanQueue(many);
    const stored = raw();
    expect(stored).toHaveLength(SCAN_QUEUE_MAX);
    // The last ones written, not the first — a full queue should shed history, not
    // refuse the scan that just happened.
    expect(stored[stored.length - 1].code).toBe(`C${SCAN_QUEUE_MAX + 49}`);
  });
});

describe("sign-out empties it", () => {
  test("clearScanQueue removes the key entirely", () => {
    writeScanQueue([{ code: "SNTY-BBB2222", at: Date.now() }]);
    clearScanQueue();
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(readScanQueue()).toEqual([]);
  });
});

describe("it survives what the device hands it", () => {
  test("legacy bare strings are kept, not thrown away", () => {
    // A device that went offline before the {code, at} shape existed. Discarding these
    // would silently lose scans the door believed were saved.
    localStorage.setItem(KEY, JSON.stringify(["SNTY-OLD1", "SNTY-OLD2"]));
    expect(readScanQueue(5_000).map((e) => e.code)).toEqual(["SNTY-OLD1", "SNTY-OLD2"]);
  });

  test("and they expire one TTL from now rather than immediately", () => {
    localStorage.setItem(KEY, JSON.stringify(["SNTY-OLD1"]));
    expect(readScanQueue(5_000)).toHaveLength(1);
    expect(readScanQueue(5_000)[0].at).toBe(5_000);
  });

  test("corrupt JSON reads as empty instead of throwing", () => {
    localStorage.setItem(KEY, "{not json");
    expect(readScanQueue()).toEqual([]);
  });

  test("a non-array payload reads as empty", () => {
    localStorage.setItem(KEY, JSON.stringify({ code: "nope" }));
    expect(readScanQueue()).toEqual([]);
  });

  test("malformed entries are dropped and the good ones kept", () => {
    localStorage.setItem(KEY, JSON.stringify([
      { code: "GOOD", at: 1_000 },
      { code: "", at: 1_000 },
      { at: 1_000 },
      { code: "NO_TIMESTAMP" },
      null,
      42,
    ]));
    expect(readScanQueue(1_000).map((e) => e.code)).toEqual(["GOOD"]);
  });
});
