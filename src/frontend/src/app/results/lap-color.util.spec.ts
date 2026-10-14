import { describe, it, expect } from 'vitest';
import { lapBadgeColor } from './lap-color.util';

describe('lapBadgeColor', () => {
  const laps = ['30.0', '31.6', '28.4', '30.0'];
  it('is normal for the first lap', () => expect(lapBadgeColor(laps, 0, 5)).toBe('lap-badge-normal'));
  it('is slow beyond the threshold', () => expect(lapBadgeColor(laps, 1, 5)).toBe('lap-badge-slow'));
  it('is fast beyond the threshold', () => expect(lapBadgeColor(laps, 2, 5)).toBe('lap-badge-fast'));
  it('is normal within the threshold', () => expect(lapBadgeColor(laps, 3, 10)).toBe('lap-badge-normal'));
});
