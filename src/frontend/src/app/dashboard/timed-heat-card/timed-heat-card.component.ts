import { ChangeDetectionStrategy, ChangeDetectorRef, Component, DestroyRef, ElementRef, Input, afterEveryRender, inject } from '@angular/core';
import { BadgeModule } from '@coreui/angular';
import { CompetitorUpdate } from '../../results/data.models';
import { TranslateService, TranslationKey } from '../../i18n/translate.service';
import { parseSeconds, sameHundredths, formatDurationSeconds, truncateLapTime, splitFormattedTime, isRecentUpdate } from '../../results/time.util';
import { isNeverLive, GHOST_HIDING_CODES, NO_TIME_CODES, RaceCode, RECORD_CODES, RECORD_PRIORITY } from '../../results/race-codes';
import { categoryName } from '../../results/category.util';
import { lapBadgeColor } from '../../results/lap-color.util';
import { isTimedFinished, timedStartDegrees, timedFinishAngle, timedRaceComplete, timedPrComparison as timedPrComparisonUtil } from '../../results/heats.util';

/** The usual lane colours by slot, for lanes no competitor has shown a colour for yet. */
const DEFAULT_LANE_ORDER = ['white', 'red', 'yellow', 'blue'];

@Component({
  selector: 'app-timed-heat-card',
  standalone: true,
  imports: [BadgeModule],
  templateUrl: './timed-heat-card.component.html',
  styleUrls: ['./timed-heat-card.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TimedHeatCardComponent {
  protected ts = inject(TranslateService);
  private host = inject<ElementRef<HTMLElement>>(ElementRef);
  private cdr = inject(ChangeDetectorRef);

  @Input({ required: true }) label!: string;
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

  private rawRaces: (CompetitorUpdate | null)[] = [];
  private cappedFor: { raw: (CompetitorUpdate | null)[]; schedule: number[] } | null = null;
  private capped: (CompetitorUpdate | null)[] = [];

  /**
   * The races with their laps limited to the distance's lap schedule. The data source sometimes reports a lap
   * beyond the finish; it has no distance and would count towards the total, so it is dropped.
   */
  @Input({ required: true })
  set races(value: (CompetitorUpdate | null)[]) {
    this.noteLapArrivals(this.rawRaces, value);
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

  /** Must match the duration of the `snakeAround` animation in _shared.scss. */
  private readonly SNAKE_MS = 1400;
  /** Race id → the moment its latest lap arrived; until the snake around that lap has finished the total counts up to the new time. */
  private lapArrivedAt = new Map<string, number>();
  private readonly reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  private tickEnd = 0;

  /** Notes a race whose lap just arrived: its total counts up to the new time while the snake around that lap is drawn. */
  private noteLapArrivals(before: (CompetitorUpdate | null)[], after: (CompetitorUpdate | null)[]): void {
    const total = this.lapSchedule.length;
    if (!total || this.reducedMotion.matches) return;
    for (const race of after) {
      const laps = race?.lap_times?.length ?? 0;
      if (!race || race.invalid_reason || laps > total) continue;
      const earlier = before.find(r => r?.id === race.id);
      if (!earlier || earlier.lap_times.length >= laps) continue;
      this.lapArrivedAt.set(race.id, Date.now());
      this.tickUntil(Date.now() + this.SNAKE_MS);
    }
  }

  /** Renders every frame until the given moment, so the counting totals move smoothly; one loop serves all races. */
  private tickUntil(end: number): void {
    const running = this.tickEnd > Date.now();
    this.tickEnd = end;
    if (running) return;
    const frame = () => {
      this.cdr.markForCheck();
      if (Date.now() < this.tickEnd) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  /** Progress 0..1 of the snake of the latest lap, eased like the animation; 1 when there is none or it has finished. */
  private lapProgress(race: CompetitorUpdate): number {
    const arrived = this.lapArrivedAt.get(race.id);
    if (arrived === undefined) return 1;
    const t = Math.min(1, (Date.now() - arrived) / this.SNAKE_MS);
    return t * t * (3 - 2 * t);
  }

  /** True while the snake around the lap that just arrived is drawing; a lap that was already there when the card was rendered has none. */
  protected snakeFresh(race: CompetitorUpdate): boolean {
    return this.lapProgress(race) < 1;
  }

  /** True while the snake around the final lap is drawing and the total counts up; the result's watermark then waits. */
  protected settling(race: CompetitorUpdate): boolean {
    return (race.lap_times?.length ?? 0) >= this.lapSchedule.length && this.lapProgress(race) < 1;
  }

  /** Laps whose total is shown: all of them, but not yet the final one while its snake is still drawing. */
  protected totalLaps(race: CompetitorUpdate): number {
    const laps = race.lap_times?.length ?? 0;
    return laps >= this.lapSchedule.length && this.lapProgress(race) < 1 ? laps - 1 : laps;
  }

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
  protected totalOnOwnLine(race: CompetitorUpdate): boolean {
    return this.ghostTotalOnOwnLine(Math.max(race.lap_times?.length ?? 0, this.lapSchedule.length));
  }

  /** The same rule for a number of laps; also used for the placeholder of a card without laps. */
  protected ghostTotalOnOwnLine(laps = this.lapSchedule.length): boolean {
    return this.columns > 0 && laps > this.columns - this.TOTAL_COLUMNS;
  }

  protected isRecentUpdate = isRecentUpdate;

  /** How long a new split keeps its green flash; must competition the `flashGreen` duration in dashboard.component.scss. */
  private readonly SPLIT_FLASH_MS = 2000;
  protected isSplitFlashing = (lastUpdated: number | undefined): boolean => isRecentUpdate(lastUpdated, Date.now(), this.SPLIT_FLASH_MS);
  protected splitFormattedTime = splitFormattedTime;
  protected truncateLapTime = truncateLapTime;
  protected isTimedFinished = isTimedFinished;

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
  protected timedCumulativeTime(race: CompetitorUpdate, lapIndex: number): string | null {
    if (!race.lap_times || race.lap_times.length <= lapIndex) return null;
    let total = 0;
    for (let i = 0; i <= lapIndex; i++) {
      total += parseSeconds(race.lap_times[i]);
    }
    return formatDurationSeconds(total);
  }

  /** The category as a name with the gender in front, in the viewer's language: "Women Juniors A1". */
  private categoryFullName(code: string | null): string {
    return categoryName(code, {
      women: this.ts.t('genderWomen'), men: this.ts.t('genderMen'),
      pupils: this.ts.t('categoryPupils'), juniors: this.ts.t('categoryJuniors'), neoSeniors: this.ts.t('categoryNeoSeniors'),
      seniors: this.ts.t('categorySeniors'), masters: this.ts.t('categoryMasters'),
    });
  }

  /** Split a space-separated remark string into individual codes. */
  protected splitRemarks(remark: string | null): string[] {
    if (!remark) return [];
    return remark.trim().split(/\s+/);
  }

  /** Full description for a remark or invalid_reason code, or null if unknown. */
  protected timedLabelTitle(code: string | null): string | null {
    if (!code) return null;
    const key = this.REMARK_KEY_MAP[code.toUpperCase()];
    return key ? this.ts.t(key) : null;
  }

  /** Color variant for a timed card based on invalid_reason/remark values. */
  protected timedCardVariant(race: CompetitorUpdate): 'pr' | 'record' | 'red' | 'orange' | null {
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
  protected watermarkCentered(race: CompetitorUpdate): boolean {
    const codes = [race.invalid_reason, ...this.splitRemarks(race.remark)];
    return codes.some(c => !!c && NO_TIME_CODES.has(c.toUpperCase()));
  }

  /** The live tag goes on the cards of the live heat, except for competitors who did not start or withdrew, and those whose result is in. */
  protected showLive(race: CompetitorUpdate): boolean {
    return this.active && !isNeverLive(race) && !(this.distanceMeters != null && timedRaceComplete(race, this.distanceMeters));
  }

  /** A live card has the live border, unless the card already has a border of its own (a personal best, a record, a fall ...). */
  protected liveBorder(race: CompetitorUpdate): boolean {
    return this.showLive(race) && this.timedCardVariant(race) === null;
  }

  /** True for a race that did not start, was disqualified or withdrew: its placeholder badges are not shown (their room is kept). */
  protected ghostsHidden(race: CompetitorUpdate): boolean {
    const codes = [race.invalid_reason, ...this.splitRemarks(race.remark)];
    return codes.some(c => !!c && GHOST_HIDING_CODES.has(c.toUpperCase()));
  }

  /** Watermark text: invalid_reason takes priority over remark; resolved via label map.
   *  PR remarks are rendered as a DOM overlay instead (returns null).
   *  Records (WR, NR, TR, TRC, in that order) get priority; TRC is a track record that names its category in full on a second line. */
  protected timedWatermarkText(race: CompetitorUpdate): string | null {
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
        return `${label}\n(${this.categoryFullName(race.category)})`;
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
  protected compactTotalTime(race: CompetitorUpdate): string | null {
    if (race.invalid_reason || !race.lap_times?.length) return null;
    const progress = this.lapProgress(race);
    const final = this.timedCumulativeTime(race, race.lap_times.length - 1)!;
    if (progress >= 1) return final;
    // the previous total counts up to the new time by the moment the snake has finished
    const previous = race.lap_times.length > 1 ? parseSeconds(this.timedCumulativeTime(race, race.lap_times.length - 2)!) : 0;
    return formatDurationSeconds(previous + (parseSeconds(final) - previous) * progress);
  }

  /**
   * Decimals of the totals, PB and PB difference on a card: hundredths unless thousandths are switched on, or
   * the finished time and the personal best have the same hundredths (the thousandths settle it).
   */
  protected decimals(race: CompetitorUpdate): 2 | 3 {
    if (this.showThousandths) return 3;
    if (this.distanceMeters == null || !race.personal_record || !race.lap_times?.length || !isTimedFinished(race, this.distanceMeters)) return 2;
    const total = this.timedCumulativeTime(race, race.lap_times.length - 1);
    if (!total) return 2;
    return sameHundredths(total, race.personal_record) ? 3 : 2;
  }

  /** Columns of the wide layout: the lanes of the widest heat in the distance, at most four. */
  protected get laneCount(): number {
    return Math.min(4, Math.max(1, this.maxLanes || this.races.length));
  }

  /** Lane colour of a slot: the competitor's own, else the colour other heats show for it, else the standard order. */
  protected laneColor(race: CompetitorUpdate | null, slot: number): string | null {
    return race?.lane ?? this.laneColors[slot] ?? DEFAULT_LANE_ORDER[slot] ?? null;
  }

  /** Category name and club code for under the name: "Women Juniors A1 (CLF4)", or whichever of the two there is. */
  protected metaLine(race: CompetitorUpdate): string {
    const name = this.categoryFullName(race.category);
    return race.club_code ? (name ? `${name} (${race.club_code})` : race.club_code) : name;
  }

  /** The badges sit beside the name until the race has a code (DNS, PR, ...); then the title gets the room of three lines. */
  protected titleExpanded(race: CompetitorUpdate): boolean {
    return !!race.invalid_reason || this.splitRemarks(race.remark).length > 0;
  }

  /** True when both lanes of a set (white/red = slots 0 and 1, yellow/blue = 2 and 3) have no competitor in this heat. */
  protected laneSetEmpty(slot: number): boolean {
    const first = slot - (slot % 2);
    return !this.races[first] && !this.races[first + 1];
  }

  /** Tooltip of a compact lap badge: three rows - distance, lap time, total time. */
  protected compactBadgeTitle(race: CompetitorUpdate, i: number): string {
    const total = this.timedCumulativeTime(race, i);
    return [
      `${this.ts.t('tooltipDistance')}: ${this.lapSchedule[i]}m`,
      `${this.ts.t('tooltipLapTime')}: ${truncateLapTime(race.lap_times[i], 2)}`,
      `${this.ts.t('tooltipTotalTime')}: ${total ? truncateLapTime(total, this.decimals(race)) : ''}`,
    ].join('\n');
  }

  /** Variance colour class of a compact lap badge, or none when the colours are off. */
  protected compactLapColor(race: CompetitorUpdate, i: number): string {
    if (this.colorLaps && i === 1 && this.firstLapPartial()) return 'lap-badge-normal'; // nothing to compare with
    return this.colorLaps ? lapBadgeColor(race.lap_times, i, this.lapVarianceThreshold) : '';
  }

  /** Laps that have nothing fair to differ from, shown light grey while the diff colours are on: the first lap, and the second when the first is partial. */
  protected noDeltaLap(i: number): boolean {
    return this.colorLaps && (i === 0 || (i === 1 && this.firstLapPartial()));
  }

  /** True when the first lap is shorter than a full 400m lap (a start from the middle of the track): lap 2 has no fair comparison. */
  protected firstLapPartial(): boolean {
    return this.lapSchedule.length > 0 && this.lapSchedule[0] < 400;
  }

  /** Where the finish line is on a lap badge's ring, in degrees clockwise from the top. */
  protected get ringFinish(): string {
    return `${this.distanceMeters == null ? 0 : timedFinishAngle(this.distanceMeters)}deg`;
  }

  /** Share of the ring the snake draws for lap i: the first lap from where the distance starts on the oval, the others all the way round. */
  protected lapFraction(i: number): number {
    if (i > 0 || this.distanceMeters == null) return 1;
    return Math.min(1, timedStartDegrees(this.distanceMeters) / 360);
  }

  /** True once the final lap is done. */
  protected compactDone(race: CompetitorUpdate): boolean {
    return this.distanceMeters != null && isTimedFinished(race, this.distanceMeters) && this.totalLaps(race) === race.lap_times.length;
  }

  /** True once the skater has finished faster than the personal best shown on the card. */
  protected isPbImproved(race: CompetitorUpdate): boolean {
    return !!this.distanceMeters && !!this.timedPrComparison(race, this.distanceMeters)?.faster;
  }

  /** Badge text: the upstream code `PR` is shown as the local term (PB in English, PR in Dutch); other codes are international. */
  protected remarkBadgeText(code: string): string {
    return code === RaceCode.PersonalRecord ? this.ts.t('remarkShortPb') : code;
  }

  /** CSS class for the remark badge (PR and the records → purple, else orange). */
  protected remarkBadgeClass(remark: string): string {
    const v = remark.toUpperCase();
    return (v === RaceCode.PersonalRecord || RECORD_CODES.has(v)) ? 'timed-badge-purple' : 'timed-badge-orange';
  }

  /** CSS class for the invalid_reason badge (DQ → red, else orange). */
  protected invalidBadgeClass(reason: string): string {
    return reason.toUpperCase() === RaceCode.Disqualified ? 'timed-badge-red' : 'timed-badge-orange';
  }

  /**
   * Compares the competitor's total time against their personal best once
   * the final lap of a timed distance is complete. Returns the sign and
   * 3-decimal diff string, or null if comparison is not applicable.
   */
  protected timedPrComparison(race: CompetitorUpdate, distanceMeters: number): { faster: boolean; diff: string } | null {
    return timedPrComparisonUtil(race.personal_record, race.total_time, race, distanceMeters);
  }
}
