import { DEFAULT_TIMELINE_SECONDS, TimelineRacer, layoutTimeline, timelineGaps, timelineScale } from './timeline.util';

function racer(id: string, laps: number, total: string, lapTimes: string[] = [], finished: number | null = null): TimelineRacer {
  return { id, laps_count: laps, total_time: total, lap_times: lapTimes, finished_rank: finished };
}

describe('timelineScale', () => {
  it('is the slowest lap time of the race', () => {
    expect(timelineScale([racer('a', 2, '1:00.0', ['30.0', '31.5']), racer('b', 2, '1:02.0', ['29.0', '33.0'])])).toBe(33);
  });

  it('is 40 seconds while no lap is known', () => {
    expect(timelineScale([racer('a', 0, '')])).toBe(DEFAULT_TIMELINE_SECONDS);
  });
});

describe('timelineGaps', () => {
  it('measures the gap to the leader at the same lap, and skips finished racers', () => {
    const gaps = timelineGaps([racer('a', 2, '1:00.000'), racer('b', 2, '1:01.500'), racer('c', 2, '1:05.000', [], 1)], 40);
    expect(gaps.map((g) => [g.race.id, g.gap])).toEqual([['a', 0], ['b', 1.5]]);
  });

  it('compares a racer who is laps down with the leader at that lap', () => {
    const leader = racer('a', 3, '1:30.000', ['30.000', '30.000', '30.000']);
    const lapped = racer('b', 2, '1:03.000');
    expect(timelineGaps([leader, lapped], 40)[1].gap).toBe(3);
  });

  it('counts the missing laps at the reference lap time when the leader laps are unknown', () => {
    expect(timelineGaps([racer('a', 3, '1:30.000'), racer('b', 1, '0:35.000')], 30)[1].gap).toBe(60);
  });
});

describe('layoutTimeline', () => {
  it('puts the leader at the right edge and the others left of it by their gap', () => {
    const p = layoutTimeline([{ id: 'a', gap: 0, width: 100 }, { id: 'b', gap: 10, width: 100 }], 40, 1000);
    expect(p).toEqual([{ id: 'a', offset: 0, row: 0 }, { id: 'b', offset: 250, row: 0 }]);
  });

  it('moves a badge that would touch the one before it to a line below', () => {
    const p = layoutTimeline([{ id: 'a', gap: 0, width: 100 }, { id: 'b', gap: 1, width: 100 }, { id: 'c', gap: 20, width: 100 }], 40, 1000);
    expect(p.map((x) => x.row)).toEqual([0, 1, 0]);
  });

  it('keeps a far away racer inside the timeline', () => {
    const [p] = layoutTimeline([{ id: 'a', gap: 500, width: 100 }], 40, 1000);
    expect(p.offset).toBe(900);
  });
});
