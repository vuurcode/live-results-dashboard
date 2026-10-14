import { describe, expect, it } from 'vitest';
import { CompetitorUpdate } from '../models/data.models';
import { findLiveHeat } from './live-heat';

const race = (lapsUpdatedAt?: number, extra: Partial<CompetitorUpdate> = {}) =>
  ({ lapsUpdatedAt, invalid_reason: null, remark: null, ...extra }) as CompetitorUpdate;

describe('findLiveHeat', () => {
  it('is none without heats or without timed laps', () => {
    expect(findLiveHeat([])).toBeNull();
    expect(findLiveHeat([{ races: [race(), null] }])).toBeNull();
  });
  it('is the heat whose laps changed last', () => {
    expect(findLiveHeat([{ races: [race(5)] }, { races: [race(9), null] }, { races: [race(7)] }])).toEqual({ index: 1, updatedAt: 9 });
  });
  it('is the later heat when laps changed together', () => {
    expect(findLiveHeat([{ races: [race(5)] }, { races: [race(5)] }])?.index).toBe(1);
  });
  it('ignores competitors who did not start or withdrew', () => {
    const heats = [{ races: [race(5)] }, { races: [race(9, { invalid_reason: 'DNS' }), race(8, { remark: 'WDR' })] }];
    expect(findLiveHeat(heats)).toEqual({ index: 0, updatedAt: 5 });
  });
});
