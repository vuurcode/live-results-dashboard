import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import type { ColorSchemeChoice } from '../color-scheme';

/**
 * One viewer setting: a value that survives page loads in localStorage (when that is available).
 * `parse` turns the stored text into a value, or undefined when it is unusable; `normalize` clamps what is set.
 */
export class Setting<T> {
  private readonly subject: BehaviorSubject<T>;
  readonly changes$: Observable<T>;

  constructor(
    private readonly key: string,
    private readonly fallback: T,
    private readonly parse: (stored: string) => T | undefined,
    private readonly normalize: (value: T) => T = (v) => v,
  ) {
    this.subject = new BehaviorSubject<T>(this.load());
    this.changes$ = this.subject.asObservable();
  }

  get value(): T { return this.subject.value; }

  set(value: T): void {
    const next = this.normalize(value);
    this.subject.next(next);
    try { localStorage.setItem(this.key, String(next)); } catch { /* storage unavailable: the setting lasts for this page */ }
  }

  private load(): T {
    try {
      const stored = localStorage.getItem(this.key);
      if (stored !== null) {
        const parsed = this.parse(stored);
        if (parsed !== undefined) return this.normalize(parsed);
      }
    } catch { /* storage unavailable: the default applies */ }
    return this.fallback;
  }
}

/** The number in a text, or undefined when it holds none. */
export function parseNumber(text: string): number | undefined {
  const n = text.trim() === '' ? NaN : Number(text);
  return isNaN(n) ? undefined : n;
}

/** The whole number in a text (a fraction is cut off), or undefined when it holds none. */
export function parseInteger(text: string): number | undefined {
  const n = parseNumber(text);
  return n === undefined ? undefined : Math.trunc(n);
}

function parseFlag(text: string): boolean | undefined {
  return text === 'true' ? true : text === 'false' ? false : undefined;
}

export const MAX_GROUP_THRESHOLD = 10;

/** Dark theme: follow the browser's preference, or force it on (`dark`) or off (`light`). */

function parseColorScheme(text: string): ColorSchemeChoice | undefined {
  return text === 'auto' || text === 'light' || text === 'dark' ? text : undefined;
}

/** Shared with the code that sets the theme before the app starts, so the page never shows the wrong theme first. */
export const colorSchemeSetting = new Setting<ColorSchemeChoice>('colorScheme', 'auto', parseColorScheme);

/** The display settings of the viewer. Add a setting here as one `Setting` and bind it in the settings panel. */
@Injectable({ providedIn: 'root' })
export class SettingsService {
  /** Seconds between two mass start laps for them to be in the same group. */
  readonly groupThreshold = new Setting('groupThresholdSec', 2, parseNumber, (v) => Math.min(MAX_GROUP_THRESHOLD, Math.max(0, v)));
  /** The most groups a mass start shows; later ones are merged into a tail group. 0 shows none. */
  readonly maxGroups = new Setting('maxGroups', 4, parseInteger, (v) => Math.max(0, Math.round(v)));
  /** Percentage a mass start lap may differ from the previous before its badge changes colour. */
  readonly lapVariance = new Setting('lapVariancePct', 5, parseInteger, (v) => Math.max(0, Math.round(v)));
  /** Long track has its own threshold: its laps are far more even, so it takes one decimal. */
  // the storage key stays as saved by earlier visits
  readonly lapVarianceIndividual = new Setting('lapVariancePctTimed', 0.5, parseNumber, (v) => Math.max(0, Math.round(v * 10) / 10));
  /** Compact long track badges coloured by variance against the previous lap, like mass start. */
  readonly compactColors = new Setting('compactColors', true, parseFlag);
  /** Times show thousandths; hundredths when off. */
  readonly showThousandths = new Setting('thousandths', true, parseFlag);
  readonly colorScheme = colorSchemeSetting;
  /** Whether things move: laps drawn and counted up, flashes, reordering, folding and scrolling. Off shows every change at once. */
  readonly animations = new Setting('animations', true, parseFlag);
  /** Whether the page scrolls along with the live heat. */
  readonly follow = new Setting('follow', true, parseFlag);
}
