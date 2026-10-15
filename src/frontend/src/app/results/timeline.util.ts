import { parseSeconds } from './time.util';

/** The seconds the width of the timeline stands for when no lap time is known yet. */
export const DEFAULT_TIMELINE_SECONDS = 40;

export interface TimelineRacer {
  id: string;
  laps_count: number;
  total_time: string;
  lap_times: string[];
  finished_rank: number | null;
}

/** The slowest lap time seen in the race, which is what the width of the timeline stands for; a default while no lap is timed. */
export function timelineScale(races: TimelineRacer[]): number {
  let slowest = 0;
  for (const r of races) {
    for (const t of r.lap_times ?? []) {
      const s = parseSeconds(t);
      if (Number.isFinite(s) && s > slowest) slowest = s;
    }
  }
  return slowest > 0 ? slowest : DEFAULT_TIMELINE_SECONDS;
}

/**
 * The seconds each unfinished racer is behind the first one: the difference between the times at which they passed the
 * same lap. A racer who is laps down is compared at the lap count they have; when the leader's laps are unknown the gap
 * is the missing laps at `lapSeconds` each. The first racer is the leader (the races are sorted by position).
 */
export function timelineGaps<T extends TimelineRacer>(races: T[], lapSeconds: number): { race: T; gap: number }[] {
  const running = races.filter((r) => r.finished_rank == null && r.total_time);
  const leader = running[0];
  if (!leader) return [];
  const leaderLaps = (leader.lap_times ?? []).map(parseSeconds);
  return running.map((race) => {
    if (race === leader) return { race, gap: 0 };
    const n = race.laps_count;
    let gap: number;
    if (n === leader.laps_count) {
      gap = parseSeconds(race.total_time) - parseSeconds(leader.total_time);
    } else if (n > 0 && leaderLaps.length >= n) {
      gap = parseSeconds(race.total_time) - leaderLaps.slice(0, n).reduce((a, b) => a + b, 0);
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
 * (the full `width` stands for `seconds`; a larger gap sits at the far left). A badge that would touch one on the
 * same line goes to the first line below where it fits. Items must be sorted by gap, smallest first.
 */
export function layoutTimeline(items: TimelineItem[], seconds: number, width: number, spacing = 6): TimelinePlacement[] {
  const rowEnd: number[] = []; // per line: how far the badge furthest from the right edge reaches, measured from the right edge
  return items.map((item) => {
    const offset = Math.min(Math.max(width - item.width, 0), (item.gap / seconds) * width);
    let row = rowEnd.findIndex((end) => offset >= end + spacing);
    if (row < 0) row = rowEnd.length;
    rowEnd[row] = offset + item.width;
    return { id: item.id, offset, row };
  });
}
