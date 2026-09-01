/**
 * How an amount is written on screen.
 *
 * The rule is "no trailing .00", NOT "no decimals". Rounding a fractional price to a whole
 * number would make the page disagree with the card statement, which is a worse problem
 * than an ugly pair of zeroes.
 */
import { money, ron } from "./money";

describe("whole amounts lose the decimals", () => {
  test.each([[100, "100"], [100.0, "100"], [149, "149"], [0, "0"], [1000, "1000"]])(
    "%p renders as %p", (input, expected) => {
      expect(money(input)).toBe(expected);
    });
});

describe("fractional amounts keep them", () => {
  test.each([[99.5, "99.50"], [82.64, "82.64"], [17.36, "17.36"], [1234.5, "1234.50"]])(
    "%p renders as %p", (input, expected) => {
      expect(money(input)).toBe(expected);
    });

  test("a price is never rounded into one the buyer is not charged", () => {
    // The failure this guards: 99.50 shown as "100" or "99".
    expect(money(99.5)).not.toBe("100");
    expect(money(99.5)).not.toBe("99");
  });
});

describe("edges", () => {
  test("more than two decimals round to two", () => {
    expect(money(99.567)).toBe("99.57");
    expect(money(99.994)).toBe("99.99");
  });

  test("rounding UP to a whole number gives a whole number", () => {
    // 99.999 is not whole, but 100.00 is what would be charged.
    expect(money(99.999)).toBe("100");
  });

  test("negatives keep their sign", () => {
    expect(money(-10)).toBe("-10");
    expect(money(-10.5)).toBe("-10.50");
  });

  test("nothing at all is zero, not NaN", () => {
    for (const bad of [null, undefined, "", "abc", NaN, Infinity]) {
      expect(money(bad)).toBe("0");
    }
  });

  test("float noise does not leak through", () => {
    expect(money(0.1 + 0.2)).toBe("0.30");
  });
});

describe("ron", () => {
  test("carries the unit", () => {
    expect(ron(100)).toBe("100 RON");
    expect(ron(99.5)).toBe("99.50 RON");
  });
});
