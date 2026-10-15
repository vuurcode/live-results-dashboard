import { describe, expect, it } from 'vitest';
import { keepScreenAwake } from './wake-lock';

function fakes() {
  const state = { requests: 0, releases: 0, refuse: false };
  const sentinels: EventTarget[] = [];
  const host = {
    wakeLock: {
      request: async () => {
        state.requests++;
        if (state.refuse) throw new Error('NotAllowedError');
        const s = Object.assign(new EventTarget(), { release: async () => { state.releases++; } });
        sentinels.push(s);
        return s;
      },
    },
  };
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: 'visible' as DocumentVisibilityState,
    addEventListener: (_: string, l: () => void) => { listeners.add(l); },
    removeEventListener: (_: string, l: () => void) => { listeners.delete(l); },
  };
  return { state, sentinels, host, doc, listeners, fire: () => listeners.forEach((l) => l()) };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('keepScreenAwake', () => {
  it('requests the lock at once when the page is visible', async () => {
    const f = fakes();
    keepScreenAwake(f.host, f.doc as never);
    await settle();
    expect(f.state.requests).toBe(1);
  });

  it('does not request while the page is hidden, but does when it comes back', async () => {
    const f = fakes();
    f.doc.visibilityState = 'hidden' as never;
    keepScreenAwake(f.host, f.doc as never);
    await settle();
    expect(f.state.requests).toBe(0);
    f.doc.visibilityState = 'visible';
    f.fire();
    await settle();
    expect(f.state.requests).toBe(1);
  });

  it('requests again after the browser released the lock, and not while it holds one', async () => {
    const f = fakes();
    keepScreenAwake(f.host, f.doc as never);
    await settle();
    f.fire();
    await settle();
    expect(f.state.requests).toBe(1);
    f.sentinels[0].dispatchEvent(new Event('release'));
    f.fire();
    await settle();
    expect(f.state.requests).toBe(2);
  });

  it('releases the lock and stops listening when stopped', async () => {
    const f = fakes();
    const stop = keepScreenAwake(f.host, f.doc as never);
    await settle();
    stop();
    await settle();
    expect(f.state.releases).toBe(1);
    expect(f.listeners.size).toBe(0);
  });

  it('survives a refused request and a browser without the API', async () => {
    const f = fakes();
    f.state.refuse = true;
    keepScreenAwake(f.host, f.doc as never);
    await settle();
    expect(f.state.requests).toBe(1);
    expect(() => keepScreenAwake({}, f.doc as never)()).not.toThrow();
  });
});
