"""
Media storage for uploaded gallery / artist / event assets.

Two backends, selected by whether a Vercel Blob token is present:

  BLOB_READ_WRITE_TOKEN set   -> "blob"  — objects live in Vercel Blob, served from
                                          its CDN, and `save()` returns an absolute
                                          https URL.
  unset                       -> "local" — objects are written to ./uploads and
                                          `save()` returns a root-relative
                                          "/uploads/<name>" path, exactly as this app
                                          behaved before.

The split exists because a Vercel Function's filesystem is read-only outside /tmp and
its instances are ephemeral: anything written during a request is gone by the next cold
start, and never visible to the other instances serving traffic concurrently. Local disk
is still the right default for `uvicorn --reload` on a laptop, where a fresh checkout
must work with no external credentials.

Callers should treat the returned string as opaque and store it as-is. The frontend's
`mediaUrl()` already passes absolute URLs through untouched and prefixes relative ones,
so both shapes render without a client-side change.
"""
import os
import logging
from pathlib import Path
from typing import Optional

logger = logging.getLogger("supersanity.storage")

ROOT_DIR = Path(__file__).parent
UPLOAD_DIR = ROOT_DIR / "uploads"

BLOB_TOKEN = os.environ.get("BLOB_READ_WRITE_TOKEN", "").strip()
BACKEND = "blob" if BLOB_TOKEN else "local"

# Objects are namespaced so the store stays legible next to anything else the project
# puts in the same Blob store later.
BLOB_PREFIX = "uploads"

# Uploaded names are server-generated UUIDs and their content is immutable, so they can
# be cached indefinitely. One year is the conventional ceiling.
BLOB_CACHE_MAX_AGE = 31_536_000

# Only URLs under this host were written by us. `delete()` refuses to forward anything
# else to the Blob API — the seeded gallery rows point at Unsplash, and asking Vercel to
# delete a third-party URL is at best a wasted round trip.
BLOB_HOST_SUFFIX = ".blob.vercel-storage.com"


def is_local() -> bool:
    """True when uploads are served off local disk and /uploads must be mounted."""
    return BACKEND == "local"


def ensure_local_dir() -> Optional[Path]:
    """Create and return the local upload directory, or None on the blob backend.

    Never called under "blob", which matters: the module-level `mkdir()` this replaces
    ran at import time and would abort a Vercel cold start outright, because the bundle's
    filesystem is read-only.
    """
    if not is_local():
        return None
    UPLOAD_DIR.mkdir(exist_ok=True)
    return UPLOAD_DIR


async def save(name: str, data: bytes, content_type: str) -> str:
    """Store `data` under `name` and return the URL to serve it from.

    `name` is expected to be a server-generated filename (UUID + extension). It is never
    derived from user input — see the note on stored XSS in the /admin/uploads handler.
    """
    if is_local():
        ensure_local_dir()
        (UPLOAD_DIR / name).write_bytes(data)
        return f"/uploads/{name}"

    from vercel import blob

    result = await blob.put_async(
        f"{BLOB_PREFIX}/{name}",
        data,
        access="public",
        content_type=content_type,
        cache_control_max_age=BLOB_CACHE_MAX_AGE,
        token=BLOB_TOKEN,
        # Names are already unique; a random suffix would only make them unpredictable
        # to us, and `overwrite` stays off so a UUID collision fails loudly.
        add_random_suffix=False,
    )
    return result.url


async def delete(url: Optional[str]) -> None:
    """Remove an object this app stored. Anything else is ignored, not raised.

    Deletion is best-effort on purpose: it is only ever called after the database row is
    already gone, and failing the request because the bytes outlived their record would
    turn a leaked object into a user-visible error.
    """
    if not url:
        return

    if is_local():
        # Only ever touches names directly inside UPLOAD_DIR. Remote URLs (seeded
        # Unsplash items) and any path trying to climb out of the directory are ignored.
        if not url.startswith("/uploads/"):
            return
        name = url.split("/uploads/", 1)[1]
        if not name or "/" in name or "\\" in name or name.startswith("."):
            return
        target = (UPLOAD_DIR / name).resolve()
        if target.parent != UPLOAD_DIR.resolve() or not target.is_file():
            return
        try:
            target.unlink()
        except OSError:
            logger.exception("Could not delete upload %s", name)
        return

    if BLOB_HOST_SUFFIX not in url:
        return
    try:
        from vercel import blob

        await blob.delete_async(url, token=BLOB_TOKEN)
    except Exception:
        logger.exception("Could not delete blob %s", url)
