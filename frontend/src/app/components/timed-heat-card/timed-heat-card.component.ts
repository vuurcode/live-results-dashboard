import { ChangeDetectionStrategy, Component, Input, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { BadgeModule } from '@coreui/angular';
import { CompetitorUpdate } from '../../models/data.models';
import { TranslateService, TranslationKey } from '../../services/translate.service';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { parseSeconds, formatDurationSeconds, truncateLapTime, splitFormattedTime, isRecentUpdate } from '../../logic/time.util';
import { isTimedFinished as isTimedFinishedUtil, timedPrComparison as timedPrComparisonUtil } from '../../logic/heats.util';

@Component({
  selector: 'app-timed-heat-card',
  standalone: true,
  imports: [CommonModule, BadgeModule, TranslatePipe],
  templateUrl: './timed-heat-card.component.html',
  styleUrls: ['../dashboard/dashboard.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TimedHeatCardComponent {
  @Input({ required: true }) label = '';
  @Input({ required: true }) races: (CompetitorUpdate | null)[] = [];
  @Input() maxLanes = 0;
  @Input() laneColors: (string | null)[] = [];
  @Input() lapSchedule: number[] = [];
  @Input() distanceMeters: number | null = null;
  @Input() distanceId = '';
  @Input() active = false;

  public ts = inject(TranslateService);

  isRecentUpdate = isRecentUpdate;
  splitFormattedTime = splitFormattedTime;
  truncateLapTime = truncateLapTime;

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

  /** True when the competitor has completed all laps for the timed distance. */
  isTimedFinished(race: CompetitorUpdate, distanceMeters: number): boolean {
    return isTimedFinishedUtil(race, distanceMeters);
  }

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
  timedWatermarkText(race: CompetitorUpdate, distanceMeters?: number): string | null {
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
