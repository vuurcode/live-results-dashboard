import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output, inject } from '@angular/core';
import { BadgeModule } from '@coreui/angular';
import { CompetitorUpdate, ProcessedDistance } from '../../results/data.models';
import { TranslateService } from '../../i18n/translate.service';
import { TranslatePipe } from '../../i18n/translate.pipe';
import { lapBadgeColor } from '../../results/lap-color.util';
import { splitLapTime, splitFormattedTime } from '../../results/time.util';
import { massFinishGapFromLeader as massFinishGapFromLeaderUtil, pendingLapCount as pendingLapCountUtil } from '../../results/heats.util';

@Component({
  selector: 'app-mass-start-race-row',
  standalone: true,
  imports: [BadgeModule, TranslatePipe],
  templateUrl: './mass-start-race-row.component.html',
  styleUrls: ['./mass-start-race-row.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MassStartRaceRowComponent {
  protected ts = inject(TranslateService);

  @Input({ required: true }) race!: CompetitorUpdate;
  @Input({ required: true }) distance!: ProcessedDistance;
  @Input() raceIdx = 0;
  @Input() selectedRaceIds: ReadonlySet<string> = new Set();
  @Input() lapVarianceThreshold = 0;

  @Output() readonly raceSelect = new EventEmitter<string>();

  protected splitLapTime = splitLapTime;
  protected splitFormattedTime = splitFormattedTime;

  /** Returns [base, superscript] for ordinal, e.g. ordinalSuffix(1) → ['1','st'] */
  protected ordinalSuffix(n: number): [string, string] {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return [String(n), s[(v - 20) % 10] ?? s[v] ?? s[0]];
  }

  /**
   * Returns true when the competitor is the leader of the head group
   * (group_number === 1, gap_to_above === null) and no one has finished yet.
   */
  protected isRaceLeader(race: CompetitorUpdate, distance: ProcessedDistance): boolean {
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
  protected lapBadgeColor(lapTimes: string[], i: number): string {
    return lapBadgeColor(lapTimes, i, this.lapVarianceThreshold);
  }

  /**
   * Returns the number of pending (not-yet-completed) laps for a mass-start competitor.
   * = totalLaps - lap_times.length, clamped to 0.
   */
  protected pendingLapCount(race: CompetitorUpdate, totalLaps: number): number {
    return pendingLapCountUtil(race.lap_times?.length ?? 0, totalLaps);
  }

  /** The number of laps to go as a badge; inline styles because it is part of a translated HTML string. */
  protected lapsToGoBadge(remaining: number): string {
    return `<span style="display:inline-block;padding:0.14em 0.4em;border-radius:0.22rem;background:var(--lr-strong-bg);color:var(--lr-strong-fg);font-weight:600">${remaining}</span>`;
  }

  /**
   * Returns a formatted "+SS.mmm" or "+M:SS.mmm" string for a finished mass-start
   * competitor's gap from the race winner, or null if they are the winner / gap unknown.
   */
  protected massFinishGapFromLeader(race: CompetitorUpdate, distance: ProcessedDistance): string | null {
    const leader = distance.processedRaces.find(r => r.finished_rank === 1);
    return massFinishGapFromLeaderUtil(race.finished_rank, race.total_time, leader?.total_time);
  }
}
