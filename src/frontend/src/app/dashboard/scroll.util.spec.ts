import { describe, expect, it } from 'vitest';
import { followScrollTop } from './scroll.util';

describe('followScrollTop', () => {
  it('places the element a fraction of the way down the viewport', () => {
    // element is 900px below the viewport top while scrolled 100px; viewport 1000px
    expect(followScrollTop(900, 100, 1000, 5000, 0.3)).toBe(700);
  });

  it('never scrolls above the top of the page', () => {
    expect(followScrollTop(50, 0, 1000, 5000, 0.3)).toBe(0);
  });

  it('never scrolls past the end of the page', () => {
    expect(followScrollTop(4900, 0, 1000, 5000, 0.3)).toBe(4000);
  });

  it('handles pages shorter than the viewport', () => {
    expect(followScrollTop(300, 0, 1000, 800, 0.3)).toBe(0);
  });

  it('keeps the element below what the top bar and the distance title cover', () => {
    // a third of a 600px viewport is 180px, but 170px is pinned: the element sits 170 + 18px down
    expect(followScrollTop(900, 100, 600, 5000, 0.3, 170)).toBe(812);
  });

  it('leaves a taller anchor alone when nothing reaches it', () => {
    expect(followScrollTop(900, 100, 1000, 5000, 0.3, 80)).toBe(700);
  });
});
