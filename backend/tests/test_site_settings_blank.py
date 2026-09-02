"""
Clearing a field in the CMS clears it on the site.

It used to do nothing. An empty value was stripped out of the update before it reached the
database, so emptying the footer description or the wordmark left the box blank in the
editor, the status line saying saved, and the live site showing the old text. The comment
guarding it said blank meant "use the built-in", which was a third behaviour it also did
not have — what it actually did was discard the edit.

The trade is deliberate: a wordmark can now be emptied, and an empty one leaves a blank
corner in the footer. That is the editor's call to make. Silently refusing it was not.

The other half of this is that a field the caller did not send must still be left alone.
Every string on the model defaults to "", so "blank means blank" and "absent means absent"
are one keystroke apart — `model_fields_set` is what keeps them separate, and the partial
test below is what stops that being quietly lost.
"""
import pytest
import requests

from support import API, TIMEOUT

# The SAME group as test_cms_footer, not one of its own. Site settings are a single
# document with a fixed _id, so two workers editing it are editing the same row: run
# apart, these files clobber each other and fail on whichever write landed second. The
# first version of this file had its own group and did exactly that, intermittently.
pytestmark = [pytest.mark.integration, pytest.mark.xdist_group("cms_footer")]

FULL = "Interdisciplinary platform producing events outside club night or art show."


def _get(headers):
    body = requests.get(f"{API}/admin/cms/site", headers=headers, timeout=TIMEOUT).json()
    body.pop("pages", None)
    return body


def _put(headers, **patch):
    """A whole-object write, which is what the editor sends."""
    r = requests.put(f"{API}/admin/cms/site", json={**_get(headers), **patch},
                     headers=headers, timeout=TIMEOUT)
    assert r.status_code == 200, r.text
    return r.json()


def _public():
    return requests.get(f"{API}/cms/site", timeout=TIMEOUT).json()


@pytest.fixture
def restore(admin_headers):
    """Put the footer copy back however the test leaves it."""
    before = _get(admin_headers)
    yield
    requests.put(f"{API}/admin/cms/site", json=before, headers=admin_headers, timeout=TIMEOUT)


class TestClearingActuallyClears:
    def test_the_description_can_be_emptied(self, admin_headers, restore):
        _put(admin_headers, description=FULL)
        assert _public()["description"] == FULL

        _put(admin_headers, description="")
        assert _public()["description"] == "", "clearing the description was discarded"

    def test_the_wordmark_can_be_emptied(self, admin_headers, restore):
        _put(admin_headers, wordmark="Supersanity")
        assert _public()["wordmark"] == "Supersanity"

        _put(admin_headers, wordmark="")
        assert _public()["wordmark"] == "", "clearing the wordmark was discarded"

    def test_whitespace_only_counts_as_empty(self, admin_headers, restore):
        # Otherwise a field looks cleared and is not, which is the original bug with an
        # extra step.
        _put(admin_headers, description=FULL)
        _put(admin_headers, description="   ")
        assert _public()["description"] == ""

    def test_a_changed_value_still_lands(self, admin_headers, restore):
        # The case that always worked. Worth holding: the fix is about "" and must not
        # disturb ordinary edits.
        _put(admin_headers, description="Something else entirely.")
        assert _public()["description"] == "Something else entirely."


class TestAbsentIsNotBlank:
    def test_a_partial_write_leaves_other_fields_alone(self, admin_headers, restore):
        """The trap this fix could easily have introduced.

        Every string on SiteSettingsIn defaults to "", so a body carrying one field would
        blank the other eight if the update were built from `model_dump()` alone.
        """
        _put(admin_headers, description=FULL, wordmark="Supersanity",
             contact_email="hello@example.test")

        r = requests.put(f"{API}/admin/cms/site", json={"description": "Only this one."},
                         headers=admin_headers, timeout=TIMEOUT)
        assert r.status_code == 200, r.text

        after = _public()
        assert after["description"] == "Only this one."
        assert after["wordmark"] == "Supersanity", "an unsent field was blanked"
        assert after["contact_email"] == "hello@example.test", "an unsent field was blanked"

    def test_it_needs_an_editor(self):
        r = requests.put(f"{API}/admin/cms/site", json={"description": "x"}, timeout=TIMEOUT)
        assert r.status_code in (401, 403), r.text
