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
