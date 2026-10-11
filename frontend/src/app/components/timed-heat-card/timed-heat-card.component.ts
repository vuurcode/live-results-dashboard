import { ChangeDetectionStrategy, ChangeDetectorRef, Component, DestroyRef, ElementRef, Input, afterEveryRender, inject } from '@angular/core';
import { NgClass } from '@angular/common';
import { BadgeModule } from '@coreui/angular';
import { CompetitorUpdate } from '../../models/data.models';
import { TranslateService, TranslationKey } from '../../services/translate.service';
import { parseSeconds, sameHundredths, formatDurationSeconds, truncateLapTime, splitFormattedTime, isRecentUpdate } from '../../logic/time.util';
import { isNeverLive, GHOST_HIDING_CODES, NO_TIME_CODES, RaceCode, RECORD_CODES, RECORD_PRIORITY } from '../../logic/race-codes';
import { categoryName } from '../../logic/category.util';
import { lapBadgeColor } from '../../logic/lap-color.util';
import { isTimedFinished, timedPrComparison as timedPrComparisonUtil } from '../../logic/heats.util';

/** The usual lane colours by slot, for lanes no racer has shown a colour for yet. */
const DEFAULT_LANE_ORDER = ['white', 'red', 'yellow', 'blue'];

@Component({
  selector: 'app-timed-heat-card',
  standalone: true,
  imports: [NgClass, BadgeModule],
  templateUrl: './timed-heat-card.component.html',
  styleUrls: ['./timed-heat-card.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TimedHeatCardComponent {
  @Input({ required: true }) label!: string;
  private rawRaces: (CompetitorUpdate | null)[] = [];
  @Input() maxLanes = 0;
  @Input() laneColors: (string | null)[] = [];
  @Input() lapSchedule: number[] = [];
  @Input() distanceMeters: number | null = null;
  @Input() distanceId = '';
  @Input() active = false;
  /** Colour the compact badges by variance against the previous lap (mass start style). */
  @Input() colorLaps = false;
  /** Always show thousandths; otherwise hundredths, with thousandths only where a PB needs them. */
  @Input() showThousandths = false;
  @Input() lapVarianceThreshold = 0;

  private cappedFor: { raw: (CompetitorUpdate | null)[]; schedule: number[] } | null = null;
  private capped: (CompetitorUpdate | null)[] = [];

  /**
   * The races with their laps limited to the distance's lap schedule. The data source sometimes reports a lap
   * beyond the finish; it has no distance and would count towards the total, so it is dropped.
   */
  @Input({ required: true })
  set races(value: (CompetitorUpdate | null)[]) {
    this.rawRaces = value;
  }
  get races(): (CompetitorUpdate | null)[] {
    if (this.cappedFor?.raw !== this.rawRaces || this.cappedFor.schedule !== this.lapSchedule) {
      const max = this.lapSchedule.length;
      this.capped = max === 0 ? this.rawRaces : this.rawRaces.map(r =>
        r && r.lap_times && r.lap_times.length > max
          ? { ...r, lap_times: r.lap_times.slice(0, max), laps_count: Math.min(r.laps_count, max) }
          : r);
      this.cappedFor = { raw: this.rawRaces, schedule: this.lapSchedule };
    }
    return this.capped;
  }

  public ts = inject(TranslateService);
  private host = inject<ElementRef<HTMLElement>>(ElementRef);
  private cdr = inject(ChangeDetectorRef);

  /** Number of badge columns the compact body currently has (it follows the card width). */
  private columns = 0;
  private observed: Element | null = null;
  private observer: ResizeObserver | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.observer?.disconnect());
    // The grid is only measured when the body appears or is resized, not on every render
    afterEveryRender(() => {
      const body = this.host.nativeElement.querySelector('.timed-compact-body');
      if (!body || body === this.observed) return;
      this.observer ??= new ResizeObserver(() => this.measureColumns());
      if (this.observed) this.observer.unobserve(this.observed);
      this.observer.observe(body); // also reports the first size
      this.observed = body;
    });
  }

  private measureColumns(): void {
    const tracks = this.observed ? getComputedStyle(this.observed).gridTemplateColumns.split(' ').length : 0;
    if (tracks !== this.columns) {
      this.columns = tracks;
      this.cdr.markForCheck();
    }
  }

  /** Columns the total time takes at the end of a row. */
  private readonly TOTAL_COLUMNS = 3;

  /** True when the lap badges (the laps still to come included) leave no room for the total on their row: it then gets a line of its own. */
  totalOnOwnLine(race: CompetitorUpdate): boolean {
    return this.ghostTotalOnOwnLine(Math.max(race.lap_times?.length ?? 0, this.lapSchedule.length));
  }

  /** The same rule for a number of laps; also used for the placeholder of a card without laps. */
  ghostTotalOnOwnLine(laps = this.lapSchedule.length): boolean {
    return this.columns > 0 && laps > this.columns - this.TOTAL_COLUMNS;
  }

  isRecentUpdate = isRecentUpdate;

  /** How long a new split keeps its green flash; must match the `flashGreen` duration in dashboard.component.scss. */
  private readonly SPLIT_FLASH_MS = 2000;
  isSplitFlashing = (lastUpdated: number | undefined): boolean => isRecentUpdate(lastUpdated, Date.now(), this.SPLIT_FLASH_MS);
  splitFormattedTime = splitFormattedTime;
  truncateLapTime = truncateLapTime;
  isTimedFinished = isTimedFinished;

  private readonly REMARK_KEY_MAP: Record<string, TranslationKey> = {
    [RaceCode.PersonalRecord]: 'remarkNewPb',
    [RaceCode.Fall]: 'remarkFall',
    [RaceCode.Disqualified]: 'remarkDisqualified',
    [RaceCode.DidNotStart]: 'remarkDidNotStart',
    [RaceCode.DidNotFinish]: 'remarkDidNotFinish',
    [RaceCode.Withdrawn]: 'remarkWithdrawn',
    [RaceCode.ManualTime]: 'remarkManualTime',
    [RaceCode.WorldRecord]: 'remarkWorldRecord',
    [RaceCode.NationalRecord]: 'remarkNationalRecord',
    [RaceCode.TrackRecord]: 'remarkNewTrackRecord',
    [RaceCode.TrackRecordCourse]: 'remarkTrackRecordCourse',
  };

  /**
   * Returns the cumulative total time up to and including lap `lapIndex` as a
   * formatted string (e.g. "1:23.456"), summing individual split lap_times.
   * Returns null if the lap has not been completed yet.
   */
  timedCumulativeTime(race: CompetitorUpdate, lapIndex: number): string | null {
    if (!race.lap_times || race.lap_times.length <= lapIndex) return null;
    let total = 0;
    for (let i = 0; i <= lapIndex; i++) {
      total += parseSeconds(race.lap_times[i]);
    }
    return formatDurationSeconds(total);
  }

  /** The category as a name with the gender in front, in the viewer's language, followed by its code: "Women Juniors A1 (DA1)". */
  private categoryLabel(code: string | null): string {
    const name = categoryName(code, {
      women: this.ts.t('genderWomen'), men: this.ts.t('genderMen'),
      pupils: this.ts.t('categoryPupils'), juniors: this.ts.t('categoryJuniors'), neoSeniors: this.ts.t('categoryNeoSeniors'),
      seniors: this.ts.t('categorySeniors'), masters: this.ts.t('categoryMasters'),
    });
    const trimmed = code?.trim() ?? '';
    return name === trimmed ? name : `${name} (${trimmed})`;
  }

  /** Split a space-separated remark string into individual codes. */
  splitRemarks(remark: string | null): string[] {
    if (!remark) return [];
    return remark.trim().split(/\s+/);
  }

  /** Full description for a remark or invalid_reason code, or null if unknown. */
  timedLabelTitle(code: string | null): string | null {
    if (!code) return null;
    const key = this.REMARK_KEY_MAP[code.toUpperCase()];
    return key ? this.ts.t(key) : null;
  }

  /** Color variant for a timed card based on invalid_reason/remark values. */
  timedCardVariant(race: CompetitorUpdate): 'pr' | 'record' | 'red' | 'orange' | null {
    if (race.invalid_reason) {
      return race.invalid_reason.toUpperCase() === RaceCode.Disqualified ? 'red' : 'orange';
    }
    if (race.remark) {
      const parts = this.splitRemarks(race.remark).map(v => v.toUpperCase());
      if (parts.some(v => RECORD_CODES.has(v))) return 'record';
      if (parts.some(v => v === RaceCode.PersonalRecord)) return 'pr';
      return 'orange';
    }
    return null;
  }

  /** True when the watermark of this race goes in the middle of the card (no time to show), not in the corner of the title. */
  watermarkCentered(race: CompetitorUpdate): boolean {
    const codes = [race.invalid_reason, ...this.splitRemarks(race.remark)];
    return codes.some(c => !!c && NO_TIME_CODES.has(c.toUpperCase()));
  }

  /** The live tag goes on the cards of the live heat, except for racers who did not start or withdrew. */
  showLive(race: CompetitorUpdate): boolean {
    return this.active && !isNeverLive(race);
  }

  /** True for a race that did not start, was disqualified or withdrew: its placeholder badges are not shown (their room is kept). */
  ghostsHidden(race: CompetitorUpdate): boolean {
    const codes = [race.invalid_reason, ...this.splitRemarks(race.remark)];
    return codes.some(c => !!c && GHOST_HIDING_CODES.has(c.toUpperCase()));
  }

  /** Watermark text: invalid_reason takes priority over remark; resolved via label map.
   *  PR remarks are rendered as a DOM overlay instead (returns null).
   *  Records (WR, NR, TR, TRC, in that order) get priority; TRC appends the category on a second line. */
  timedWatermarkText(race: CompetitorUpdate): string | null {
    if (race.invalid_reason) {
      return this.timedLabelTitle(race.invalid_reason) ?? race.invalid_reason;
    }
    if (!race.remark) return null;
    const parts = this.splitRemarks(race.remark).map(v => v.toUpperCase());
    // PR watermark is rendered as a DOM overlay to support smaller decimal formatting
    if (parts.every(v => v === RaceCode.PersonalRecord)) return null;
    // records come first, the most significant one wins
    const recordCode = RECORD_PRIORITY.find(v => parts.includes(v));
    if (recordCode) {
      const label = this.timedLabelTitle(recordCode) ?? recordCode;
      if (recordCode === RaceCode.TrackRecordCourse && race.category) {
        return `${label}\n${this.categoryLabel(race.category)}`;
      }
      return label;
    }
    // Other non-PR remark
    const firstNonPr = parts.find(v => v !== RaceCode.PersonalRecord);
    if (firstNonPr) {
      return this.timedLabelTitle(firstNonPr) ?? firstNonPr;
    }
    return null;
  }

  /** The total time so far (the final time once finished), shown after the lap badges in compact mode. */
  compactTotalTime(race: CompetitorUpdate): string | null {
    if (race.invalid_reason || !race.lap_times?.length) return null;
    return this.timedCumulativeTime(race, race.lap_times.length - 1);
  }

  /**
   * Decimals of the totals, PB and PB difference on a card: hundredths unless thousandths are switched on, or
   * the finished time and the personal best have the same hundredths (the thousandths settle it).
   */
  decimals(race: CompetitorUpdate): 2 | 3 {
    if (this.showThousandths) return 3;
    if (this.distanceMeters == null || !race.personal_record || !race.lap_times?.length || !isTimedFinished(race, this.distanceMeters)) return 2;
    const total = this.timedCumulativeTime(race, race.lap_times.length - 1);
    if (!total) return 2;
    return sameHundredths(total, race.personal_record) ? 3 : 2;
  }

  /** Lane colour of a slot: the racer's own, else the colour other heats show for it, else the standard order. */
  laneColor(race: CompetitorUpdate | null, slot: number): string | null {
    return race?.lane ?? this.laneColors[slot] ?? DEFAULT_LANE_ORDER[slot] ?? null;
  }

  /** Category and club code for under the name: "DA1 / IFX", or whichever of the two there is. */
  metaLine(race: CompetitorUpdate): string {
    return [this.categoryLabel(race.category), race.club_code].filter(Boolean).join(' / ');
  }

  /** The badges sit beside the name until the race has a code (DNS, PR, ...); then the title gets the room of three lines. */
  titleExpanded(race: CompetitorUpdate): boolean {
    return !!race.invalid_reason || this.splitRemarks(race.remark).length > 0;
  }

  /** True when both lanes of a set (white/red = slots 0 and 1, yellow/blue = 2 and 3) have no racer in this heat. */
  laneSetEmpty(slot: number): boolean {
    const first = slot - (slot % 2);
    return !this.races[first] && !this.races[first + 1];
  }

  /** Tooltip of a compact lap badge: three rows - distance, lap time, total time. */
  compactBadgeTitle(race: CompetitorUpdate, i: number): string {
    const total = this.timedCumulativeTime(race, i);
    return [
      `${this.ts.t('tooltipDistance')}: ${this.lapSchedule[i]}m`,
      `${this.ts.t('tooltipLapTime')}: ${truncateLapTime(race.lap_times[i], 2)}`,
      `${this.ts.t('tooltipTotalTime')}: ${total ? truncateLapTime(total, this.decimals(race)) : ''}`,
    ].join('\n');
  }

  /** Variance colour class of a compact lap badge, or none when the colours are off. */
  compactLapColor(race: CompetitorUpdate, i: number): string {
    if (this.colorLaps && i === 1 && this.firstLapPartial()) return 'lap-badge-normal'; // nothing to compare with
    return this.colorLaps ? lapBadgeColor(race.lap_times, i, this.lapVarianceThreshold) : '';
  }

  /** Laps that have nothing fair to differ from, shown light grey while the diff colours are on: the first lap, and the second when the first is partial. */
  noDeltaLap(i: number): boolean {
    return this.colorLaps && (i === 0 || (i === 1 && this.firstLapPartial()));
  }

  /** True when the first lap is shorter than a full 400m lap (a start from the middle of the track): lap 2 has no fair comparison. */
  firstLapPartial(): boolean {
    return this.lapSchedule.length > 0 && this.lapSchedule[0] < 400;
  }

  /** True once the final lap is done. */
  compactDone(race: CompetitorUpdate): boolean {
    return this.distanceMeters != null && isTimedFinished(race, this.distanceMeters);
  }

  /** True once the skater has finished faster than the personal best shown on the card. */
  isPbImproved(race: CompetitorUpdate): boolean {
    return !!this.distanceMeters && !!this.timedPrComparison(race, this.distanceMeters)?.faster;
  }

  /** Badge text: the upstream code `PR` is shown as the local term (PB in English, PR in Dutch); other codes are international. */
  remarkBadgeText(code: string): string {
    return code === RaceCode.PersonalRecord ? this.ts.t('remarkShortPb') : code;
  }

  /** CSS class for the remark badge (PR and the records → purple, else orange). */
  remarkBadgeClass(remark: string): string {
    const v = remark.toUpperCase();
    return (v === RaceCode.PersonalRecord || RECORD_CODES.has(v)) ? 'timed-badge-purple' : 'timed-badge-orange';
  }

  /** CSS class for the invalid_reason badge (DQ → red, else orange). */
  invalidBadgeClass(reason: string): string {
    return reason.toUpperCase() === RaceCode.Disqualified ? 'timed-badge-red' : 'timed-badge-orange';
  }

  /**
   * Compares the competitor's total time against their personal best once
   * the final lap of a timed distance is complete. Returns the sign and
   * 3-decimal diff string, or null if comparison is not applicable.
   */
  timedPrComparison(race: CompetitorUpdate, distanceMeters: number): { faster: boolean; diff: string } | null {
    return timedPrComparisonUtil(race.personal_record, race.total_time, race, distanceMeters);
  }
}
