import { TimelineRacer, layoutTimeline, timelineGaps } from './timeline.util';

function racer(id: string, laps: number, total: string, lapTimes: string[] = [], finished: number | null = null): TimelineRacer {
  return { id, laps_count: laps, total_time: total, lap_times: lapTimes, finished_rank: finished };
}

describe('timelineGaps', () => {
  it('measures the gap to the leader at the same lap, and skips finished racers', () => {
    const gaps = timelineGaps([racer('a', 2, '1:00.000'), racer('b', 2, '1:01.500'), racer('c', 2, '1:05.000', [], 1)], 40);
    expect(gaps.map((g) => [g.race.id, g.gap])).toEqual([['a', 0], ['b', 1.5]]);
  });

  it('compares a racer who is a lap down with the leader at that lap, also when the first lap is not in the lap times', () => {
    const leader = racer('a', 3, '2:00.000', ['30.000', '30.000', '30.000']); // a warm-up lap of 30 s came first
    const lapped = racer('b', 2, '1:33.000', ['30.000', '30.000']);
    expect(timelineGaps([leader, lapped], 40)[1].gap).toBe(3);
    expect(timelineGaps([leader, racer('c', 0, '0:31.500')], 40)[1].gap).toBe(1.5);
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

  it('goes down the lines like stairs and starts at the top again where that fits', () => {
    const items = [0, 5, 10, 15, 30].map((gap, i) => ({ id: `r${i}`, gap, width: 300 }));
    expect(layoutTimeline(items, 40, 1000).map((x) => x.row)).toEqual([0, 1, 2, 0, 1]);
  });

  it('adds a line below the previous badge where the stairs would collide', () => {
    const items = [0, 5, 10, 15, 16].map((gap, i) => ({ id: `r${i}`, gap, width: 300 }));
    expect(layoutTimeline(items, 40, 1000).map((x) => x.row)).toEqual([0, 2, 3, 0, 1]);
  });

  it('starts at the top again when the field is close together but narrow enough to fit', () => {
    const items = [0, 1, 2, 3, 4, 5].map((gap, i) => ({ id: `r${i}`, gap, width: 100 }));
    expect(layoutTimeline(items, 40, 1000).map((x) => x.row)).toEqual([0, 1, 2, 3, 4, 0]);
  });

  it('keeps a badge on its line unless it touches another one there', () => {
    const items = [0, 5, 10].map((gap, i) => ({ id: `r${i}`, gap, width: 100 }));
    const rows = new Map([['r0', 1], ['r1', 0], ['r2', 1], ['gone', 2]]);
    expect(layoutTimeline(items, 40, 1000, rows).map((x) => x.row)).toEqual([1, 0, 1]);
    const close = [0, 1].map((gap, i) => ({ id: `r${i}`, gap, width: 100 }));
    expect(layoutTimeline(close, 40, 1000, new Map([['r0', 0], ['r1', 0]])).map((x) => x.row)).toEqual([0, 1]);
  });

  it('moves a badge from the bottom half up to a line of the top half with room, else keeps its line', () => {
    const items = [0, 1, 20].map((gap, i) => ({ id: `r${i}`, gap, width: 100 }));
    const rows = new Map([['r0', 0], ['r1', 1], ['r2', 3]]);
    expect(layoutTimeline(items, 40, 1000, rows).map((x) => x.row)).toEqual([0, 1, 0]);
    const wide = [0, 1, 2, 3].map((gap, i) => ({ id: `r${i}`, gap, width: 100 }));
    const four = new Map([['r0', 0], ['r1', 1], ['r2', 2], ['r3', 3]]);
    expect(layoutTimeline(wide, 40, 1000, four).map((x) => x.row)).toEqual([0, 1, 2, 3]);
  });

  it('keeps a far away racer inside the timeline', () => {
    const [p] = layoutTimeline([{ id: 'a', gap: 500, width: 100 }], 40, 1000);
    expect(p.offset).toBe(900);
  });
});
