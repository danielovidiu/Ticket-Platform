/**
 * What a ticket tier means to a buyer: how many tickets one purchase is, how many of
 * those purchases they may make, and whether the event is offering any of them.
 *
 * These live here rather than inside EventDetail because each is a rule with a wrong
 * answer that costs money — a pack counted as one person breaks the per-user cap, and a
 * paused tier read as a sell-out tells a buyer to stop coming back. The server enforces
 * all three independently; this is what the page shows while it does.
 *
 * Mirrors WAVE_STATUSES and wave_pack_size in backend/server.py.
 */

/** Tickets issued by one purchase of this tier. 1 for an ordinary tier, and for any tier
 *  written before packs existed. A group tier's `price_ron` is the price of all of them
 *  together, never of one. */
export function packSizeOf(wave) {
  const n = Number(wave?.pack_size);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/** What one ticket in this tier costs, which is the number a refund is settled on.
 *  Derived, never entered: the promoter types what the pack sells for. */
export function perTicketPrice(wave) {
  return Number(wave?.price_ron || 0) / packSizeOf(wave);
}

/** The quantities a buyer may pick, counted in PACKS.
 *
 * `max_tickets_per_user` is a headcount, so a pack spends its whole size against it: a
 * four-pack under a cap of four is one pack, and offering a second would only be refused
 * at checkout. Always offers at least one — a cap below a single pack is a misconfigured
 * event, and the honest place to say so is the server's refusal, not an empty dropdown
 * the buyer cannot act on.
 */
export function packOptions(maxPerUser, packSize, most = 4) {
  const cap = Number(maxPerUser) || 4;
  const size = Math.max(1, Number(packSize) || 1);
  const allowed = Math.max(1, Math.floor(cap / size));
  return Array.from({ length: most }, (_, i) => i + 1).filter((n) => n <= allowed);
}

/**
 * Whether the event is selling, and if not, which kind of not.
 *
 * The two are different news and only one of them is final. A sell-out means the stock is
 * gone and the promoter gets to word it. A pause means the tickets still exist and the
 * tier is coming back, so borrowing the sold-out message for it would be untrue — and
 * would tell someone who would have bought to stop checking.
 *
 * Paused tiers are excluded from the sell-out test rather than counted as unavailable,
 * which is what would otherwise make every paused event claim to be sold out.
 */
export function saleState(waves) {
  const tiers = waves || [];
  if (!tiers.length) return "none";
  if (tiers.every((w) => w.status === "paused")) return "paused";
  const sellable = tiers.filter((w) => w.status !== "paused");
  if (sellable.every((w) => !w.is_active || (w.available ?? 0) <= 0)) return "sold_out";
  return "open";
}
