import { describe, expect, it } from 'vitest';
import { RECONNECT_BASE_MS, RECONNECT_MAX_MS, randomJitter, reconnectDelay } from './backoff';

describe('reconnectDelay', () => {
  it('starts at the base and doubles with every attempt', () => {
    expect([0, 1, 2, 3].map(n => reconnectDelay(n, 1))).toEqual([1000, 2000, 4000, 8000]);
  });

  it('stops growing at the maximum', () => {
    expect(reconnectDelay(5, 1)).toBe(RECONNECT_MAX_MS);
    expect(reconnectDelay(50, 1)).toBe(RECONNECT_MAX_MS);
  });

  it('spreads the attempts with the jitter', () => {
    expect(reconnectDelay(2, 0.5)).toBe(2000);
    expect(reconnectDelay(2, 1.5)).toBe(6000);
  });

  it('treats a negative attempt as the first', () => {
    expect(reconnectDelay(-3, 1)).toBe(RECONNECT_BASE_MS);
  });

  it('draws a jitter factor from 0.5 up to 1.5', () => {
    for (let i = 0; i < 100; i++) {
      const j = randomJitter();
      expect(j).toBeGreaterThanOrEqual(0.5);
      expect(j).toBeLessThan(1.5);
    }
  });
});
