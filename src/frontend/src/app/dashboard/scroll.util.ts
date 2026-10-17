/** The least the element may sit below the pinned top bar and distance title, as a fraction of the viewport height. */
const PINNED_MARGIN = 0.03;

/**
 * Page scroll position that puts an element `anchorRatio` of the way down the viewport
 * (0 = flush with the top, 0.3 = a third down), clamped to the scrollable range. The element always ends up below
 * the `pinnedHeight` that the top bar and the distance title cover; on a narrow screen, where the top bar wraps
 * and the viewport is short, that decides the position.
 */
export function followScrollTop(
  elementTop: number,
  scrollY: number,
  viewportHeight: number,
  documentHeight: number,
  anchorRatio: number,
  pinnedHeight = 0,
): number {
  const offset = Math.max(viewportHeight * anchorRatio, pinnedHeight + viewportHeight * PINNED_MARGIN);
  const target = elementTop + scrollY - offset;
  const max = Math.max(0, documentHeight - viewportHeight);
  return Math.min(Math.max(0, target), max);
}

function nextFrame(): Promise<number> {
  return new Promise<number>((resolve) => requestAnimationFrame(resolve));
}

/** Height at the top of the viewport that the pinned top bar and the pinned distance title cover. */
function pinnedHeight(): number {
  const bar = document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 0;
  const title = document.querySelector('.accordion-header')?.getBoundingClientRect().height ?? 0;
  return Math.max(0, bar) + title;
}

/**
 * Scrolls to elements once the page has stopped changing height. A distance that is opening, or cards that are just
 * arriving, make the page grow for a moment; scrolling before that is over aims at a page that is still too short.
 * Content above the target can still move while the (smooth) scroll runs, e.g. the distance that was followed before
 * folds up, so after each scroll the position is checked again and corrected.
 */
export class SettledScroller {
  /** Longest wait for the page to stop changing height before scrolling anyway. */
  private static readonly SETTLE_MAX_MS = 1000;
  /** How long the page height has to stay the same to count as settled. */
  private static readonly SETTLE_STABLE_MS = 150;
  /** Longest wait for a smooth scroll to come to rest. */
  private static readonly SCROLL_MAX_MS = 1500;
  /** A scroll shorter than this fraction of the viewport height is not worth making. */
  private static readonly DEAD_ZONE = 0.1;
  /** After a scroll, a miss of more than this fraction of the viewport height is corrected. */
  private static readonly CORRECT_ZONE = 0.04;
  private static readonly MAX_CORRECTIONS = 3;

  private run = 0;

  /** `smooth` tells whether a scroll glides (true) or jumps. */
  constructor(private readonly smooth: () => boolean = () => true) {}

  /** Drops a scroll that is still waiting or underway. */
  cancel(): void {
    this.run++;
  }

  /** Scrolls the element competitioning `selector` into place; a newer call replaces one that is still waiting. */
  async scrollTo(selector: string, anchorRatio: number): Promise<void> {
    const run = ++this.run;
    for (let attempt = 0; attempt <= SettledScroller.MAX_CORRECTIONS; attempt++) {
      await this.settle(run);
      if (run !== this.run) return;
      const el = document.querySelector(selector);
      if (!el) return;
      const top = followScrollTop(
        el.getBoundingClientRect().top,
        window.scrollY,
        window.innerHeight,
        document.documentElement.scrollHeight,
        anchorRatio,
        pinnedHeight(),
      );
      const zone = attempt === 0 ? SettledScroller.DEAD_ZONE : SettledScroller.CORRECT_ZONE; // already in place: no nudging back and forth
      if (Math.abs(top - window.scrollY) < window.innerHeight * zone) return;
      window.scrollTo({ top, behavior: this.smooth() ? 'smooth' : 'instant' });
      await this.rest(run);
      if (run !== this.run) return;
    }
  }

  /** Resolves when the page height has stayed the same for a moment (or after a maximum wait). */
  private async settle(run: number): Promise<void> {
    const started = performance.now();
    let height = -1;
    let steadySince = started;
    for (;;) {
      const now = await nextFrame();
      if (run !== this.run) return;
      const current = document.documentElement.scrollHeight;
      if (current !== height) {
        height = current;
        steadySince = now;
      }
      if (now - steadySince >= SettledScroller.SETTLE_STABLE_MS || now - started >= SettledScroller.SETTLE_MAX_MS) return;
    }
  }

  /** Resolves when the scroll position has stopped moving. */
  private async rest(run: number): Promise<void> {
    const started = performance.now();
    let y = window.scrollY;
    let still = 0;
    while (performance.now() - started < SettledScroller.SCROLL_MAX_MS) {
      await nextFrame();
      if (run !== this.run) return;
      still = window.scrollY === y ? still + 1 : 0;
      y = window.scrollY;
      if (still >= 6) return;
    }
  }
}
