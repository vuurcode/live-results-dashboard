import { BehaviorSubject } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { ColorSchemeChoice, followColorScheme } from './color-scheme';

function fakes(dark: boolean, choice: ColorSchemeChoice = 'auto') {
  const listeners = new Set<() => void>();
  const query = {
    matches: dark,
    addEventListener: (_: string, l: () => void) => { listeners.add(l); },
    removeEventListener: (_: string, l: () => void) => { listeners.delete(l); },
  };
  const attrs = new Map<string, string>();
  const root = { setAttribute: (k: string, v: string) => { attrs.set(k, v); } };
  const choice$ = new BehaviorSubject<ColorSchemeChoice>(choice);
  return {
    query, listeners, attrs, root, choice$,
    win: { matchMedia: () => query } as never,
    change: (to: boolean) => { query.matches = to; listeners.forEach((l) => l()); },
  };
}

describe('followColorScheme', () => {
  it('sets the theme from the system preference at once', () => {
    const f = fakes(true);
    followColorScheme(f.win, f.root as never, f.choice$);
    expect(f.attrs.get('data-coreui-theme')).toBe('dark');
  });

  it('follows a change of the preference', () => {
    const f = fakes(false);
    followColorScheme(f.win, f.root as never, f.choice$);
    expect(f.attrs.get('data-coreui-theme')).toBe('light');
    f.change(true);
    expect(f.attrs.get('data-coreui-theme')).toBe('dark');
  });

  it('lets a choice of on or off override the system preference, also when it changes', () => {
    const f = fakes(true, 'light');
    followColorScheme(f.win, f.root as never, f.choice$);
    expect(f.attrs.get('data-coreui-theme')).toBe('light');
    f.change(false);
    f.choice$.next('dark');
    expect(f.attrs.get('data-coreui-theme')).toBe('dark');
    f.change(true);
    expect(f.attrs.get('data-coreui-theme')).toBe('dark');
    f.choice$.next('auto');
    expect(f.attrs.get('data-coreui-theme')).toBe('dark');
    f.change(false);
    expect(f.attrs.get('data-coreui-theme')).toBe('light');
  });

  it('stops following when told to', () => {
    const f = fakes(false);
    followColorScheme(f.win, f.root as never, f.choice$)();
    expect(f.listeners.size).toBe(0);
    expect(f.choice$.observed).toBe(false);
  });
});
