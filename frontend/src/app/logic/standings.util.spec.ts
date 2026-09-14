import { describe, it, expect } from 'vitest';
import { recomputePositions, recomputeGroups, resolveRaces, PositionedCompetitor, GroupableCompetitor } from './standings.util';

function comp(overrides: Partial<PositionedCompetitor> = {}): PositionedCompetitor {
  return { laps_count: 0, total_time: '', position: 0, position_change: null, ...overrides };
}

describe('recomputePositions', () => {
  it('sorts by laps descending then total_time ascending', () => {
    const a = comp({ laps_count: 3, total_time: '50.000' });
    const b = comp({ laps_count: 4, total_time: '60.000' });
    const c = comp({ laps_count: 4, total_time: '55.000' });
    const sorted = recomputePositions([a, b, c]);
    expect(sorted).toEqual([c, b, a]);
    expect(c.position).toBe(1);
    expect(b.position).toBe(2);
    expect(a.position).toBe(3);
  });

  it('ranks a competitor with more laps ahead of one with fewer, even with no time recorded yet', () => {
    // laps_count is the primary sort key; total_time only breaks ties within
    // the same lap count, so it never overrides a lap-count difference.
    const moreLapsNoTime = comp({ laps_count: 5, total_time: '' });
    const fewerLapsWithTime = comp({ laps_count: 2, total_time: '30.000' });
    const sorted = recomputePositions([fewerLapsWithTime, moreLapsNoTime]);
    expect(sorted).toEqual([moreLapsNoTime, fewerLapsWithTime]);
  });

  it('places the no-time competitor last only as a tiebreaker within the same lap count', () => {
    const withTime = comp({ laps_count: 3, total_time: '30.000' });
    const noTime = comp({ laps_count: 3, total_time: '' });
    const sorted = recomputePositions([noTime, withTime]);
    expect(sorted).toEqual([withTime, noTime]);
  });

  it('treats two no-time competitors as tied (stable order)', () => {
    const first = comp({ laps_count: 1, total_time: '' });
    const second = comp({ laps_count: 1, total_time: '' });
    const sorted = recomputePositions([first, second]);
    expect(sorted).toEqual([first, second]);
  });

  it('flags position_change up/down relative to the previous position, and null when unchanged', () => {
    const risen = comp({ laps_count: 5, total_time: '10.000', position: 3 });
    const fallen = comp({ laps_count: 4, total_time: '10.000', position: 1 });
    const steady = comp({ laps_count: 6, total_time: '10.000', position: 1 });
    // steady would sort first (most laps); risen second; fallen last
    const sorted = recomputePositions([fallen, risen, steady]);
    expect(steady.position).toBe(1);
    expect(steady.position_change).toBeNull(); // was already 1
    expect(risen.position).toBe(2);
    expect(risen.position_change).toBe('up'); // 3 -> 2
    expect(fallen.position).toBe(3);
    expect(fallen.position_change).toBe('down'); // 1 -> 3
  });

  it('does not mutate the input array order, only element positions', () => {
    const a = comp({ laps_count: 1 });
    const b = comp({ laps_count: 2 });
    const input = [a, b];
    recomputePositions(input);
    expect(input).toEqual([a, b]); // original array reference order untouched
  });
});

function group(overrides: Partial<GroupableCompetitor> = {}): GroupableCompetitor {
  return {
    laps_count: 0,
    total_time: '',
    formatted_total_time: '',
    finished_rank: null,
    ...overrides,
  };
}

const lapUnit = (n: number) => (n === 1 ? 'lap' : 'laps');

