/** Keys with which a viewer scrolls the page themselves. */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

/**
 * Tells when the viewer scrolls the page themselves (wheel, touch, scroll keys, dragging the scrollbar), as opposed to the
 * page scrolling by itself, which says nothing about what the viewer wants.
 */
export class UserScrollGuard {
  /** How long after the last input the viewer still counts as scrolling. */
  static readonly IDLE_MS = 1000;
  private lastInput = Number.NEGATIVE_INFINITY;

  /** `onInput` runs on every scroll input of the viewer. */
  constructor(private readonly onInput: () => void) {}

  /** Starts listening; returns the function that removes the listeners again. */
  attach(target: Window = window): () => void {
    const input = () => {
      this.lastInput = performance.now();
      this.onInput();
    };
    const key = (event: KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key) && !(event.target instanceof HTMLElement && event.target.closest('input, textarea, select, button, [contenteditable]'))) input();
    };
    // a press right of the content is on the scrollbar
    const press = (event: MouseEvent) => {
      if (event.clientX >= document.documentElement.clientWidth) input();
    };
    const options = { passive: true } as const;
    target.addEventListener('wheel', input, options);
    target.addEventListener('touchstart', input, options);
    target.addEventListener('touchmove', input, options);
    target.addEventListener('keydown', key);
    target.addEventListener('mousedown', press, options);
    return () => {
      target.removeEventListener('wheel', input);
      target.removeEventListener('touchstart', input);
      target.removeEventListener('touchmove', input);
      target.removeEventListener('keydown', key);
      target.removeEventListener('mousedown', press);
    };
  }

  /** Whether the viewer scrolled a moment ago or is still at it. */
  scrolling(): boolean {
    return performance.now() - this.lastInput < UserScrollGuard.IDLE_MS;
  }
}
