import { describe, it, expect } from 'vitest';
import {
  individualDistanceLapSchedule,
  individualDistanceTotalLaps,
  isIndividualFinished,
  individualRaceComplete,
  pairHeatGroups,
  trimmedRaces,
  heatGroupLaneColors,
  individualPrComparison,
  massFinishGapFromLeader,
  pendingLapCount,
  individualStartDegrees,
  individualFinishAngle,
} from './heats.util';

describe('individualDistanceLapSchedule / individualDistanceTotalLaps', () => {
  it('derives laps from distance mod 400', () => {
    expect(individualDistanceLapSchedule(1000)).toEqual([200, 600, 1000]);
    expect(individualDistanceLapSchedule(500)).toEqual([100, 500]);
    expect(individualDistanceLapSchedule(100)).toEqual([100]);
    expect(individualDistanceLapSchedule(400)).toEqual([400]);
  });

  it('counts total laps', () => {
    expect(individualDistanceTotalLaps(1000)).toBe(3);
    expect(individualDistanceTotalLaps(400)).toBe(1);
  });
});

describe('isIndividualFinished / individualRaceComplete', () => {
  it('is finished once laps_count reaches the schedule length', () => {
    expect(isIndividualFinished({ laps_count: 3, invalid_reason: null }, 1000)).toBe(true);
    expect(isIndividualFinished({ laps_count: 2, invalid_reason: null }, 1000)).toBe(false);
  });

  it('counts an invalid race as complete regardless of laps_count', () => {
    expect(individualRaceComplete({ laps_count: 0, invalid_reason: 'DQ' }, 1000)).toBe(true);
    expect(individualRaceComplete({ laps_count: 0, invalid_reason: null }, 1000)).toBe(false);
  });
});

describe('pairHeatGroups', () => {
  const labelFor = (h: number) => `Heat ${h}`;

  it('renders each heat as a row of its own', () => {
    const wr = { heat: 1, races: ['white', 'red', null, null] };
    const yb = { heat: 2, races: [null, null, 'yellow', 'blue'] };
    expect(pairHeatGroups([wr, yb], labelFor)).toEqual([
      { label: 'Heat 1', races: ['white', 'red'] },
      { label: 'Heat 2', races: ['yellow', 'blue'] },
    ]);
  });

  it('puts a lone skater on the first card, whichever lane', () => {
    const groups = [
      { heat: 1, races: [null, 'red', null, null] },
      { heat: 2, races: [null, null, null, 'blue'] },
      { heat: 3, races: [null, null, 'yellow', null] },
    ];
    expect(pairHeatGroups(groups, labelFor).map((g) => g.races)).toEqual([['red', null], ['blue', null], ['yellow', null]]);
  });

  it('keeps one slot per lane for a heat of more than two skaters', () => {
    const full = { heat: 1, races: ['white', 'red', 'yellow', null] };
    expect(pairHeatGroups([full], labelFor)).toEqual([{ label: 'Heat 1', races: full.races }]);
  });
});

describe('trimmedRaces', () => {
  it('removes trailing nulls only', () => {
    expect(trimmedRaces(['a', 'b', null, null])).toEqual(['a', 'b']);
    expect(trimmedRaces(['a', null, 'b', null])).toEqual(['a', null, 'b']);
    expect(trimmedRaces([null, null])).toEqual([]);
  });
});

describe('heatGroupLaneColors', () => {
  it('takes the first non-null race color per slot across groups', () => {
    const groups = [
      { label: 'Heat 1', races: [{ lane: 'white' }, null, null, null] },
      { label: 'Heat 2', races: [null, { lane: 'red' }, null, null] },
    ];
    expect(heatGroupLaneColors(groups)).toEqual(['white', 'red']);
  });
});

describe('individualPrComparison', () => {
  it('returns faster:true with a positive diff when the new time beats the PR', () => {
    const race = { laps_count: 3, invalid_reason: null };
    const result = individualPrComparison('50.000', '48.500', race, 1000);
    expect(result).toEqual({ faster: true, diff: '1.500' });
  });

  it('returns faster:false when the new time is slower than or equal to the PR', () => {
    const race = { laps_count: 3, invalid_reason: null };
    expect(individualPrComparison('48.500', '48.500', race, 1000)).toEqual({ faster: false, diff: '0.000' });
    expect(individualPrComparison('48.500', '50.000', race, 1000)).toEqual({ faster: false, diff: '1.500' });
  });

  it('returns null before the race is finished', () => {
    const race = { laps_count: 1, invalid_reason: null };
    expect(individualPrComparison('50.000', '20.000', race, 1000)).toBeNull();
  });

  it('returns null when there is no personal record or no total time yet', () => {
    const race = { laps_count: 3, invalid_reason: null };
    expect(individualPrComparison(null, '48.500', race, 1000)).toBeNull();
    expect(individualPrComparison('50.000', '', race, 1000)).toBeNull();
  });
});

describe('massFinishGapFromLeader', () => {
  it('returns null for the leader (rank 1) or unfinished competitors', () => {
    expect(massFinishGapFromLeader(1, '60.000', '60.000')).toBeNull();
    expect(massFinishGapFromLeader(null, '60.000', '60.000')).toBeNull();
  });

  it('formats the positive gap behind the leader', () => {
    expect(massFinishGapFromLeader(2, '62.500', '60.000')).toBe('+2.500');
  });

  it('formats a minute-scale gap', () => {
    expect(massFinishGapFromLeader(2, '135.000', '60.000')).toBe('+1:15.000');
  });

  it('returns null when the gap is non-positive or times are missing', () => {
    expect(massFinishGapFromLeader(2, '60.000', '60.000')).toBeNull();
    expect(massFinishGapFromLeader(2, '', '60.000')).toBeNull();
    expect(massFinishGapFromLeader(2, '60.000', null)).toBeNull();
  });
});

describe('pendingLapCount', () => {
  it('clamps to zero when laps already meet or exceed the total', () => {
    expect(pendingLapCount(3, 5)).toBe(2);
    expect(pendingLapCount(5, 5)).toBe(0);
    expect(pendingLapCount(6, 5)).toBe(0);
  });
});

describe('individualStartDegrees', () => {
  it('places each distance where it starts on the oval', () => {
    expect([100, 500, 1000, 1500, 3000, 5000, 10000].map(individualStartDegrees)).toEqual([90, 90, 180, 270, 180, 180, 360]);
  });
  it('derives other distances from the length of their first lap', () => {
    expect(individualStartDegrees(800)).toBeCloseTo(360); // two full laps: starts at the finish
    expect(individualStartDegrees(600)).toBeCloseTo(180); // 200m first lap
  });
});

describe('individualFinishAngle', () => {
  it('puts the finish on the bottom straight right of the middle, and the 1000m finish in the middle of the bottom', () => {
    expect([500, 1500, 10000, 1000].map(individualFinishAngle)).toEqual([135, 135, 135, 180]);
  });
});
