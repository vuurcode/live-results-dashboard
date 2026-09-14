import { timeDiffSeconds, parseSeconds } from './time.util';

export const LANE_ORDER: Record<string, number> = { white: 0, red: 1, yellow: 2, blue: 3 };
export const LANE_ORDER_KEYS = Object.keys(LANE_ORDER);

export interface PositionedCompetitor {
  laps_count: number;
  total_time: string;
  position: number;
  position_change: 'up' | 'down' | null;
}

/**
 * Sorts competitors (laps desc, total_time asc, no-time last) and assigns
 * `position` + `position_change` on each element **in place** (mutating the
 * given objects, not copies) — callers rely on stable object identity for
 * Angular's row-flash / reorder animations. Returns the sorted array.
 */
export function recomputePositions<T extends PositionedCompetitor>(competitors: T[]): T[] {
  const all = [...competitors];
  all.sort((a, b) => {
    if (b.laps_count !== a.laps_count) return b.laps_count - a.laps_count;
    if (!a.total_time && !b.total_time) return 0;
    if (!a.total_time) return 1;
    if (!b.total_time) return -1;
    return parseSeconds(a.total_time) - parseSeconds(b.total_time);
  });
  all.forEach((r, i) => {
    const newPos = i + 1;
    if (r.position && r.position !== newPos) {
      r.position_change = newPos < r.position ? 'up' : 'down';
    } else {
      r.position_change = null;
    }
    r.position = newPos;
  });
  return all;
}

export interface GroupableCompetitor {
  laps_count: number;
  total_time: string;
  formatted_total_time: string;
  finished_rank: number | null;
  group_number?: number | null;
  gap_to_above?: string | null;
}

export interface StandingsGroupResult<T> {
  groupNumber: number;
  laps: number;
  leaderTime: string | null;
  gapToGroupAhead: string | null;
  timeBehindLeader: string | null;
  isLastGroup: boolean;
  isOthers: boolean;
  races: T[];
}

/**
 * Groups unfinished competitors by lap count + time-within-threshold,
 * assigning group_number and gap_to_above on each competitor in place
 * (same identity-preservation rationale as recomputePositions), and folds
 * any groups beyond `maxGroups` into a synthetic tail/"others" group.
 *
 * `lapUnit(n)` must return the translated singular/plural unit word for a
 * lap-count difference (e.g. "lap" / "laps") — the numeric prefix is added
 * by this function.
 */
