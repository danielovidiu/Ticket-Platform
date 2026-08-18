"""
Server-side HTML sanitization for CMS-authored content (audit M10).

The custom-HTML block was sanitized in exactly one place: the React component that
renders it, via DOMPurify. That is the wrong and only place. What it means in practice:

  * the raw string is what lives in MongoDB, so the database stores live payloads;
  * every *other* consumer gets it unsanitized — an email template, an SSR pass, a
    direct read of `GET /api/cms/pages`, a future mobile client, an export;
  * and the guarantee rests on a client-side library, which is to say on a version of a
    library the visitor's browser happens to run. That is not theoretical: the DOMPurify
    pinned here was on 3.4.12, which has a published bypass.

So HTML is cleaned on the way *in*. The client-side pass stays — defence in depth, and it
still covers anything already stored — but it is no longer the only thing standing between
an editor and a stored XSS.

`nh3` (Rust `ammonia`) rather than `bleach`: bleach is archived and its `html5lib` parser
diverges from what browsers actually do, which is precisely where mXSS lives. nh3 parses
with the same html5ever engine Servo uses, and it is allowlist-based, so a tag nobody
thought about is dropped rather than passed.
"""
from typing import Any

import nh3

# nh3's default allowlist is already free of every dangerous tag — no script, iframe,
# object, embed, form, style, svg or math (verified, not assumed). It is kept as the base
# rather than hand-rolled: a hand-written list is a list somebody forgets to update.
#
# Deliberately NOT added:
#   * `svg`   — the client passed `USE_PROFILES: {svg: true}`, which widens the mXSS
#               surface for a capability no block in the set uses.
#   * `iframe`— video embeds are their own block type with a URL prop, not free HTML.
#               Allowing them here would reintroduce audit M11 through the side door.
ALLOWED_TAGS = set(nh3.ALLOWED_TAGS)

# Only these URL schemes survive on href/src. `javascript:` and `data:` are both absent:
# the first is the classic vector, the second lets an attacker inline a whole document.
ALLOWED_SCHEMES = {"http", "https", "mailto", "tel"}


def clean_html(value: str) -> str:
    """Sanitize one HTML fragment. Returns "" for anything that is not a string."""
    if not isinstance(value, str) or not value:
        return ""
    return nh3.clean(value, tags=ALLOWED_TAGS, url_schemes=ALLOWED_SCHEMES)


def sanitize_blocks(blocks: Any) -> Any:
    """Return `blocks` with every HTML-bearing prop cleaned.

    Keyed on the prop *name* (`html`) rather than on the block `type`, so a new block
    that renders HTML is covered the day it is added rather than the day someone
    remembers to extend a list here. The only HTML sink in the frontend is
    `props.html` on the custom-HTML block; this stays correct if a second one appears.

    Non-destructive about shape: anything that is not a list of dicts is passed through
    untouched, because rejecting it is the caller's job and Pydantic's, not the
    sanitizer's.
    """
    if not isinstance(blocks, list):
        return blocks
    out = []
    for block in blocks:
        if not isinstance(block, dict):
            out.append(block)
            continue
        props = block.get("props")
        if isinstance(props, dict) and isinstance(props.get("html"), str):
            block = {**block, "props": {**props, "html": clean_html(props["html"])}}
        out.append(block)
    return out


def sanitize_draft(draft: Any) -> Any:
    """`{"blocks": [...]}` in, same shape out, HTML cleaned."""
    if not isinstance(draft, dict):
        return draft
    if "blocks" not in draft:
        return draft
    return {**draft, "blocks": sanitize_blocks(draft["blocks"])}
