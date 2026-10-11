import { ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, Input, afterEveryRender, inject } from '@angular/core';
import { NgClass } from '@angular/common';
import { BadgeModule } from '@coreui/angular';
import { CompetitorUpdate } from '../../models/data.models';
import { TranslateService, TranslationKey } from '../../services/translate.service';
import { parseSeconds, sameHundredths, formatDurationSeconds, truncateLapTime, splitFormattedTime, isRecentUpdate } from '../../logic/time.util';
import { lapBadgeColor } from '../../logic/lap-color.util';
import { isTimedFinished, timedPrComparison as timedPrComparisonUtil } from '../../logic/heats.util';

@Component({
  selector: 'app-timed-heat-card',
  standalone: true,
  imports: [NgClass, BadgeModule],
  templateUrl: './timed-heat-card.component.html',
  styleUrls: ['../dashboard/dashboard.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TimedHeatCardComponent {
  @Input({ required: true }) label!: string;
  @Input({ required: true }) races!: (CompetitorUpdate | null)[];
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

  public ts = inject(TranslateService);
  private host = inject<ElementRef<HTMLElement>>(ElementRef);
  private cdr = inject(ChangeDetectorRef);

  /** Number of badge columns the compact body currently has (it follows the card width). */
  private columns = 0;

  constructor() {
    afterEveryRender(() => {
      const body = this.host.nativeElement.querySelector('.timed-compact-body');
      const tracks = body ? getComputedStyle(body).gridTemplateColumns.split(' ').length : 0;
      if (tracks !== this.columns) {
        this.columns = tracks;
        this.cdr.markForCheck();
      }
    });
  }

  /** True when the lap badges fill at least a whole row: the total time then gets a line of its own. */
  totalOnOwnLine(race: CompetitorUpdate): boolean {
    return this.columns > 0 && (race.lap_times?.length ?? 0) >= this.columns;
  }

  isRecentUpdate = isRecentUpdate;

  /** How long a new split keeps its green flash; must match the `flashGreen` duration in dashboard.component.scss. */
  private readonly SPLIT_FLASH_MS = 2000;
  isSplitFlashing = (lastUpdated: number | undefined): boolean => isRecentUpdate(lastUpdated, Date.now(), this.SPLIT_FLASH_MS);
  splitFormattedTime = splitFormattedTime;
  truncateLapTime = truncateLapTime;
  isTimedFinished = isTimedFinished;

  private readonly REMARK_KEY_MAP: Record<string, TranslationKey> = {
    PR:  'remarkNewPb',
    FL:  'remarkFall',
    DQ:  'remarkDisqualified',
    DNS: 'remarkDidNotStart',
    DNF: 'remarkDidNotFinish',
    WDR: 'remarkWithdrawn',
    TR:  'remarkNewTrackRecord',
    TRC: 'remarkTrackRecordCourse',
  };

  /**
   * Returns the lapTime string for the nth lap (0-based) of a timed competitor,
   * or null if that lap has not been completed yet.
   */
  timedLapTime(race: CompetitorUpdate, lapIndex: number): string | null {
    return race.lap_times?.[lapIndex] ?? null;
  }

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
  timedCardColor(race: CompetitorUpdate): 'pr' | 'trc' | 'red' | 'orange' | null {
    if (race.invalid_reason) {
      return race.invalid_reason.toUpperCase() === 'DQ' ? 'red' : 'orange';
    }
    if (race.remark) {
      const parts = this.splitRemarks(race.remark).map(v => v.toUpperCase());
      if (parts.some(v => v === 'TR' || v === 'TRC')) return 'trc';
      if (parts.some(v => v === 'PR')) return 'pr';
      return 'orange';
    }
    return null;
  }

  /** Watermark text: invalid_reason takes priority over remark; resolved via label map.
   *  PR remarks are rendered as a DOM overlay instead (returns null).
   *  TR/TRC get priority; TRC appends the category on a second line. */
  timedWatermarkText(race: CompetitorUpdate): string | null {
    if (race.invalid_reason) {
      return this.timedLabelTitle(race.invalid_reason) ?? race.invalid_reason;
    }
    if (!race.remark) return null;
    const parts = this.splitRemarks(race.remark).map(v => v.toUpperCase());
    // PR watermark is rendered as a DOM overlay to support smaller decimal formatting
    if (parts.every(v => v === 'PR')) return null;
    // TR/TRC get dedicated watermark treatment
    const trcCode = parts.find(v => v === 'TR' || v === 'TRC');
    if (trcCode) {
      const label = this.timedLabelTitle(trcCode) ?? trcCode;
      if (trcCode === 'TRC' && race.category) {
        return `${label}\n${race.category}`;
      }
      return label;
    }
    // Other non-PR remark
    const firstNonPr = parts.find(v => v !== 'PR');
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
    return race?.lane ?? this.laneColors[slot] ?? ['white', 'red', 'yellow', 'blue'][slot] ?? null;
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
    return code === 'PR' ? this.ts.t('remarkShortPb') : code;
  }

  /** CSS class for the remark badge (PR/TR/TRC → purple, else orange). */
  remarkBadgeClass(remark: string): string {
    const v = remark.toUpperCase();
    return (v === 'PR' || v === 'TR' || v === 'TRC') ? 'timed-badge-purple' : 'timed-badge-orange';
  }

  /** CSS class for the invalid_reason badge (DQ → red, else orange). */
  invalidBadgeClass(reason: string): string {
    return reason.toUpperCase() === 'DQ' ? 'timed-badge-red' : 'timed-badge-orange';
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