export function recomputeGroups<T extends GroupableCompetitor>(
  processedRaces: T[],
  threshold: number,
  maxGroups: number,
  lapUnit: (n: number) => string,
): StandingsGroupResult<T>[] {
  processedRaces.forEach((r) => {
    r.group_number = null;
    r.gap_to_above = null;
  });

  if (maxGroups === 0) return [];

  const unfinished = processedRaces.filter((r) => r.finished_rank == null && r.total_time);

  const groups: { laps: number; races: T[] }[] = [];
  let cur: { laps: number; races: T[] } | null = null;

  for (const r of unfinished) {
    if (!cur) {
      cur = { laps: r.laps_count, races: [r] };
      groups.push(cur);
    } else if (
      r.laps_count === cur.laps &&
      timeDiffSeconds(cur.races[cur.races.length - 1].total_time, r.total_time) <= threshold
    ) {
      cur.races.push(r);
    } else {
      cur = { laps: r.laps_count, races: [r] };
      groups.push(cur);
    }
  }

  const leaderTime = groups[0]?.races[0]?.total_time ?? null;

  let standingsGroups: StandingsGroupResult<T>[] = groups.map((group, gi) => {
    const gnum = gi + 1;
    group.races.forEach((r, ri) => {
      r.group_number = gnum;
      if (ri === 0) {
        r.gap_to_above = null;
      } else {
        const leader = group.races[0];
        const lapDiff = leader.laps_count - r.laps_count;
        if (lapDiff > 0 || !r.total_time || !leader.total_time) {
          const diff = lapDiff > 0 ? lapDiff : 1;
          r.gap_to_above = `+${diff} ${lapUnit(diff)}`;
        } else {
          r.gap_to_above = `+${timeDiffSeconds(leader.total_time, r.total_time).toFixed(3)}s`;
        }
      }
    });

    const first = group.races[0];
    let gapToGroupAhead: string | null = null;
    let timeBehindLeader: string | null = null;

    if (gi > 0) {
      const prevGroup = groups[gi - 1];
      const prevLast = prevGroup.races[prevGroup.races.length - 1];
      const lapDiff = groups[0].laps - group.laps;
      if (lapDiff > 0) {
        gapToGroupAhead = `+${lapDiff} ${lapUnit(lapDiff)}`;
      } else if (prevLast.total_time && first.total_time) {
        gapToGroupAhead = `+${timeDiffSeconds(prevLast.total_time, first.total_time).toFixed(3)}s`;
      }
      if (leaderTime && first.total_time) {
        timeBehindLeader = `+${timeDiffSeconds(leaderTime, first.total_time).toFixed(3)}s`;
      }
    }

    return {
      groupNumber: gnum,
      laps: group.laps,
      leaderTime: first.total_time ? first.formatted_total_time : null,
      gapToGroupAhead,
      timeBehindLeader,
      isLastGroup: false,
      isOthers: false,
      races: group.races,
    };
  });

  if (standingsGroups.length > 0) {
    standingsGroups[standingsGroups.length - 1].isLastGroup = true;
  }

  if (maxGroups > 0 && standingsGroups.length > maxGroups) {
    const overflowGroups = standingsGroups.slice(maxGroups);
    const othersRaces = overflowGroups.flatMap((g) => g.races);
    standingsGroups = standingsGroups.slice(0, maxGroups);
    standingsGroups[standingsGroups.length - 1].isLastGroup = false;

    const othersLeader = othersRaces[0];
    othersRaces.forEach((r, ri) => {
      if (ri === 0) {
        r.gap_to_above = null;
      } else {
        const lapDiff = (othersLeader?.laps_count ?? 0) - r.laps_count;
        if (lapDiff > 0) {
          r.gap_to_above = `+${lapDiff} ${lapUnit(lapDiff)}`;
        } else if (othersLeader?.total_time && r.total_time) {
          r.gap_to_above = `+${timeDiffSeconds(othersLeader.total_time, r.total_time).toFixed(3)}s`;
        } else {
          r.gap_to_above = null;
        }
      }
    });

    const headLaps = groups[0]?.laps ?? 0;
    const tailLaps = othersRaces[0]?.laps_count ?? 0;
    const tailLapDiff = headLaps - tailLaps;
    const tailGap = tailLapDiff >= 1 ? `+${tailLapDiff} ${lapUnit(tailLapDiff)}` : null;

    standingsGroups.push({
      groupNumber: maxGroups + 1,
      laps: tailLaps,
      leaderTime: null,
      gapToGroupAhead: tailGap,
      timeBehindLeader: null,
      isLastGroup: true,
      isOthers: true,
      races: othersRaces,
    });
  }

  return standingsGroups;
}

/**
 * Resolves a list of race ids into competitor objects via `competitorMap`.
 * When `pinnedByLane` is true, returns a fixed-length array with one slot per
 * LANE_ORDER_KEYS entry (white/red/yellow/blue), `null` where a lane is
 * absent, plus any competitors whose lane isn't in LANE_ORDER appended after.
 */
export function resolveRaces<T extends { lane?: string | null }>(
  ids: string[],
  competitorMap: Map<string, T> | undefined,
  pinnedByLane = false,
): (T | null)[] {
  if (!competitorMap) return pinnedByLane ? Array(LANE_ORDER_KEYS.length).fill(null) : [];
  const resolved = ids.map((id) => competitorMap.get(id)).filter((c): c is T => !!c);
  if (!pinnedByLane) return resolved;
  const slots: (T | null)[] = LANE_ORDER_KEYS.map(
    (lane) => resolved.find((c) => c.lane?.toLowerCase() === lane) ?? null,
  );
  const extra = resolved.filter((c) => !(c.lane?.toLowerCase() as string in LANE_ORDER));
  return [...slots, ...extra];
}
