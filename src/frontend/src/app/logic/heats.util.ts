import { formatDurationSeconds, parseSeconds } from './time.util';

/**
 * Returns the ordered list of cumulative distances (in metres) at which a lap
 * is expected for a timed distance, derived from first_lap % 400.
 * e.g. distanceMeters=1000 -> [200, 600, 1000]; distanceMeters=100 -> [100]
 */
export function timedDistanceLapSchedule(distanceMeters: number): number[] {
  const firstLap = distanceMeters % 400 || 400;
  const laps: number[] = [firstLap];
  let cumulative = firstLap;
  while (cumulative < distanceMeters) {
    cumulative += 400;
    laps.push(cumulative);
  }
  return laps;
}

/** Total number of expected laps for a timed distance. */
export function timedDistanceTotalLaps(distanceMeters: number): number {
  return timedDistanceLapSchedule(distanceMeters).length;
}

/**
 * Where a timed distance starts on the 400m oval, in degrees back from its finish line (1m = 0.9 degrees; 360 is the
 * finish line itself). Read from the track diagram: the 100m and 500m start 100m before the finish, the 3000m and 5000m
 * 200m, the 1500m 300m. The 1000m starts on the opposite straight and finishes in the middle of the other one, 200m on.
 */
const START_DEGREES: Record<number, number> = { 100: 90, 500: 90, 1000: 180, 1500: 270, 3000: 180, 5000: 180, 10000: 360 };

/** Start of a timed distance in degrees back from its finish; a distance not listed follows from the length of its first lap. */
export function timedStartDegrees(distanceMeters: number): number {
  return START_DEGREES[distanceMeters] ?? ((distanceMeters % 400) || 400) * 0.9;
}

/**
 * Where the finish line is on the oval as drawn on a lap badge, in degrees clockwise from the top: on the bottom straight,
 * right of the middle, like the diagram of the track, except for the 1000m, which finishes in the middle of the bottom straight
 * (180 degrees). A badge is wider than it is high, so its bottom and top edges are the straights and its ends the turns; 135
 * degrees is clear of the right-hand turn (it begins at 117 degrees on a badge twice as wide as it is high, and at 135 only on a
 * square one), and so are the starts that follow from it: 45 degrees (1500m) and 315 degrees (3000m, 5000m) on the top straight, 225 degrees (100m, 500m) on the bottom one,
 * and 0 degrees (1000m). A snake never starts or stops inside a turn.
 */
export function timedFinishAngle(distanceMeters: number): number {
  return distanceMeters === 1000 ? 180 : 135;
}

export interface TimedRace {
  laps_count: number;
  invalid_reason: string | null;
}

/** True when the competitor has completed all laps for the timed distance. */
export function isTimedFinished(race: TimedRace, distanceMeters: number): boolean {
  return race.laps_count >= timedDistanceTotalLaps(distanceMeters);
}

/** True when a timed race counts as complete: all laps done OR has an invalid_reason. */
export function timedRaceComplete(race: TimedRace, distanceMeters: number): boolean {
  return !!race.invalid_reason || isTimedFinished(race, distanceMeters);
}

export interface HeatGroupLike<T> {
  heat: number;
  races: (T | null)[];
}

export interface MergedHeatGroup<T> {
  label: string;
  races: (T | null)[];
}

/**
 * Merges consecutive heats where the first has only white/red lanes (slots
 * 0/1) and the second has only yellow/blue lanes (slots 2/3) into one row
 * labelled via `mergedLabelFor`; non-competitioning heats are labelled individually
 * via `labelFor`.
 */
export function mergeHeatGroups<T>(
  groups: HeatGroupLike<T>[],
  labelFor: (heat: number) => string,
  mergedLabelFor: (a: number, b: number) => string,
): MergedHeatGroup<T>[] {
  const result: MergedHeatGroup<T>[] = [];
  let i = 0;
  while (i < groups.length) {
    const cur = groups[i];
    const curHasWR = cur.races[0] !== null || cur.races[1] !== null;
    const curNoYB = cur.races[2] === null && cur.races[3] === null;
    if (curHasWR && curNoYB && i + 1 < groups.length) {
      const nxt = groups[i + 1];
      const nxtNoWR = nxt.races[0] === null && nxt.races[1] === null;
      const nxtHasYB = nxt.races[2] !== null || nxt.races[3] !== null;
      if (nxtNoWR && nxtHasYB) {
        result.push({
          label: mergedLabelFor(cur.heat, nxt.heat),
          races: [cur.races[0], cur.races[1], nxt.races[2], nxt.races[3]],
        });
        i += 2;
        continue;
      }
    }
    result.push({ label: labelFor(cur.heat), races: cur.races });
    i++;
  }
  return result;
}

/** Removes trailing null slots from a races array. */
export function trimmedRaces<T>(races: (T | null)[]): (T | null)[] {
  let last = races.length - 1;
  while (last >= 0 && races[last] === null) last--;
  return races.slice(0, last + 1);
}

/** Lane color per slot index, derived from any non-null race across all heat groups. */
export function heatGroupLaneColors<T extends { lane: string }>(
  groups: MergedHeatGroup<T>[],
): (string | null)[] {
  const colors: (string | null)[] = [];
  for (const group of groups) {
    group.races.forEach((race, i) => {
      if (race && !colors[i]) colors[i] = race.lane;
    });
  }
  return colors;
}

/**
 * Compares the competitor's total time against their personal best once the
 * final lap of a timed distance is complete. Returns the sign (`faster` when
 * the current time beats the PR) and a 3-decimal absolute diff string, or
 * null if comparison is not applicable.
 */
export function timedPrComparison(
  personalRecord: string | null,
  totalTime: string,
  race: TimedRace,
  distanceMeters: number,
): { faster: boolean; diff: string } | null {
  if (!personalRecord || !totalTime || !isTimedFinished(race, distanceMeters)) return null;
  const prSecs = parseSeconds(personalRecord);
  const totalSecs = parseSeconds(totalTime);
  const diff = Math.abs(prSecs - totalSecs);
  return { faster: totalSecs < prSecs, diff: diff.toFixed(3) };
}

/**
 * Returns a formatted "+SS.mmm" or "+M:SS.mmm" gap string for a finished
 * mass-start competitor vs the race winner, or null if they ARE the winner,
 * not yet finished, or a comparison isn't possible.
 */
export function massFinishGapFromLeader(
  finishedRank: number | null,
  totalTime: string,
  leaderTotalTime: string | null | undefined,
): string | null {
  if (finishedRank == null || finishedRank === 1) return null;
  if (!leaderTotalTime || !totalTime) return null;
  const diff = parseSeconds(totalTime) - parseSeconds(leaderTotalTime);
  if (diff <= 0) return null;
  return `+${formatDurationSeconds(diff)}`;
}

/** Number of pending (not-yet-completed) laps for a mass-start competitor. */
export function pendingLapCount(lapTimesLength: number, totalLaps: number): number {
  return Math.max(0, totalLaps - lapTimesLength);
}
