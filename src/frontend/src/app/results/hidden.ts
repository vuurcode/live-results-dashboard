/** A page hidden this long stops receiving updates: nobody is looking, so the traffic would be wasted. */
export const HIDDEN_PAUSE_MS = 120_000;

/** A page hidden shorter than this keeps its connection when it comes back; a switch between tabs costs no new replay. */
export const QUICK_RETURN_MS = 10_000;

/** Whether a page that was hidden for `hiddenForMs` needs a fresh connection when it is visible again. */
export function needsReconnect(hiddenForMs: number): boolean {
  return hiddenForMs >= QUICK_RETURN_MS;
}