describe('recomputeGroups', () => {
  it('returns no groups and does not throw when maxGroups is 0', () => {
    const races = [group({ laps_count: 3, total_time: '10.000', formatted_total_time: '10.000' })];
    expect(recomputeGroups(races, 2, 0, lapUnit)).toEqual([]);
  });

  it('groups same-lap competitors within the time threshold together', () => {
    const a = group({ laps_count: 3, total_time: '10.000', formatted_total_time: '10.000' });
    const b = group({ laps_count: 3, total_time: '11.500', formatted_total_time: '11.500' });
    const groups = recomputeGroups([a, b], 2.0, 4, lapUnit);
    expect(groups).toHaveLength(1);
    expect(groups[0].races).toEqual([a, b]);
    expect(a.gap_to_above).toBeNull();
    expect(b.gap_to_above).toBe('+1.500s');
  });

  it('splits into a new group when the time gap exceeds the threshold', () => {
    const a = group({ laps_count: 3, total_time: '10.000', formatted_total_time: '10.000' });
    const b = group({ laps_count: 3, total_time: '15.000', formatted_total_time: '15.000' });
    const groups = recomputeGroups([a, b], 2.0, 4, lapUnit);
    expect(groups).toHaveLength(2);
    expect(groups[0].races).toEqual([a]);
    expect(groups[1].races).toEqual([b]);
  });

  it('uses a lap-count gap (not time) whenever lap counts differ, always vs the head group', () => {
    const leader = group({ laps_count: 5, total_time: '50.000', formatted_total_time: '50.000' });
    const oneDown = group({ laps_count: 4, total_time: '48.000', formatted_total_time: '48.000' });
    const twoDown = group({ laps_count: 3, total_time: '30.000', formatted_total_time: '30.000' });
    const groups = recomputeGroups([leader, oneDown, twoDown], 2.0, 4, lapUnit);
    expect(groups).toHaveLength(3);
    // gap to group ahead compares lap count against the immediately preceding group
    expect(groups[1].gapToGroupAhead).toBe('+1 lap');
    // but lap-diff for group cards is always vs the FIRST group, not the group ahead
    expect(groups[2].gapToGroupAhead).toBe('+2 laps');
  });

  it('excludes finished competitors from grouping', () => {
    const finished = group({ laps_count: 5, total_time: '40.000', formatted_total_time: '40.000', finished_rank: 1 });
    const unfinished = group({ laps_count: 4, total_time: '38.000', formatted_total_time: '38.000' });
    const groups = recomputeGroups([finished, unfinished], 2.0, 4, lapUnit);
    expect(groups).toHaveLength(1);
    expect(groups[0].races).toEqual([unfinished]);
  });

  it('keeps maxGroups real groups and folds everything past that into one additional tail group', () => {
    const g1 = group({ laps_count: 5, total_time: '50.000', formatted_total_time: '50.000' });
    const g2 = group({ laps_count: 4, total_time: '48.000', formatted_total_time: '48.000' });
    const g3 = group({ laps_count: 3, total_time: '30.000', formatted_total_time: '30.000' });
    // 3 real groups form (different lap counts each); maxGroups=2 keeps the
    // first 2 intact and appends ONE synthetic tail group for the rest —
    // i.e. length is maxGroups + 1, not maxGroups.
    const groups = recomputeGroups([g1, g2, g3], 2.0, 2, lapUnit);
    expect(groups).toHaveLength(3);
    expect(groups[0].races).toEqual([g1]);
    expect(groups[1].races).toEqual([g2]);
    expect(groups[2].isOthers).toBe(true);
    expect(groups[2].isLastGroup).toBe(true);
    expect(groups[2].races).toEqual([g3]);
    expect(groups[2].gapToGroupAhead).toBe('+2 laps'); // head (5 laps) - tail (3 laps)
  });

  it('folds multiple overflow groups into a single tail group', () => {
    const g1 = group({ laps_count: 5, total_time: '50.000', formatted_total_time: '50.000' });
    const g2 = group({ laps_count: 4, total_time: '48.000', formatted_total_time: '48.000' });
    const g3 = group({ laps_count: 3, total_time: '30.000', formatted_total_time: '30.000' });
    const groups = recomputeGroups([g1, g2, g3], 2.0, 1, lapUnit);
    expect(groups).toHaveLength(2); // 1 kept + 1 tail
    expect(groups[1].isOthers).toBe(true);
    expect(groups[1].races).toEqual([g2, g3]); // both overflow groups merged, in order
    expect(groups[1].gapToGroupAhead).toBe('+1 lap'); // head (5) - tail leader g2 (4)
    expect(g3.gap_to_above).toBe('+1 lap'); // g3 vs tail leader g2, within the merged tail
  });

  it('marks the last real group as isLastGroup when there is no overflow', () => {
    const only = group({ laps_count: 1, total_time: '10.000', formatted_total_time: '10.000' });
    const groups = recomputeGroups([only], 2.0, 4, lapUnit);
    expect(groups[0].isLastGroup).toBe(true);
    expect(groups[0].isOthers).toBe(false);
  });
});

describe('resolveRaces', () => {
  const white = { lane: 'white', id: 'w' };
  const red = { lane: 'red', id: 'r' };
  const purple = { lane: 'purple', id: 'p' }; // not in LANE_ORDER

  it('returns a fixed 4-slot array pinned by lane, null where absent', () => {
    const map = new Map([
      ['w', white],
      ['r', red],
    ]);
    const result = resolveRaces(['w', 'r'], map, true);
    expect(result).toEqual([white, red, null, null]);
  });

  it('appends competitors with an unrecognized lane after the fixed slots', () => {
    const map = new Map([
      ['w', white],
      ['p', purple],
    ]);
    const result = resolveRaces(['w', 'p'], map, true);
    expect(result).toEqual([white, null, null, null, purple]);
  });

  it('returns an unpinned resolved list when pinnedByLane is false', () => {
    const map = new Map([
      ['r', red],
      ['w', white],
    ]);
    expect(resolveRaces(['r', 'w'], map, false)).toEqual([red, white]);
  });

  it('returns null-filled slots when the competitor map is missing entirely', () => {
    expect(resolveRaces(['w'], undefined, true)).toEqual([null, null, null, null]);
    expect(resolveRaces(['w'], undefined, false)).toEqual([]);
  });
});
