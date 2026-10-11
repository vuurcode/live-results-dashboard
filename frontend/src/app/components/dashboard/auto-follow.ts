import { CompetitorUpdate, ProcessedDistance } from '../../models/data.models';
import { RaceCode } from '../../logic/race-codes';
import { isRecentUpdate } from '../../logic/time.util';

/** Where the followed element lands, as a fraction of the viewport height from the top. */
export const HEAT_ANCHOR = 0.3; // active heat a third of the way down, previous heats still partly visible
export const HEADER_ANCHOR = 0.03; // a small breathing margin above a distance

/** What the follow logic needs from the page around it. */
export interface AutoFollowHost {
  /** Whether the viewer wants the page to follow the live heat. */
  follow(): boolean;
  heatGroups(distance: ProcessedDistance): { label: string; races: (CompetitorUpdate | null)[] }[];
  scrollTo(selector: string, anchorRatio: number): void;
  /** The followed live distance changed (and the page should open it). */
  liveDistanceChanged(distance: ProcessedDistance): void;
}

/** A withdrawn race is loaded up front and says nothing about the timing that is going on. */
export function isWithdrawn(race: CompetitorUpdate): boolean {
  return [race.invalid_reason, ...(race.remark ?? '').split(/\s+/)].some(c => c?.toUpperCase() === RaceCode.Withdrawn);
}

/**
 * Decides where the page scrolls while a match is live. It only ever moves forward: to a later live distance, and
 * within it to a later heat, so a correction in an earlier heat or a flip back to an earlier distance leaves the page alone.
 */
export class AutoFollow {
  private followedDistanceId: string | null = null;
  private followedEventNumber = -1;
  private followKey: string | null = null;
  /** Index of the heat being followed in the live distance. */
  private heatIndex = -1;
  private landedOnLive = false;

  constructor(private readonly host: AutoFollowHost) {}

  /** Forgets everything, e.g. when the page switches to another data set. */
  reset(): void {
    this.followedDistanceId = null;
    this.followedEventNumber = -1;
    this.landedOnLive = false;
    this.restart();
  }

  /** Follows the live heat from scratch, e.g. after the viewer switched following on. */
  restart(): void {
    this.followKey = null;
    this.heatIndex = -1;
  }

  update(distances: ProcessedDistance[]): void {
    const live = distances.find(d => d.isLive);
    if (!live) return;
    if (!this.host.follow()) {
      // without following, the page still lands on the live distance once, when it first shows up
      if (!this.landedOnLive) {
        this.landedOnLive = true;
        this.host.scrollTo(headerSelector(live), HEADER_ANCHOR);
      }
      return;
    }
    if (live.id !== this.followedDistanceId) {
      if (live.eventNumber < this.followedEventNumber) return;
      this.followedDistanceId = live.id;
      this.followedEventNumber = live.eventNumber;
      this.restart();
      this.host.liveDistanceChanged(live);
      this.host.scrollTo(headerSelector(live), HEADER_ANCHOR);
      return;
    }
    this.followWithin(live);
  }

  private followWithin(distance: ProcessedDistance): void {
    let key: string;
    let selector: string;
    let anchor: number;
    if (distance.isMassStart) {
      key = `mass:${distance.id}`;
      selector = `[data-distance-body="${distance.id}"]`;
      anchor = HEADER_ANCHOR;
    } else {
      const groups = this.host.heatGroups(distance);
      const current = groups.reduce(
        (last, g, i) => (g.races.some(r => r != null && !isWithdrawn(r) && isRecentUpdate(r.lastUpdated)) ? i : last), -1);
      if (current === -1 || current < this.heatIndex) return;
      this.heatIndex = current;
      key = `${distance.id}:${groups[current].label}`;
      selector = `[data-distance-id="${distance.id}"][data-heat-label="${groups[current].label}"]`;
      anchor = HEAT_ANCHOR;
    }
    if (key === this.followKey) return;
    this.followKey = key;
    this.host.scrollTo(selector, anchor);
  }
}

function headerSelector(distance: ProcessedDistance): string {
  return `[data-distance-header="${distance.id}"]`;
}
