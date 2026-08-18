"""
The base every request model inherits, and the length budget it carries (audit M9).

The audit found **no Pydantic model in the codebase set `max_length`** — 88 of 90 string
fields were unbounded, so a single request could store an arbitrarily large document.
MongoDB's 16 MB ceiling is not a control; it is where the failure changes shape.

Setting a bound on 88 fields by hand is 88 chances to miss one, and it would only cover
the fields that exist today. `str_max_length` on the model config applies to every string
field a model has, including the ones nobody has written yet — which is the property worth
having. A per-field `Field(max_length=…)` still overrides it *upward* where a field
genuinely needs the room, so the default can be strict without being in the way.

These are ceilings, not validation. The longest string in the live database is 1491
characters and the largest CMS page is 3.6 KB; the point is to make "arbitrarily large"
impossible, not to tell an editor how to write. Tightening individual fields to something
meaningful is a separate, smaller job.
"""
from pydantic import BaseModel, ConfigDict

# Comfortable for a name, a slug, a URL, a token, a short message. Anything that needs
# more says so explicitly with Field(max_length=LONG_TEXT).
DEFAULT_STR_MAX = 4_000

# Descriptions, bios, notice bodies — prose a human typed. Five times the longest thing
# anyone has stored so far.
LONG_TEXT = 20_000

# Whole-document ceiling for the untyped `dict` payloads that `str_max_length` cannot
# reach: CMS drafts and the theme, which are free-form block trees rather than typed
# fields. Measured against the largest real page, which is 3.6 KB.
MAX_JSON_DOC_BYTES = 256 * 1024


class ApiModel(BaseModel):
    """Every request body model inherits this rather than `BaseModel` directly.

    `backend/tests/test_input_bounds.py` walks the request models reachable from the live
    route table and fails on any string field without a bound, so a model that goes back
    to plain `BaseModel` is caught rather than quietly unbounded.
    """
    model_config = ConfigDict(str_max_length=DEFAULT_STR_MAX)
