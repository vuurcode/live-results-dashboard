import { describe, expect, it } from 'vitest';
import { competitionIdFromSearch, withCompetitionId } from './competition.util';

describe('competitionIdFromSearch', () => {
  it('reads a valid id', () => {
    expect(competitionIdFromSearch('?competitionId=ef65e2c6-0424-4e16-8b25-2a76f246e1aa')).toBe(
      'ef65e2c6-0424-4e16-8b25-2a76f246e1aa',
    );
    expect(competitionIdFromSearch('?x=1&competitionId=2026-03-01')).toBe('2026-03-01');
  });

  it('returns null when absent or invalid', () => {
    expect(competitionIdFromSearch('')).toBeNull();
    expect(competitionIdFromSearch('?competitionId=')).toBeNull();
    expect(competitionIdFromSearch('?competitionId=a/b')).toBeNull();
    expect(competitionIdFromSearch('?competitionId=a.b')).toBeNull();
    expect(competitionIdFromSearch('?competitionId=' + 'x'.repeat(65))).toBeNull();
  });
});

describe('withCompetitionId', () => {
  it('adds the id as a query parameter', () => {
    expect(withCompetitionId('ws://localhost:4200/ws', 'abc')).toBe(
      'ws://localhost:4200/ws?competitionId=abc',
    );
  });

  it('leaves the url alone without an id', () => {
    expect(withCompetitionId('wss://host/ws', null)).toBe('wss://host/ws');
  });
});
