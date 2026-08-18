"""
Every string a client can send has a ceiling (audit M9).

The audit found **no Pydantic model in the codebase set `max_length`** — measured at the
time of the fix, 88 of 90 string fields were unbounded, so one request could store an
arbitrarily large document. MongoDB's 16 MB limit is not a control; it is the point where
the failure changes shape from "a big row" to "a broken write".

Bounding 88 fields by hand would have been 88 chances to miss one, and would have covered
only the fields that existed that day. `ApiModel` sets `str_max_length` on the model
config instead, which applies to every string field a model has — including the ones
nobody has written yet.

**This test exists because that only holds while models keep inheriting it.** A new model
written against plain `BaseModel` is unbounded again and nothing else would say so. Rather
than list the models, it walks the ones reachable from the live route table — the same
derive-from-the-app approach as `test_rbac.py`, and for the same reason: a list you
maintain by hand is a list that goes stale. It also reaches the models defined inside
`register_shop_routes` and `register_cms_routes`, which a module-level scan misses
entirely.
"""
import typing

import pytest
from fastapi.routing import APIRoute
from pydantic import BaseModel

import server
from models_base import DEFAULT_STR_MAX, LONG_TEXT


pytestmark = pytest.mark.critical  # config-only; needs no server


def _unwrap(annotation):
    """Yield every concrete type inside Optional[...], List[...], Union[...] and so on."""
    seen = []
    stack = [annotation]
    while stack:
        current = stack.pop()
        if current is None:
            continue
        args = typing.get_args(current)
        if args:
            stack.extend(args)
        else:
            seen.append(current)
    return seen


def _request_models():
    """Every Pydantic model a client can post a body into, plus their nested models."""
    found, stack = {}, []
    for route in server.api.routes:
        if not isinstance(route, APIRoute) or route.body_field is None:
            continue
        stack.extend(_unwrap(route.body_field.field_info.annotation))

    while stack:
        candidate = stack.pop()
        if not (isinstance(candidate, type) and issubclass(candidate, BaseModel)):
            continue
        if candidate.__name__ in found:
            continue
        found[candidate.__name__] = candidate
        for field in candidate.model_fields.values():
            stack.extend(_unwrap(field.annotation))
    return found


MODELS = _request_models()

# A green tick against an empty list is the failure mode this whole file is guarding
# against, so the discovery itself is asserted.
assert len(MODELS) > 15, f"model discovery found only {len(MODELS)}: {sorted(MODELS)}"


def _string_fields(model):
    for name, field in model.model_fields.items():
        if str in _unwrap(field.annotation):
            yield name, field


def _declared_max(field):
    for meta in field.metadata:
        value = getattr(meta, "max_length", None)
        if value:
            return value
    return None


class TestEveryRequestStringIsBounded:

    @pytest.mark.parametrize("name", sorted(MODELS), ids=sorted(MODELS))
    def test_model_inherits_the_bounded_base(self, name):
        model = MODELS[name]
        configured = model.model_config.get("str_max_length")
        unbounded = [f for f, field in _string_fields(model) if _declared_max(field) is None]
        assert configured or not unbounded, (
            f"{name} has unbounded string fields {unbounded} and no str_max_length — it "
            "was probably written against BaseModel instead of ApiModel (models_base.py)"
        )

    @pytest.mark.parametrize("name", sorted(MODELS), ids=sorted(MODELS))
    def test_no_field_is_given_an_absurd_ceiling(self, name):
        """A per-field override raises the config limit, so a careless one is a hole."""
        for field_name, field in _string_fields(MODELS[name]):
            declared = _declared_max(field)
            if declared is not None:
                assert declared <= LONG_TEXT, (
                    f"{name}.{field_name} allows {declared} characters; the prose ceiling "
                    f"is {LONG_TEXT}"
                )


class TestTheCeilingsActuallyApply:
    """Config is easy to set and easy to have no effect. These construct models."""

    def test_the_default_bound_rejects_a_long_string(self):
        from pydantic import ValidationError
        with pytest.raises(ValidationError):
            server.ContactMsg(name="x" * (DEFAULT_STR_MAX + 1), email="a@b.test", message="hi")

    def test_a_prose_field_still_takes_more_than_the_default(self):
        """`message` is raised to LONG_TEXT explicitly; the override must win upward."""
        msg = server.ContactMsg(name="x", email="a@b.test", message="y" * (DEFAULT_STR_MAX + 1))
        assert len(msg.message) == DEFAULT_STR_MAX + 1

    def test_even_prose_has_a_ceiling(self):
        from pydantic import ValidationError
        with pytest.raises(ValidationError):
            server.ContactMsg(name="x", email="a@b.test", message="y" * (LONG_TEXT + 1))

    def test_an_optional_field_is_bounded_too(self):
        """`str_max_length` has to reach inside Optional[str], or half the patch models
        are unbounded while looking fine."""
        from pydantic import ValidationError
        with pytest.raises(ValidationError):
            server.EventPatchIn(venue="x" * (DEFAULT_STR_MAX + 1))
