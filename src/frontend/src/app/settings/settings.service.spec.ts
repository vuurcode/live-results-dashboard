import { TestBed } from '@angular/core/testing';
import { SettingsService } from './settings.service';

describe('SettingsService', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  const create = () => { TestBed.resetTestingModule(); return TestBed.inject(SettingsService); };

  it('starts with the defaults', () => {
    const s = create();
    expect(s.groupThreshold.value).toBe(2);
    expect(s.maxGroups.value).toBe(4);
    expect(s.lapVariance.value).toBe(5);
    expect(s.lapVarianceIndividual.value).toBe(0.5);
    expect([s.compactColors.value, s.showThousandths.value, s.follow.value]).toEqual([true, false, true]);
  });

  it('keeps what is set across page loads', () => {
    const s = create();
    s.follow.set(false);
    s.showThousandths.set(true);
    s.maxGroups.set(7);
    const reloaded = create();
    expect([reloaded.follow.value, reloaded.showThousandths.value, reloaded.maxGroups.value]).toEqual([false, true, 7]);
  });

  it('clamps what is set', () => {
    const s = create();
    s.groupThreshold.set(99);
    s.maxGroups.set(-3);
    s.lapVariance.set(2.6);
    s.lapVarianceIndividual.set(0.26);
    expect([s.groupThreshold.value, s.maxGroups.value, s.lapVariance.value, s.lapVarianceIndividual.value]).toEqual([10, 0, 3, 0.3]);
  });

  it('falls back to the default for unusable stored values', () => {
    localStorage.setItem('maxGroups', 'many');
    localStorage.setItem('follow', 'maybe');
    const s = create();
    expect([s.maxGroups.value, s.follow.value]).toEqual([4, true]);
  });

  it('tells subscribers about a change', () => {
    const s = create();
    const seen: number[] = [];
    s.groupThreshold.changes$.subscribe(v => seen.push(v));
    s.groupThreshold.set(3);
    expect(seen).toEqual([2, 3]);
  });
});
