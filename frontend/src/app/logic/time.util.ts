/**
 * Parses a race time string ("SS.mmm", "MM:SS.mmm", or "H:MM:SS.mmm") into seconds.
 */
export function parseSeconds(t: string): number {
  const parts = t.split(':');
  if (parts.length === 3) return +parts[0] * 3600 + +parts[1] * 60 + parseFloat(parts[2]);
  if (parts.length === 2) return +parts[0] * 60 + parseFloat(parts[1]);
  return parseFloat(parts[0]);
}

/** Absolute time difference in seconds between two formatted time strings. */
export function timeDiffSeconds(a: string, b: string): number {
  if (!a || !b) return 9999;
  return Math.abs(parseSeconds(a) - parseSeconds(b));
}

/**
 * Formats a duration given in seconds as "SS.mmm", "M:SS.mmm", or "H:MM:SS.mmm"
 * (hours/minutes omitted when zero), truncated to 3 decimal places.
 */
export function formatDurationSeconds(totalSeconds: number): string {
  const totalMs = Math.floor(totalSeconds * 1000);
  const ms = totalMs % 1000;
  const secs = Math.floor(totalMs / 1000) % 60;
  const mins = Math.floor(totalMs / 60000) % 60;
  const hrs = Math.floor(totalMs / 3600000);
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const msPart = String(ms).padStart(3, '0');
  if (hrs > 0) return `${hrs}:${pad2(mins)}:${pad2(secs)}.${msPart}`;
  if (mins > 0) return `${mins}:${pad2(secs)}.${msPart}`;
  return `${secs}.${msPart}`;
}

/**
 * Truncates (not rounds) a formatted lap/total time string to `decimals` decimal places.
 * e.g. truncateLapTime("23.456", 1) -> "23.4"
 */
export function truncateLapTime(t: string, decimals = 1): string {
  if (!t) return t;
  const dot = t.lastIndexOf('.');
  if (dot === -1) return t;
  return t.substring(0, dot + 1 + decimals);
}

/**
 * Like truncateLapTime but returns [integerPart, decimalPart] for split rendering.
 * e.g. "1:23.456" -> ["1:23", ".4"]
 */
export function splitLapTime(t: string): [string, string] {
  return splitFormattedTime(truncateLapTime(t, 1));
}

/**
 * Splits an already-formatted time string into [integerPart, decimalPart]
 * without truncating, e.g. "1:23.456" -> ["1:23", ".456"].
 */
export function splitFormattedTime(t: string): [string, string] {
  if (!t) return ['', ''];
  const dot = t.indexOf('.');
  if (dot === -1) return [t, ''];
  return [t.substring(0, dot), '.' + t.substring(dot + 1)];
}

/** True when a timestamp is within the last `windowMs` (default one second), used to trigger flash-update styling. */
export function isRecentUpdate(timestamp: number | undefined, now = Date.now(), windowMs = 1000): boolean {
  if (!timestamp) return false;
  return now - timestamp < windowMs;
}

/**
 * True when two times have the same hundredths, so only the thousandths can tell them apart
 * (e.g. a finish time against a personal best). Skating truncates rather than rounds.
 */
export function sameHundredths(a: string, b: string): boolean {
  const hundredths = (t: string) => Math.floor(parseSeconds(t) * 100 + 1e-6);
  return hundredths(a) === hundredths(b);
}
