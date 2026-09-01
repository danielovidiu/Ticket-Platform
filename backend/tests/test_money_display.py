"""
How an amount is written, and where the rule deliberately does not reach.

The rule is "no trailing .00", not "no decimals": a price of 100 reads as "100", and a
price of 99.50 still reads as "99.50" rather than being rounded into one the buyer is not
being charged. It applies to what a person reads on a page or in an email.

It stops at the fiscal documents. An invoice's net and VAT lines cannot be whole numbers
and stay correct — 100 gross at 21% is 82.64 + 17.36 — so the invoice keeps one fixed
shape, and the CSV keeps one because a spreadsheet column that is sometimes "100" and
sometimes "99.50" is worse to parse than one that is always both.

The last class here is the one that matters most: the backend's rule and the frontend's
have to agree, or a buyer comparing an order email against the page they bought from
finds two different numbers for the same money.
"""
import pathlib
import re

import pytest

import mailer

pytestmark = pytest.mark.xdist_group("money_display")

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
MONEY_JS = ROOT / "frontend" / "src" / "lib" / "money.js"
SERVER_PY = ROOT / "backend" / "server.py"


class TestTheDisplayRule:
    @pytest.mark.parametrize("value,expected", [
        (100, "100"), (100.0, "100"), (149, "149"), (0, "0"), (1000, "1000"),
    ])
    def test_whole_amounts_lose_the_decimals(self, value, expected):
        assert mailer._money(value) == expected

    @pytest.mark.parametrize("value,expected", [
        (99.5, "99.50"), (82.64, "82.64"), (17.36, "17.36"), (1234.5, "1234.50"),
    ])
    def test_fractional_amounts_keep_them(self, value, expected):
        assert mailer._money(value) == expected

    def test_a_price_is_never_rounded_into_one_nobody_is_charged(self):
        assert mailer._money(99.5) not in ("100", "99")

    def test_rounding_up_to_whole_gives_whole(self):
        # 99.999 is not a whole number; 100.00 is what would be charged.
        assert mailer._money(99.999) == "100"

    def test_nothing_at_all_is_zero(self):
        for bad in (None, "", "abc", [], {}):
            assert mailer._money(bad) == "0"

    def test_negatives_keep_their_sign(self):
        assert mailer._money(-10) == "-10"
        assert mailer._money(-10.5) == "-10.50"


class TestTheTwoSidesAgree:
    """A buyer comparing an order email against the page they bought from must not find
    two different numbers. Neither runtime can import the other's function, so the shared
    table is asserted against both — the JS half in `money.test.js`, this half here."""

    SHARED = [(100, "100"), (100.0, "100"), (99.5, "99.50"), (99.567, "99.57"),
              (0, "0"), (-10, "-10"), (1234.5, "1234.50"), (82.64, "82.64")]

    @pytest.mark.parametrize("value,expected", SHARED)
    def test_the_python_side_matches_the_shared_table(self, value, expected):
        assert mailer._money(value) == expected

    def test_the_javascript_side_uses_the_same_two_rules(self):
        """Read as text, not evaluated: round to two, then print whole if it is whole."""
        src = MONEY_JS.read_text()
        assert "Math.round(n * 100) / 100" in src, "the JS rounds to two decimals first"
        assert "Number.isInteger(rounded)" in src, "the JS asks whether the ROUNDED value is whole"
        assert "toFixed(2)" in src, "the JS falls back to two decimals"


class TestTheFiscalDocumentsAreUnchanged:
    """These are the ones the rule must NOT reach. Asserted against the source, the way
    test_embed_allowlist asserts two files agree, because the alternative is rendering a
    PDF in a test to find out that somebody made an invoice ambiguous."""

    def test_the_invoice_pdf_still_prints_two_decimals(self):
        src = SERVER_PY.read_text()
        for field in ("inv['net']", "inv['vat_amount']", "inv['total']"):
            assert f"{{{field}:.2f}}" in src, f"the invoice stopped fixing {field} at two decimals"

    def test_the_csv_export_still_prints_two_decimals(self):
        src = SERVER_PY.read_text()
        assert "float(t.get('price_ron') or 0):.2f" in src, \
            "the ticket CSV stopped fixing its price column at two decimals"

    def test_the_vat_split_still_sums_to_the_total(self):
        """The arithmetic reason the invoice cannot follow the display rule."""
        total, rate = 100.0, 0.21
        net = round(total / (1 + rate), 2)
        vat = round(total - net, 2)
        assert (net, vat) == (82.64, 17.36)
        assert round(net + vat, 2) == total
        assert not float(net).is_integer() and not float(vat).is_integer()
