/** The first wait before reconnecting, and the longest one while the backend stays unreachable. */
export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 30_000;

/**
 * How long to wait before the next reconnect attempt: doubling from RECONNECT_BASE_MS for every attempt in a row, up to
 * RECONNECT_MAX_MS. The jitter (a factor in [0.5, 1.5)) keeps viewers from reconnecting in step after a backend restart.
 */
export function reconnectDelay(attempt: number, jitter: number): number {
  const exponential = Math.min(RECONNECT_BASE_MS * 2 ** Math.max(0, attempt), RECONNECT_MAX_MS);
  return Math.round(exponential * jitter);
}

export function randomJitter(): number {
  return 0.5 + Math.random();
}
