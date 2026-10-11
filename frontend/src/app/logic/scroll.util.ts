/**
 * Page scroll position that puts an element `anchorRatio` of the way down the viewport
 * (0 = flush with the top, 0.3 = a third down), clamped to the scrollable range.
 */
export function followScrollTop(
  elementTop: number,
  scrollY: number,
  viewportHeight: number,
  documentHeight: number,
  anchorRatio: number,
): number {
  const target = elementTop + scrollY - viewportHeight * anchorRatio;
  const max = Math.max(0, documentHeight - viewportHeight);
  return Math.min(Math.max(0, target), max);
}

/**
 * Scrolls to elements once the page has stopped changing height. A distance that is opening, or cards that are just
 * arriving, make the page grow for a moment; scrolling before that is over aims at a page that is still too short.
 */
export class SettledScroller {
  /** Longest wait for the page to stop changing height before scrolling anyway. */
  private static readonly SETTLE_MAX_MS = 1000;
  /** How long the page height has to stay the same to count as settled. */
  private static readonly SETTLE_STABLE_MS = 150;
  /** A scroll shorter than this fraction of the viewport height is not worth making. */
  private static readonly DEAD_ZONE = 0.1;

  private run = 0;

  /** Scrolls the element matching `selector` into place; a newer call replaces one that is still waiting. */
  scrollTo(selector: string, anchorRatio: number): void {
    const run = ++this.run;
    const started = performance.now();
    let height = -1;
    let steadySince = started;
    const step = (now: number) => {
      if (run !== this.run) return;
      const current = document.documentElement.scrollHeight;
      if (current !== height) {
        height = current;
        steadySince = now;
      }
      if (now - steadySince < SettledScroller.SETTLE_STABLE_MS && now - started < SettledScroller.SETTLE_MAX_MS) {
        requestAnimationFrame(step);
        return;
      }
      const el = document.querySelector(selector);
      if (!el) return;
      const top = followScrollTop(
        el.getBoundingClientRect().top,
        window.scrollY,
        window.innerHeight,
        document.documentElement.scrollHeight,
        anchorRatio,
      );
      if (Math.abs(top - window.scrollY) < window.innerHeight * SettledScroller.DEAD_ZONE) return; // already in place: no nudging back and forth
      window.scrollTo({ top, behavior: 'smooth' });
    };
    requestAnimationFrame(step);
  }
}
