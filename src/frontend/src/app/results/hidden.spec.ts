import { describe, expect, it } from 'vitest';
import { HIDDEN_PAUSE_MS, QUICK_RETURN_MS, needsReconnect } from './hidden';

describe('needsReconnect', () => {
  it('keeps the connection after a quick tab switch', () => {
    expect(needsReconnect(0)).toBe(false);
    expect(needsReconnect(QUICK_RETURN_MS - 1)).toBe(false);
  });

  it('reconnects after a longer absence', () => {
    expect(needsReconnect(QUICK_RETURN_MS)).toBe(true);
    expect(needsReconnect(HIDDEN_PAUSE_MS)).toBe(true);
  });
});
