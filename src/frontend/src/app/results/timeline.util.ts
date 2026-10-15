import { parseSeconds } from './time.util';

/** The seconds the width of the timeline stands for. */
export const TIMELINE_SECONDS = 15;

export interface TimelineRacer {
  id: string;
  laps_count: number;
  total_time: string;
  lap_times: string[];
  finished_rank: number | null;
}

/**
 * The seconds each unfinished racer is behind the first one: the difference between the times at which they passed the
 * same lap. The total time is the clock at the latest passing, which counts laps that are not in the lap times (the
 * warm-up lap of a mass start), so the leader's clock at an earlier lap is their total minus the lap times after it.
 * When the leader's laps are unknown the gap is the missing laps at `lapSeconds` each. The first racer is the leader
 * (the races are sorted by position).
 */
export function timelineGaps<T extends TimelineRacer>(races: T[], lapSeconds: number): { race: T; gap: number }[] {
  const running = races.filter((r) => r.finished_rank == null && r.total_time);
  const leader = running[0];
  if (!leader) return [];
  const leaderTotal = parseSeconds(leader.total_time);
  const leaderLaps = (leader.lap_times ?? []).map(parseSeconds);
  return running.map((race) => {
    if (race === leader) return { race, gap: 0 };
    const n = race.laps_count;
    let gap: number;
    if (n === leader.laps_count) {
      gap = parseSeconds(race.total_time) - leaderTotal;
    } else if (n < leaderLaps.length) {
      gap = parseSeconds(race.total_time) - (leaderTotal - leaderLaps.slice(n).reduce((a, b) => a + b, 0));
    } else {
      gap = (leader.laps_count - n) * lapSeconds;
    }
    return { race, gap: Number.isFinite(gap) ? Math.max(0, gap) : 0 };
  });
}

export interface TimelineItem {
  id: string;
  /** Seconds behind the leader */
  gap: number;
  /** Width the racer's badge takes, in px */
  width: number;
}

export interface TimelinePlacement {
  id: string;
  /** Distance from the right edge of the timeline (the leader's side) to the right edge of the badge, in px */
  offset: number;
  /** The line the badge sits on: 0 is the first line, the next ones are below */
  row: number;
}

/**
 * Places the badges along the timeline: the leader at the right edge, everyone else to the left of it by their gap
 * (the full `width` stands for `seconds`). A badge stays on the line it was on (`rows`, by id) as long as it does not
 * touch another badge there, except a badge from the bottom half, which moves up to the first line of the top half that
 * has room. The others go down the lines like stairs, one line lower than the previous badge, and
 * start at the first line again after the last one when that fits. Whether the stairs collide cannot be known
 * beforehand, so where a badge would touch one on its line an empty line is added directly below the previous badge
 * and the badge takes it, the lines below move down. Lines that stay empty are left out. Items must be sorted by gap,
 * smallest first.
 */
export function layoutTimeline(
  items: TimelineItem[],
  seconds: number,
  width: number,
  rows: ReadonlyMap<string, number> = new Map(),
  spacing = 6,
): TimelinePlacement[] {
  interface Line { reach: number; used: boolean } // the furthest end, from the right edge, of the badges on the line
  const lines: Line[] = [];
  const kept: Line[] = []; // the lines of the previous layout, by their row then
  rows.forEach((row) => {
    while (kept.length <= row) {
      const line = { reach: -Infinity, used: false };
      kept.push(line);
      lines.push(line);
    }
  });
  const placed = items.map((item) => {
    const offset = Math.min(Math.max(width - item.width, 0), (item.gap / seconds) * width);
    return { id: item.id, offset, end: offset + item.width, line: null as Line | null };
  });
  let previous: Line | null = null;
  for (const p of placed) {
    const row = rows.get(p.id) ?? -1;
    const own = kept[row];
    const free = (l: Line) => p.offset >= l.reach + spacing;
    // a racer from the bottom half moves up to the first line of the top half that has room for them
    const top = row * 2 >= kept.length ? kept.slice(0, Math.floor(kept.length / 2)).find(free) : undefined;
    let line: Line;
    if (top) {
      line = top;
    } else if (own && free(own)) {
      line = own;
    } else {
      const next = previous ? lines.indexOf(previous) + 1 : 0;
      const stairs = lines[next < lines.length ? next : 0];
      if (stairs && free(stairs)) {
        line = stairs;
      } else {
        line = { reach: -Infinity, used: false };
        lines.splice(next, 0, line);
      }
    }
    line.reach = Math.max(line.reach, p.end);
    line.used = true;
    p.line = line;
    previous = line;
  }
  const used = lines.filter((l) => l.used);
  return placed.map((p) => ({ id: p.id, offset: p.offset, row: used.indexOf(p.line!) }));
}
