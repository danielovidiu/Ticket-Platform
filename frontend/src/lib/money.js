/**
 * How an amount of money is written on screen.
 *
 * The rule is "no trailing .00", not "no decimals". A price of 100 reads as "100"; a
 * price of 99.50 still reads as "99.50" rather than being rounded into something the
 * buyer is not being charged. Dropping the decimals from a fractional amount would make
 * the page disagree with the card statement, which is a worse problem than an ugly zero.
 *
 * Deliberately NOT used for the invoice PDF or the CSV export. An invoice is a fiscal
 * document and a CSV is fed to a spreadsheet; both want one fixed, unambiguous shape, and
 * the invoice's net and VAT lines have to be two decimals regardless — 100 gross at 21%
 * is 82.64 + 17.36, and rounding either makes them stop summing to the total.
 *
 * Amounts are gross RON throughout, as Romanian retail quotes them.
 */

/** `100` -> "100", `99.5` -> "99.50", `99.567` -> "99.57", junk -> "0". */
export function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  // Round first, then ask whether the ROUNDED value is whole: 99.999 is not a whole
  // number but 100.00 is what a buyer would be charged, so "100" is the honest answer.
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

/** The same, carrying its unit. */
export const ron = (value) => `${money(value)} RON`;
