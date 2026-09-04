#!/usr/bin/env python
"""
Re-encode images that were stored before the upload path learned to size them.

WHY THIS EXISTS. `_reencode_image` in server.py now caps the long edge at
STORED_IMAGE_MAX_EDGE and stores photographic PNGs as WebP. That fixes every upload from
here on and does nothing for what is already in the store — which, on the beta deploy at
the time of writing, is one homepage carrying 2,548,181 bytes of images to fill boxes no
wider than 1272 CSS pixels. The single worst offender is a 1500x1000 photograph stored as
a 2,252,542-byte PNG; the same picture through the new encoder is 187,958 bytes, at
identical dimensions.

WHAT IT DOES. Walks the collections that can hold a media URL, finds the ones this app
stored, re-encodes each, and — where the result is meaningfully smaller — writes it as a
NEW object and rewrites every reference to point at it.

WHAT IT DELIBERATELY DOES NOT DO.

  * It never deletes the old object. Rolling back is then a matter of restoring the
    documents, not of recovering bytes that are gone. Reclaiming that space is a separate
    decision, taken once this is known to have gone well.
  * It never touches a URL it did not store. The seeded gallery rows point at Unsplash,
    and re-hosting somebody else's image is not a size optimisation.
  * It does not re-encode in place under the same key. That would need no database write
    at all, and it would leave a `.png` URL serving WebP bytes — correct in practice,
    since the content-type header is what a browser obeys, and a trap for the next person
    to read the store.
  * It changes nothing without --apply.

USAGE
    venv/bin/python scripts/reprocess_images.py               # dry run, prints a report
    venv/bin/python scripts/reprocess_images.py --apply       # actually rewrites
    venv/bin/python scripts/reprocess_images.py --min-saving 20000 --apply

Run it against one deployment at a time, with the same environment the app uses — it
reads MONGO_URL and BLOB_READ_WRITE_TOKEN exactly as server.py does, so pointing it at
production means pointing your shell at production.
"""
import argparse
import asyncio
import io
import os
import sys
from pathlib import Path

# The backend package sits one level up; mirrors what tests/conftest.py does.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx  # noqa: E402
from PIL import Image  # noqa: E402

import server  # noqa: E402
import storage  # noqa: E402

# Where a media URL can appear. Every document in these is walked recursively rather than
# by named field, because the CMS keeps its images inside block props — arbitrarily nested
# lists of objects whose shape is per block type, and which would go stale here the first
# time somebody adds a block with a new image field.
COLLECTIONS = ("events", "artists", "gallery", "products", "albums",
               "cms_pages", "site_settings", "shop_settings")

# Extension -> the content type _reencode_image expects to be told.
DECLARED = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
            ".webp": "image/webp"}
# .gif is absent on purpose: animations are passed through untouched, so there is nothing
# to gain and a frame count to risk.


def _is_ours(url: str) -> bool:
    """Whether this app stored the object, and can therefore replace it."""
    if not isinstance(url, str) or not url:
        return False
    if storage.is_local():
        return url.startswith("/uploads/")
    return storage.BLOB_HOST_SUFFIX in url


def _ext_of(url: str) -> str:
    return os.path.splitext(url.split("?", 1)[0])[1].lower()


def _walk_strings(node, found):
    """Every string anywhere in a document, however deeply nested."""
    if isinstance(node, str):
        found.add(node)
    elif isinstance(node, dict):
        for value in node.values():
            _walk_strings(value, found)
    elif isinstance(node, list):
        for value in node:
            _walk_strings(value, found)


def _rewrite(node, mapping):
    """The same structure with every mapped string replaced. Returns (new, changed)."""
    if isinstance(node, str):
        return (mapping.get(node, node), node in mapping)
    if isinstance(node, dict):
        out, changed = {}, False
        for key, value in node.items():
            out[key], hit = _rewrite(value, mapping)
            changed = changed or hit
        return out, changed
    if isinstance(node, list):
        out, changed = [], False
        for value in node:
            new, hit = _rewrite(value, mapping)
            out.append(new)
            changed = changed or hit
        return out, changed
    return node, False


async def _fetch(url: str) -> bytes:
    if storage.is_local():
        return (storage.UPLOAD_DIR / url.split("/uploads/", 1)[1]).read_bytes()
    async with httpx.AsyncClient(timeout=60) as client:
        r = await client.get(url)
        r.raise_for_status()
        return r.content


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true",
                    help="write the new objects and rewrite the documents")
    ap.add_argument("--min-saving", type=int, default=10_000,
                    help="skip anything that saves fewer bytes than this (default 10000)")
    args = ap.parse_args()

    db = server.db

    # 1. Collect every candidate URL, and remember nothing about where it came from —
    #    the rewrite below is a value substitution, so one pass over the documents at the
    #    end covers every reference including duplicates across collections.
    urls = set()
    for name in COLLECTIONS:
        async for doc in db[name].find({}, {"_id": 0}):
            _walk_strings(doc, urls)
    candidates = sorted(u for u in urls if _is_ours(u) and _ext_of(u) in DECLARED)

    print(f"{len(candidates)} stored image(s) to consider "
          f"({'blob' if not storage.is_local() else 'local disk'})\n")
    if not candidates:
        return 0

    mapping, before_total, after_total, failures = {}, 0, 0, []
    print(f"{'image':52} {'before':>10} {'after':>10} {'saved':>7}")
    for url in candidates:
        try:
            raw = await _fetch(url)
        except Exception as exc:              # noqa: BLE001 — a report, not a pipeline
            failures.append((url, f"fetch failed: {exc}"))
            continue
        try:
            new_bytes, content_type, ext = server._reencode_image(raw, DECLARED[_ext_of(url)])
        except Exception as exc:              # noqa: BLE001
            failures.append((url, f"re-encode failed: {exc}"))
            continue

        saving = len(raw) - len(new_bytes)
        if saving < args.min_saving:
            continue

        name = url.rsplit("/", 1)[-1].split("?", 1)[0]
        before_total += len(raw)
        after_total += len(new_bytes)
        dims = Image.open(io.BytesIO(new_bytes)).size
        print(f"{name[:52]:52} {len(raw):>10,} {len(new_bytes):>10,} "
              f"{100 * saving / len(raw):>6.1f}%  -> {dims[0]}x{dims[1]}{ext}")

        if args.apply:
            stored = os.path.splitext(name)[0] + ext
            # A distinct name, so the old object stays readable until someone decides to
            # remove it. `add_random_suffix` is off in storage.save, so this is stable.
            mapping[url] = await storage.save(f"r1_{stored}", new_bytes, content_type)

    print()
    if before_total:
        print(f"{'TOTAL':52} {before_total:>10,} {after_total:>10,} "
              f"{100 * (before_total - after_total) / before_total:>6.1f}%")
    else:
        print("nothing worth re-encoding at the current --min-saving")

    for url, why in failures:
        print(f"  ! {url.rsplit('/', 1)[-1]}: {why}")

    if not args.apply:
        print("\nDry run — nothing was written. Re-run with --apply to make these changes.")
        return 0

    # 2. One pass over the documents, replacing old URLs with new wherever they appear.
    rewritten = 0
    for name in COLLECTIONS:
        async for doc in db[name].find({}):
            doc_id = doc.pop("_id")
            new_doc, changed = _rewrite(doc, mapping)
            if changed:
                await db[name].replace_one({"_id": doc_id}, new_doc)
                rewritten += 1
    print(f"\nRewrote {rewritten} document(s) across {len(COLLECTIONS)} collections.")
    print("The previous objects were NOT deleted; remove them once this looks right.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
