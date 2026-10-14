import { parseSeconds } from './time.util';

export type LapBadgeColor = 'lap-badge-normal' | 'lap-badge-slow' | 'lap-badge-fast';

/**
 * Colour class for lap `i`, by its variance against the previous lap.
 * First lap, or an unusable previous lap: normal (green). More than `thresholdPct` percent slower: slow
 * (orange); more than `thresholdPct` percent faster: fast (purple); otherwise normal.
 */
export function lapBadgeColor(lapTimes: string[], i: number, thresholdPct: number): LapBadgeColor {
  if (i === 0 || !lapTimes[i - 1]) return 'lap-badge-normal';
  const prev = parseSeconds(lapTimes[i - 1]);
  if (!prev) return 'lap-badge-normal';
  const ratio = (parseSeconds(lapTimes[i]) - prev) / prev;
  const threshold = thresholdPct / 100;
  if (ratio > threshold) return 'lap-badge-slow';
  if (ratio < -threshold) return 'lap-badge-fast';
  return 'lap-badge-normal';
}
