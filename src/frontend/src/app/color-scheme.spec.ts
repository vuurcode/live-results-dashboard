import { describe, expect, it } from 'vitest';
import { followColorScheme } from './color-scheme';

function fakes(dark: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: dark,
    addEventListener: (_: string, l: () => void) => { listeners.add(l); },
    removeEventListener: (_: string, l: () => void) => { listeners.delete(l); },
  };
  const attrs = new Map<string, string>();
  const root = { setAttribute: (k: string, v: string) => { attrs.set(k, v); } };
  return {
    query, listeners, attrs, root,
    win: { matchMedia: () => query } as never,
    change: (to: boolean) => { query.matches = to; listeners.forEach((l) => l()); },
  };
}

describe('followColorScheme', () => {
  it('sets the theme from the system preference at once', () => {
    const f = fakes(true);
    followColorScheme(f.win, f.root as never);
    expect(f.attrs.get('data-coreui-theme')).toBe('dark');
  });

  it('follows a change of the preference', () => {
    const f = fakes(false);
    followColorScheme(f.win, f.root as never);
    expect(f.attrs.get('data-coreui-theme')).toBe('light');
    f.change(true);
    expect(f.attrs.get('data-coreui-theme')).toBe('dark');
  });

  it('stops following when told to', () => {
    const f = fakes(false);
    followColorScheme(f.win, f.root as never)();
    expect(f.listeners.size).toBe(0);
  });
});
