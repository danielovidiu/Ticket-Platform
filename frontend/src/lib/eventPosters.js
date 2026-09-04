/**
 * The artwork for one event, main piece first.
 *
 * An event carries two separate collections of pictures and they answer different
 * questions. `images` is the POSTER collection — the artwork that sells the night, with
 * `image_url` naming the one that stands for it everywhere else. The albums linked to the
 * event are the other collection, a record of the night itself, and are not this.
 *
 * The main artwork leads because it is the picture a visitor has already seen, on the card
 * that brought them here; opening the event on a different one reads as the wrong event.
 *
 * Every event predating the collection carries an `image_url` and no `images`, and reads
 * here as a one-poster event — which is exactly what it is. Nothing has to be migrated.
 */
export function eventPosters(event) {
  const main = (event?.image_url || "").trim();
  const rest = Array.isArray(event?.images) ? event.images : [];
  const seen = new Set();
  const out = [];
  for (const url of [main, ...rest]) {
    const u = (url || "").trim();
    // De-duplicated because the main artwork is normally also a member of the collection,
    // and a carousel that shows it twice looks like a bug in the carousel.
    if (u && !seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}
