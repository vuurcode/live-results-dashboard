import { describe, it, expect } from 'vitest';
import {
  parseSeconds,
  timeDiffSeconds,
  formatDurationSeconds,
  truncateLapTime,
  splitLapTime,
  splitFormattedTime,
  isRecentUpdate,
} from './time.util';

describe('parseSeconds', () => {
  it('parses bare seconds', () => {
    expect(parseSeconds('23.456')).toBeCloseTo(23.456);
  });

  it('parses MM:SS.mmm', () => {
    expect(parseSeconds('1:23.456')).toBeCloseTo(83.456);
  });

  it('parses H:MM:SS.mmm', () => {
    expect(parseSeconds('1:02:03.456')).toBeCloseTo(3723.456);
  });

  it('handles values crossing 10 minutes without lexicographic misordering', () => {
    // Regression case mirroring the backend total_time bug: "10:15.000" is
    // numerically greater than "9:45.000" despite sorting earlier as a string.
    expect(parseSeconds('10:15.000')).toBeGreaterThan(parseSeconds('9:45.000'));
  });
});

describe('timeDiffSeconds', () => {
  it('returns the absolute difference', () => {
    expect(timeDiffSeconds('10.000', '12.500')).toBeCloseTo(2.5);
    expect(timeDiffSeconds('12.500', '10.000')).toBeCloseTo(2.5);
  });

  it('returns a large sentinel when either side is empty', () => {
    expect(timeDiffSeconds('', '10.000')).toBe(9999);
    expect(timeDiffSeconds('10.000', '')).toBe(9999);
  });
});

describe('formatDurationSeconds', () => {
  it('formats sub-minute durations without a minutes component', () => {
    expect(formatDurationSeconds(23.4567)).toBe('23.456');
  });

  it('formats minute-scale durations', () => {
    expect(formatDurationSeconds(83.4)).toBe('1:23.400');
  });

  it('formats hour-scale durations', () => {
    expect(formatDurationSeconds(3723.001)).toBe('1:02:03.001');
  });
});

describe('truncateLapTime', () => {
  it('truncates without rounding', () => {
    expect(truncateLapTime('23.456', 1)).toBe('23.4');
    expect(truncateLapTime('1:23.456', 1)).toBe('1:23.4');
  });

  it('does not round up even when the next digit is 9', () => {
    expect(truncateLapTime('23.499', 1)).toBe('23.4');
  });

  it('returns the input unchanged when there is no decimal point', () => {
    expect(truncateLapTime('23', 1)).toBe('23');
  });

  it('returns falsy input unchanged', () => {
    expect(truncateLapTime('', 1)).toBe('');
  });
});

describe('splitLapTime', () => {
  it('splits integer and decimal parts at 1 decimal', () => {
    expect(splitLapTime('1:23.456')).toEqual(['1:23', '.4']);
  });

  it('returns an empty decimal part when there is no dot', () => {
    expect(splitLapTime('23')).toEqual(['23', '']);
  });
});

describe('splitFormattedTime', () => {
  it('splits without truncating', () => {
    expect(splitFormattedTime('1:23.456')).toEqual(['1:23', '.456']);
  });

  it('returns an empty decimal part when there is no dot', () => {
    expect(splitFormattedTime('23')).toEqual(['23', '']);
  });

  it('returns two empty strings for falsy input', () => {
    expect(splitFormattedTime('')).toEqual(['', '']);
  });
});

describe('isRecentUpdate', () => {
  it('honours a custom window', () => {
    expect(isRecentUpdate(1000, 2500, 2000)).toBe(true);
    expect(isRecentUpdate(1000, 3000, 2000)).toBe(false);
  });

  it('is true within the last second', () => {
    expect(isRecentUpdate(1000, 1500)).toBe(true);
  });

  it('is false at or beyond one second', () => {
    expect(isRecentUpdate(1000, 2000)).toBe(false);
  });

  it('is false for an undefined timestamp', () => {
    expect(isRecentUpdate(undefined, 1000)).toBe(false);
  });
});
