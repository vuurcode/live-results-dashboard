import { describe, expect, it } from 'vitest';
import { isNeverLive } from './race-codes';

describe('isNeverLive', () => {
  it('is true for a racer who did not start or withdrew, in either field', () => {
    expect(isNeverLive({ invalid_reason: 'DNS' })).toBe(true);
    expect(isNeverLive({ invalid_reason: null, remark: 'wdr' })).toBe(true);
  });
  it('is false for other racers', () => {
    expect(isNeverLive({ invalid_reason: 'DQ' })).toBe(false);
    expect(isNeverLive({ remark: 'PR' })).toBe(false);
    expect(isNeverLive({})).toBe(false);
  });
});
