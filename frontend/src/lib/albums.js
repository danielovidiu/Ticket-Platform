/**
 * Facts about albums that more than one screen has to agree on.
 *
 * Only one so far, and it earns a module because of WHERE its two readers live: the
 * public album page and the CMS's album form. AlbumPage is imported eagerly and Admin is
 * a lazy chunk (see pages/backstage.js), so having one import the constant from the other
 * would drag a whole page module across that boundary — the admin bundle would carry the
 * public page, or the public bundle would carry the admin. A leaf module with no imports
 * of its own is free to both.
 */

/**
 * How much of an album's description shows before the reader asks for the rest.
 *
 * Longer than the artist bio's 200: a bio introduces a person in a line or two, where an
 * album description is the note that goes with a body of work.
 *
 * The public page measures the MARKS-STRIPPED length through `excerpt`, while the admin
 * counter measures what the editor has actually typed. They can disagree by a few
 * characters on text containing markdown syntax, and the admin one is the pessimistic
 * side of that — it will say something is behind "see more" slightly before it is, rather
 * than promising it fits and then collapsing it.
 */
export const ALBUM_INTRO_LIMIT = 400;
