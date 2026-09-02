import {
  siFacebook, siInstagram, siSoundcloud, siSpotify, siTiktok, siX, siYoutube,
} from "simple-icons";

/** A-Z by label. One list drives the fields in the artist form AND the buttons on the
 *  public artist page, so the order here is the order in both. */
export const SOCIAL_PLATFORMS = [
  { key: "facebook", label: "Facebook" },
  { key: "instagram", label: "Instagram" },
  { key: "soundcloud", label: "SoundCloud" },
  { key: "spotify", label: "Spotify" },
  { key: "tiktok", label: "TikTok" },
  { key: "twitter", label: "Twitter / X" },
  { key: "website", label: "Website" },
  { key: "youtube", label: "YouTube" },
];

/**
 * The official brand marks, from simple-icons.
 *
 * Not from Lucide, which is what the rest of the app draws with: it has no SoundCloud,
 * Spotify or TikTok mark at all, and its `twitter` is still the old bird. A footer row
 * mixing four real logos with three text fallbacks and one wrong one is worse than
 * either a full set or no icons, and SoundCloud is the platform this site is most likely
 * to link to.
 *
 * `website` is deliberately absent: it is not a brand, it is whatever the artist's own
 * domain happens to be, so it falls back to the label. `twitter` maps to X because that
 * is the current mark for the field, while the KEY stays `twitter` — renaming it would
 * orphan every link already stored under it.
 *
 * Each entry is a 24×24 path string. Brand marks remain the property of their owners and
 * are used here only to link to those services, which is what their brand guidelines are
 * for.
 */
const MARKS = {
  facebook: siFacebook,
  instagram: siInstagram,
  soundcloud: siSoundcloud,
  spotify: siSpotify,
  tiktok: siTiktok,
  twitter: siX,
  youtube: siYoutube,
};

/** The 24×24 path for a platform, or null when it has no brand mark. */
export function socialIconPath(key) {
  return MARKS[key]?.path ?? null;
}
