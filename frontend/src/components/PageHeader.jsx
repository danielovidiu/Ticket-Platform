/**
 * The two lines at the top of a built-in section page: an eyebrow and the page's name.
 *
 * Both are CMS content (GET /cms/core-pages), which means either can be emptied — so
 * neither may reserve space it is not using. That is the whole reason this is a
 * component rather than four copies of the same JSX: the pages used to hang the gap off
 * the element below it (`<h1 className="mt-2">`), and an emptied eyebrow left its margin
 * behind. The gaps live on the containers here, so a deleted line takes its space with
 * it and what remains moves up.
 *
 * `aside` is the slot Events and Artists put their tab bars in. It sits on the heading's
 * row and survives the heading being deleted — the filter is the page's own control, not
 * part of the wording an editor is choosing.
 */
export default function PageHeader({
  header,
  headingClass = "font-display text-5xl md:text-7xl uppercase font-black tracking-tighter",
  headingTestId,
  eyebrowTestId,
  aside = null,
}) {
  // Null until the fetch lands. Rendering the built-in wording in the meantime would
  // show "Programme" to a site that deleted it and then snatch it away, which is the
  // same flash the Events tab bar already refuses to do with its own settings.
  // The tab bars go with it: showing a filter bar alone, right-aligned against nothing,
  // is a worse frame of the same moment.
  if (!header) return null;

  const eyebrow = (header.eyebrow || "").trim();
  const heading = (header.heading || "").trim();
  if (!eyebrow && !heading && !aside) return null;

  return (
    <div className="space-y-3" data-testid="page-header">
      {eyebrow && (
        <div className="font-mono-x text-xs uppercase tracking-[0.3em] text-ink-4" data-testid={eyebrowTestId}>
          {eyebrow}
        </div>
      )}
      {(heading || aside) && (
        <div className="flex flex-wrap items-end justify-between gap-6">
          {heading && <h1 className={headingClass} data-testid={headingTestId}>{heading}</h1>}
          {aside}
        </div>
      )}
    </div>
  );
}
