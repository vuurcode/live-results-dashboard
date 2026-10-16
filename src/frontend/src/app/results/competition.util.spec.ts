import { describe, expect, it } from 'vitest';
import type { TodayCompetition } from './data.models';
import { competitionIdFromSearch, preselectCompetition, withCompetitionId, withResume } from './competition.util';

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

describe('withResume', () => {
  it('adds where the page left off', () => {
    expect(withResume('ws://h/ws?competitionId=abc', { epoch: 'e1', seq: 42 })).toBe(
      'ws://h/ws?competitionId=abc&epoch=e1&lastSeq=42',
    );
  });

  it('leaves the url alone for a page that has seen nothing', () => {
    expect(withResume('ws://h/ws', null)).toBe('ws://h/ws');
  });
});

describe('preselectCompetition', () => {
  const at = (id: string, venue: string, live: boolean) => ({ id, live, venue: { code: venue } }) as TodayCompetition;

  it('takes the live competition of the venue', () => {
    expect(preselectCompetition([at('a', 'V1', false), at('b', 'V1', true), at('c', 'V2', true)], 'V1')?.id).toBe('b');
  });

  it('takes the first competition of the venue when none is live', () => {
    expect(preselectCompetition([at('a', 'V2', false), at('b', 'V1', false), at('c', 'V1', false)], 'V1')?.id).toBe('b');
  });

  it('takes nothing without a remembered venue or a competition there', () => {
    expect(preselectCompetition([at('a', 'V1', true)], null)).toBeNull();
    expect(preselectCompetition([at('a', 'V1', true)], 'V2')).toBeNull();
  });
});
