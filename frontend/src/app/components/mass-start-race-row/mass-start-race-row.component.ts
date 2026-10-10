import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output, inject } from '@angular/core';
import { BadgeModule } from '@coreui/angular';
import { CompetitorUpdate, ProcessedDistance } from '../../models/data.models';
import { TranslateService } from '../../services/translate.service';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { parseSeconds, splitLapTime, splitFormattedTime, isRecentUpdate } from '../../logic/time.util';
import { massFinishGapFromLeader as massFinishGapFromLeaderUtil, pendingLapCount as pendingLapCountUtil } from '../../logic/heats.util';

@Component({
  selector: 'app-mass-start-race-row',
  standalone: true,
  imports: [BadgeModule, TranslatePipe],
  templateUrl: './mass-start-race-row.component.html',
  styleUrls: ['../dashboard/dashboard.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MassStartRaceRowComponent {
  @Input({ required: true }) race!: CompetitorUpdate;
  @Input({ required: true }) distance!: ProcessedDistance;
  @Input() raceIdx = 0;
  @Input() selectedRaceId: string | null = null;
  @Input() showLapTimes = false;
  @Input() lapVarianceThreshold = 0;

  @Output() raceSelect = new EventEmitter<string>();

  public ts = inject(TranslateService);

  isRecentUpdate = isRecentUpdate;
  splitLapTime = splitLapTime;
  splitFormattedTime = splitFormattedTime;

  /** Returns [base, superscript] for ordinal, e.g. ordinalSuffix(1) → ['1','st'] */
  ordinalSuffix(n: number): [string, string] {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return [String(n), s[(v - 20) % 10] ?? s[v] ?? s[0]];
  }

  /**
   * Returns true when the competitor is the leader of the head group
   * (group_number === 1, gap_to_above === null) and no one has finished yet.
   */
  isRaceLeader(race: CompetitorUpdate, distance: ProcessedDistance): boolean {
    if (distance.anyFinished) return false;
    return race.group_number === 1 && race.gap_to_above == null && race.finished_rank == null && !!race.total_time;
  }

  /**
   * Returns a CSS class name for a lap time badge based on variance vs the previous lap.
   * First lap: always 'lap-badge-normal' (green).
   * Subsequent laps: compare to previous lap using the lapVarianceThreshold (%).
   *   > threshold% slower  → 'lap-badge-slow'   (orange)
   *   > threshold% faster  → 'lap-badge-fast'   (purple)
   *   within threshold     → 'lap-badge-normal' (green)
   */
  lapBadgeColor(lapTimes: string[], i: number): string {
    if (i === 0 || !lapTimes[i - 1]) return 'lap-badge-normal';
    const curr = parseSeconds(lapTimes[i]);
    const prev = parseSeconds(lapTimes[i - 1]);
    if (!prev) return 'lap-badge-normal';
    const threshold = this.lapVarianceThreshold / 100;
    const ratio = (curr - prev) / prev;
    if (ratio > threshold)  return 'lap-badge-slow';   // current slower  → orange
    if (ratio < -threshold) return 'lap-badge-fast';   // current faster  → purple
    return 'lap-badge-normal';
  }

  /**
   * Returns the number of pending (not-yet-completed) laps for a mass-start competitor.
   * = totalLaps - lap_times.length, clamped to 0.
   */
  pendingLapCount(race: CompetitorUpdate, totalLaps: number): number {
    return pendingLapCountUtil(race.lap_times?.length ?? 0, totalLaps);
  }

  /**
   * Returns a formatted "+SS.mmm" or "+M:SS.mmm" string for a finished mass-start
   * competitor's gap from the race winner, or null if they are the winner / gap unknown.
   */
  massFinishGapFromLeader(race: CompetitorUpdate, distance: ProcessedDistance): string | null {
    const leader = distance.processedRaces.find(r => r.finished_rank === 1);
    return massFinishGapFromLeaderUtil(race.finished_rank, race.total_time, leader?.total_time);
  }
}
