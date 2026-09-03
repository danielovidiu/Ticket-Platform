import { useEffect, useState } from "react";

/** How much of the page's last stretch the footer fades across, in pixels. */
export const FADE_DISTANCE = 150;

/**
 * How visible the footer should be, from how far the page still has to go.
 *
 * Pure, and separated from the hook below, because the interesting part is arithmetic
 * with four edge cases and none of them need a browser to check:
 *
 *   - a page too short to scroll is ALREADY at its end, so the footer is solid from the
 *     first paint rather than never appearing at all;
 *   - overscroll — rubber-banding on iOS, a trackpad flick past the end — makes the
 *     remaining distance NEGATIVE, which without clamping computes an opacity above 1;
 *   - the fade is linear over the last `fade` pixels and flat elsewhere;
 *   - a `fade` of zero would divide by zero, and means "no fade", so it snaps.
 *
 * Everything is measured in pixels remaining to the bottom rather than as a fraction of
 * the page: the reveal should feel the same on a page of two screens and a page of forty.
 */
export function revealOpacity({ scrollY, innerHeight, scrollHeight, fade = FADE_DISTANCE }) {
  const remaining = scrollHeight - (scrollY + innerHeight);
  if (!Number.isFinite(remaining)) return 1;
  if (remaining <= 0) return 1;
  if (fade <= 0) return 0;
  if (remaining >= fade) return 0;
  return 1 - remaining / fade;
}

/** Read the three numbers off the document. Separated so tests can supply their own. */
function measure() {
  return {
    scrollY: window.scrollY,
    innerHeight: window.innerHeight,
    scrollHeight: document.documentElement.scrollHeight,
  };
}

/**
 * The footer's opacity, tracking the scroll position.
 *
 * Scroll fires far more often than a frame is drawn, so the listener does nothing but
 * ask for a frame — the measurement and the state write happen once per frame at most.
 * Without that, a fast flick queues hundreds of reads and layout thrashes.
 *
 * A ResizeObserver watches the document as well as the window. The page's height changes
 * without a scroll or a resize all the time — images arriving, a filter narrowing a grid,
 * an accordion opening — and each one moves the bottom of the page out from under a value
 * computed earlier. Without it the footer sticks at whatever it was when the page was a
 * different length.
 */
export function useFooterReveal() {
  const [opacity, setOpacity] = useState(() => {
    // Server-side and first paint: assume the end is reached, so a short page is not
    // briefly footerless while the first frame is scheduled.
    if (typeof window === "undefined") return 1;
    return revealOpacity(measure());
  });

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      setOpacity(revealOpacity(measure()));
    };
    const schedule = () => {
      // requestAnimationFrame does not fire while the document is hidden — a background
      // tab, or a window the compositor has stopped drawing. Rate-limiting to a frame
      // that never comes means the value freezes at whatever it was when the page was
      // last drawn, so returning to a tab whose content grew meanwhile finds a footer
      // that disagrees with the page. There is no frame to spare there either, so the
      // work is done straight away instead.
      if (document.hidden) { update(); return; }
      if (frame) return;
      frame = requestAnimationFrame(update);
    };

    schedule();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    // Coming back to the tab: resync before the first paint the viewer will see, rather
    // than waiting for them to scroll.
    document.addEventListener("visibilitychange", schedule);

    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(document.documentElement);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("visibilitychange", schedule);
      observer?.disconnect();
    };
  }, []);

  return opacity;
}
