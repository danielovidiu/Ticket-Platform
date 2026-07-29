"""
Pure-function tests for the account and gallery rules.

These import server.py directly instead of going over HTTP, because the interesting
cases here are per-field ones — a dozen phone formats, a dozen slugs — and driving them
through POST /auth/register would exhaust its 5-per-5-minutes rate limit long before the
last case ran. The HTTP contract those rules add up to is covered in
test_account_and_gallery.py.

Run: venv/bin/python -m pytest tests/test_profile_rules.py -q
"""
import pytest


@pytest.fixture(scope="module")
def srv():
    """The server module itself.

    Imported as-is: server.py calls load_dotenv(backend/.env) at import time, so it
    configures itself from the same file the running server uses. Nothing here touches
    the database — deliberately NOT setting MONGO_URL/DB_NAME in os.environ, because
    subprocess-based tests elsewhere in the suite inherit this process's environment
    and would then read a different database than the one they wrote to.
    """
    import server
    return server


class TestPhoneNormalization:
    @pytest.mark.parametrize("typed,stored", [
        ("+40 721 234 567", "+40721234567"),
        ("0721-234-567", "0721234567"),
        ("(0721) 234.567", "0721234567"),
        ("  +40721234567  ", "+40721234567"),
    ])
    def test_separators_are_stripped(self, srv, typed, stored):
        assert srv._normalize_phone(typed) == stored

    @pytest.mark.parametrize("bad", [
        "", "   ", "not-a-number", "12345",            # too short to be a phone number
        "+4072123456789012345",                        # too long
        "+40 721 234 567 ext 12",                      # letters survive the strip
        "++40721234567",
        None,
    ])
    def test_implausible_input_is_rejected(self, srv, bad):
        """Returns "" rather than raising, so every caller can treat falsy as invalid."""
        assert srv._normalize_phone(bad) == ""


class TestNameParts:
    @pytest.mark.parametrize("name,expected", [
        ("Ana Popescu", ("Ana", "Popescu")),
        ("Ana Maria Popescu", ("Ana", "Maria Popescu")),
        ("Cher", ("Cher", "")),
        ("  ", ("", "")),
        (None, ("", "")),
    ])
    def test_legacy_name_splits(self, srv, name, expected):
        """Everything after the first token is the surname — losing a middle name is
        worse than attaching it to the surname."""
        assert srv._split_name(name) == expected

    def test_full_name_skips_missing_parts(self, srv):
        assert srv._full_name("Ana", "Popescu") == "Ana Popescu"
        assert srv._full_name("Ana", "") == "Ana"
        assert srv._full_name("", "") == ""

    @pytest.mark.parametrize("user,complete", [
        ({"first_name": "Ana", "last_name": "Popescu", "phone": "+40721234567"}, True),
        # Phone is optional by default (REQUIRE_PHONE off), name and surname never are.
        ({"first_name": "Ana", "last_name": "Popescu", "phone": ""}, True),
        ({"first_name": "Ana", "last_name": "  ", "phone": "+40721234567"}, False),
        ({"name": "Ana Popescu", "phone": "+40721234567"}, False),  # legacy, unsplit
        ({}, False),
        (None, False),
    ])
    def test_profile_completeness(self, srv, user, complete):
        assert srv._profile_complete(user) is complete


class TestRequirePhoneFlag:
    """REQUIRE_PHONE decides whether a BLANK phone is allowed. It never decides whether
    a number someone typed has to be plausible — that is always checked."""

    @pytest.fixture()
    def required(self, srv, monkeypatch):
        # Read at call time, so patching the module global is enough to flip the rule.
        monkeypatch.setattr(srv, "REQUIRE_PHONE", True)
        return srv

    def test_off_by_default(self, srv):
        assert srv.REQUIRE_PHONE is False, "the phone must ship optional; opt in with REQUIRE_PHONE=1"

    def test_phoneless_account_is_complete_when_off(self, srv):
        assert srv._profile_complete({"first_name": "Ana", "last_name": "Popescu", "phone": ""}) is True

    def test_phoneless_account_is_incomplete_when_on(self, required):
        assert required._profile_complete({"first_name": "Ana", "last_name": "Popescu", "phone": ""}) is False

    def test_blank_is_accepted_when_off(self, srv):
        assert srv._validate_phone("") == ""
        assert srv._validate_phone(None) == ""

    def test_blank_is_rejected_when_on(self, required):
        from fastapi import HTTPException
        with pytest.raises(HTTPException) as e:
            required._validate_phone("")
        assert e.value.status_code == 400

    @pytest.mark.parametrize("flag", [False, True])
    def test_a_typed_number_is_validated_either_way(self, srv, monkeypatch, flag):
        from fastapi import HTTPException
        monkeypatch.setattr(srv, "REQUIRE_PHONE", flag)
        assert srv._validate_phone("+40 721 234 567") == "+40721234567"
        with pytest.raises(HTTPException):
            srv._validate_phone("not-a-number")


class TestIdentityNameUpdates:
    """What an OAuth callback is allowed to overwrite on an existing account."""

    def test_blanks_are_filled_from_the_provider(self, srv):
        upd = srv._identity_name_updates({"first_name": "", "last_name": "", "name": ""}, "Ana", "Popescu")
        assert upd == {"first_name": "Ana", "last_name": "Popescu", "name": "Ana Popescu"}

    def test_what_the_user_typed_is_never_overwritten(self, srv):
        existing = {"first_name": "Ana-Maria", "last_name": "Popescu", "name": "Ana-Maria Popescu"}
        assert srv._identity_name_updates(existing, "Ana", "Popescu") == {}


class TestSlugify:
    @pytest.mark.parametrize("typed,slug", [
        ("Live Documentation", "live-documentation"),
        ("  Gallery!  ", "gallery"),
        ("2024 // Archive", "2024-archive"),
        ("already-a-slug", "already-a-slug"),
        ("", ""),
        ("---", ""),
    ])
    def test_editor_input_becomes_a_url(self, srv, typed, slug):
        assert srv._slugify(typed) == slug
        if slug:
            assert srv._SLUG_RE.match(slug), "slugify produced something the API would reject"


class TestMediaUrlValidation:
    @pytest.mark.parametrize("url", [
        "https://images.example.com/a.jpg",
        "http://example.com/a.mp4",
        "/uploads/abc123.jpg",   # our own local-storage path
    ])
    def test_accepted(self, srv, url):
        assert srv._valid_media_url(url) is True

    @pytest.mark.parametrize("url", [
        "javascript:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "//evil.example.com/a.jpg",   # protocol-relative: inherits the page's scheme
        "ftp://example.com/a.jpg",
        "", None,
    ])
    def test_refused(self, srv, url):
        assert srv._valid_media_url(url) is False
