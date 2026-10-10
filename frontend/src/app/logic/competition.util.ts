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
