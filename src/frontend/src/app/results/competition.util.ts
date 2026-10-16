import type { TodayCompetition } from './data.models';

/** Same charset the backend accepts for a competition id. */
const COMPETITION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Reads `competitionId` from a page query string (e.g. `?competitionId=abc`); null when absent or invalid. */
export function competitionIdFromSearch(search: string): string | null {
  const id = new URLSearchParams(search).get('competitionId');
  return id !== null && COMPETITION_ID_RE.test(id) ? id : null;
}

/** Adds `competitionId` to a WebSocket URL; returns the URL unchanged when there is no id. */
export function withCompetitionId(wsUrl: string, id: string | null): string {
  if (!id) return wsUrl;
  const url = new URL(wsUrl);
  url.searchParams.set('competitionId', id);
  return url.toString();
}

/** Adds where a reconnecting page left off (`epoch` and `lastSeq`), so the backend can send only what it missed. */
export function withResume(wsUrl: string, from: { epoch: string; seq: number } | null): string {
  if (!from) return wsUrl;
  const url = new URL(wsUrl);
  url.searchParams.set('epoch', from.epoch);
  url.searchParams.set('lastSeq', String(from.seq));
  return url.toString();
}

const LAST_VENUE_KEY = 'lastVenueCode';

/** The venue code of the competition that was viewed last; null when there is none or storage is unavailable. */
export function lastViewedVenue(): string | null {
  try { return localStorage.getItem(LAST_VENUE_KEY); } catch { return null; }
}

/** Remembers the venue of the competition being viewed, so a later visit without a competition can start there. */
export function rememberVenue(code: string): void {
  try { localStorage.setItem(LAST_VENUE_KEY, code); } catch { /* storage unavailable: nothing is remembered */ }
}

/** The competition to open for a venue: the live one when several are held there, else the first; null when the venue holds none. */
export function preselectCompetition(competitions: TodayCompetition[], venueCode: string | null): TodayCompetition | null {
  if (!venueCode) return null;
  const atVenue = competitions.filter((c) => c.venue.code === venueCode);
  return atVenue.find((c) => c.live) ?? atVenue[0] ?? null;
}
