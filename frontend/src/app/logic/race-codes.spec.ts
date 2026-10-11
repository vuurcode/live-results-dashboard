import { describe, expect, it } from 'vitest';
import { GHOST_HIDING_CODES, NO_TIME_CODES, RECORD_CODES, RECORD_PRIORITY, RaceCode, isNeverLive } from './race-codes';

describe('isNeverLive', () => {
  it('is true for a competitor who did not start or withdrew, in either field', () => {
    expect(isNeverLive({ invalid_reason: 'DNS' })).toBe(true);
    expect(isNeverLive({ invalid_reason: null, remark: 'wdr' })).toBe(true);
  });
  it('finds the code among several remarks', () => {
    expect(isNeverLive({ remark: 'PR  DNS' })).toBe(true);
    expect(isNeverLive({ remark: ' WDR ' })).toBe(true);
  });
  it('is false for other competitors', () => {
    expect(isNeverLive({ invalid_reason: 'DQ' })).toBe(false);
    expect(isNeverLive({ remark: 'PR' })).toBe(false);
    expect(isNeverLive({})).toBe(false);
  });
});

describe('code sets', () => {
  it('a race without a result time is disqualified, did not start, did not finish or withdrew; a fall still has one', () => {
    expect([...NO_TIME_CODES].sort()).toEqual(['DNF', 'DNS', 'DQ', 'WDR']);
    expect(NO_TIME_CODES.has(RaceCode.Fall)).toBe(false);
  });
  it('a race that never ran shows no placeholder laps, but one that did not finish does', () => {
    expect([...GHOST_HIDING_CODES].sort()).toEqual(['DNS', 'DQ', 'WDR']);
    expect(GHOST_HIDING_CODES.has(RaceCode.DidNotFinish)).toBe(false);
  });
  it('records are ordered from the most significant: world, national, track, track on the course', () => {
    expect(RECORD_PRIORITY).toEqual(['WR', 'NR', 'TR', 'TRC']);
    expect([...RECORD_CODES]).toEqual([...RECORD_PRIORITY]);
    expect(RECORD_CODES.has(RaceCode.PersonalRecord)).toBe(false);
  });
});
