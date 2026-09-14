import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnDestroy, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Title } from '@angular/platform-browser';
import { DataService } from '../../services/data.service';
import { ProcessedDistance, StandingsGroup, CompetitorUpdate } from '../../models/data.models';
import { Observable, map, Subscription } from 'rxjs';
import { TranslateService } from '../../services/translate.service';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { GroupStripCardComponent } from '../group-strip-card/group-strip-card.component';
import { TimedHeatCardComponent } from '../timed-heat-card/timed-heat-card.component';
import { MassStartRaceRowComponent } from '../mass-start-race-row/mass-start-race-row.component';
import {
  AccordionModule,
  AlertModule,
  BadgeModule,
  ButtonModule,
  GridModule,
  SharedModule,
} from '@coreui/angular';
import { FormsModule } from '@angular/forms';
import { isRecentUpdate } from '../../logic/time.util';
import {
  timedDistanceLapSchedule as timedDistanceLapScheduleUtil,
  timedDistanceTotalLaps as timedDistanceTotalLapsUtil,
  timedRaceComplete as timedRaceCompleteUtil,
  mergeHeatGroups,
  trimmedRaces as trimmedRacesUtil,
  heatGroupLaneColors as heatGroupLaneColorsUtil,
} from '../../logic/heats.util';
import { raceListAnimation } from './dashboard.animations';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [
    CommonModule,
    AccordionModule,
    AlertModule,
    BadgeModule,
    ButtonModule,
    GridModule,
    SharedModule,
    FormsModule,
    TranslatePipe,
    GroupStripCardComponent,
    TimedHeatCardComponent,
    MassStartRaceRowComponent,
  ],
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss'],
  animations: [raceListAnimation],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DashboardComponent implements OnInit, OnDestroy {
  sortedDistances$: Observable<ProcessedDistance[]>;
  eventName$: Observable<string>;
  errors$: Observable<string[]>;
  status$: Observable<import('../../services/data.service').BackendStatus>;
  displayedGroups$: Observable<Map<string, StandingsGroup[]>>;

  initialLiveId: string | null = null;
  liveEventNumber: number | null = null;
  selectedRaceId: string | null = null;
  displaySettingsOpen = true;
  massStartSettingsOpen = false;
  activeHeatKey: { distanceId: string; label: string } | null = null;

  private currentFollowKey: string | null = null;
  private followScrollSub: Subscription | null = null;
  private activeHeatSub: Subscription | null = null;
  private resetSub: Subscription | null = null;

  // Hide mass start settings if no mass start present
  hasMassStart$: Observable<boolean>;

  selectRace(id: string): void {
    this.selectedRaceId = this.selectedRaceId === id ? null : id;
  }

  onThresholdChange(event: Event): void {
    const val = parseFloat((event.target as HTMLInputElement).value);
    if (!isNaN(val)) this.dataService.setGroupThreshold(val);
  }

  onMaxGroupsChange(event: Event): void {
    const val = parseInt((event.target as HTMLInputElement).value, 10);
    if (!isNaN(val)) this.dataService.setMaxGroups(val);
  }

  onLapVarianceChange(event: Event): void {
    const val = parseInt((event.target as HTMLInputElement).value, 10);
    if (!isNaN(val)) this.dataService.setLapVarianceThreshold(val);
  }

  onShowLapTimesChange(event: Event): void {
    this.dataService.setShowMassStartLapTimes((event.target as HTMLInputElement).checked);
  }

  private titleSub: Subscription | null = null;

  public dataService = inject(DataService);
  private titleService = inject(Title);
  public ts = inject(TranslateService);
  private cdr = inject(ChangeDetectorRef);

  constructor() {
    this.status$ = this.dataService.status$;
    this.eventName$ = this.dataService.eventName$;
    this.errors$ = this.dataService.errors$;
    this.displayedGroups$ = this.dataService.displayedGroups$;
    this.hasMassStart$ = this.dataService.processedData$.pipe(
      map(distances => !!distances?.some(d => d.isMassStart))
    );
    this.sortedDistances$ = this.dataService.processedData$.pipe(
      map((distances) => {
        if (!distances || distances.length === 0) return [];
        const sorted = [...distances].sort((a, b) => a.eventNumber - b.eventNumber);
        // Capture the first live distance id/eventNumber for initial accordion open
        if (this.initialLiveId === null) {
          const live = sorted.find((d) => d.isLive);
          if (live) {
            this.initialLiveId = live.id;
            this.liveEventNumber = live.eventNumber;
          }
        }
        // When follow is on, update initialLiveId if the live distance changes
        // (also handled in followScrollSub for scrolling, but keep in sync here)
        else if (this.dataService.follow) {
          const live = sorted.find((d) => d.isLive);
          if (live && live.id !== this.initialLiveId) {
            this.initialLiveId = live.id;
            this.liveEventNumber = live.eventNumber;
          }
        }
        return sorted;
      }),
    );
  }

  ngOnInit() {
    this.titleSub = this.dataService.eventName$.subscribe(name => {
      const pageTitle = this.ts.t('pageTitle');
      this.titleService.setTitle(name ? `${name} | ${pageTitle}` : pageTitle);
    });
    this.resetSub = this.dataService.reset$.subscribe(() => {
      this.initialLiveId = null;
      this.liveEventNumber = null;
      this.currentFollowKey = null;
      this.cdr.markForCheck();
    });
    this.followScrollSub = this.sortedDistances$.subscribe(distances => {
      if (!this.dataService.follow) return;
      const live = distances.find(d => d.isLive);
      if (!live) return;
      // When the live distance changes, expand its accordion and scroll to it
      if (live.id !== this.initialLiveId) {
        this.initialLiveId = live.id;
        this.liveEventNumber = live.eventNumber;
        this.currentFollowKey = null;
        this.cdr.markForCheck();
        requestAnimationFrame(() => {
          const el = document.querySelector(`[data-distance-header="${live.id}"]`) as HTMLElement | null;
          if (!el) return;
          const top = el.getBoundingClientRect().top + window.scrollY;
          window.scrollTo({ top, behavior: 'smooth' });
        });
        return;
      }
      this._scrollToFollow(live);
    });
    this.activeHeatSub = this.sortedDistances$.subscribe(distances => {
      let maxTime = 0;
      let result: { distanceId: string; label: string } | null = null;
      for (const distance of distances) {
        if (distance.isMassStart) continue;
        for (const group of this.mergedHeatGroups(distance)) {
          for (const race of group.races) {
            if (race?.lastUpdated && race.lastUpdated > maxTime) {
              maxTime = race.lastUpdated;
              result = { distanceId: distance.id, label: group.label };
            }
          }
        }
      }
      this.activeHeatKey = result;
      this.cdr.markForCheck();
    });
  }

  ngOnDestroy() {
    this.titleSub?.unsubscribe();
    this.followScrollSub?.unsubscribe();
    this.activeHeatSub?.unsubscribe();
    this.resetSub?.unsubscribe();
  }


  isActiveHeatRow(distanceId: string, label: string): boolean {
    return this.activeHeatKey?.distanceId === distanceId && this.activeHeatKey?.label === label;
  }

  badgeTextClass(lane: string): string {
    const light = ['white', 'yellow', 'orange', 'pink', 'lime'];
    return light.includes((lane || '').toLowerCase()) ? 'text-dark' : 'text-white';
  }

  /** Stable animation state key — changes whenever the sort order of the list changes. */
  raceListKey(races: { id: string }[]): string {
    return races.map(r => r.id).join(',');
  }

  /**
   * Returns true when the race at raceIdx is the first competitor of a new
   * standings group (different lapsCount from the previous race), so we can
   * render a small visual gap between groups.
   */
  isFirstInNewGroup(distance: ProcessedDistance, raceIdx: number): boolean {
    const races = distance.processedRaces;
    if (!races || raceIdx <= 0 || raceIdx >= races.length) return false;
    return races[raceIdx].laps_count !== races[raceIdx - 1].laps_count;
  }

  /**
   * Returns the StandingsGroup that contains the given race id, or null.
   * Used to render a group divider above the first member of each group.
   */
  groupForRace(distance: ProcessedDistance, raceId: string): StandingsGroup | null {
    if (!distance.standingsGroups) return null;
    return distance.standingsGroups.find(g => g.races[0]?.id === raceId) ?? null;
  }

  /** Returns the display name for a standings group. */
  groupDisplayName(group: StandingsGroup, isFirst: boolean, anyFinished = false): string {
    if (group.isOthers) return this.ts.t('tailOfRace');
    if (isFirst && !anyFinished) return this.ts.t('headOfRace');
    return this.ts.t('groupLabel', { n: group.groupNumber });
  }

  /**
   * Returns the ordered list of cumulative distances (in metres) at which
   * a lap is expected for a timed distance, derived from first_lap % 400.
   * e.g. distanceMeters=1000 → [200, 600, 1000]
   *      distanceMeters=500  → [100, 500]
   *      distanceMeters=100  → [100]
   */
  timedDistanceLapSchedule(distanceMeters: number): number[] {
    return timedDistanceLapScheduleUtil(distanceMeters);
  }

  /** Total number of expected laps for a timed distance. */
  timedDistanceTotalLaps(distanceMeters: number): number {
    return timedDistanceTotalLapsUtil(distanceMeters);
  }

  /**
   * Returns heat groups for rendering, merging consecutive heats where the
   * first has only white/red lanes and the second has only yellow/blue lanes.
   */
  mergedHeatGroups(distance: ProcessedDistance): { label: string; races: (CompetitorUpdate | null)[] }[] {
    return mergeHeatGroups(
      distance.heatGroups,
      (n) => this.ts.t('heatLabel', { n }),
      (a, b) => this.ts.t('heatMergedLabel', { a, b }),
    );
  }

  /** Removes trailing null slots from a races array. */
  trimmedRaces(races: (CompetitorUpdate | null)[]): (CompetitorUpdate | null)[] {
    return trimmedRacesUtil(races);
  }

  /** Max trimmed lane count across all heat groups in a distance, so narrower heats don't spread wider than their siblings. */
  distanceMaxLaneCount(distance: ProcessedDistance): number {
    return Math.max(0, ...this.mergedHeatGroups(distance).map(g => this.trimmedRaces(g.races).length));
  }

  /** Lane color per slot index, derived from any non-null race across all heat groups. */
  heatGroupLaneColors(distance: ProcessedDistance): (string | null)[] {
    return heatGroupLaneColorsUtil(this.mergedHeatGroups(distance));
  }

  onFollowChange(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.dataService.setFollow(checked);
    this.currentFollowKey = null;
  }

/** True when a timed race counts as complete: all laps done OR has an invalid_reason. */
  private timedRaceComplete(race: CompetitorUpdate, distanceMeters: number): boolean {
    return timedRaceCompleteUtil(race, distanceMeters);
  }

  /** Number of completed races in a timed distance. */
  timedCompletedCount(distance: ProcessedDistance): number {
    if (!distance.distanceMeters) return 0;
    return distance.processedRaces.filter(r => this.timedRaceComplete(r, distance.distanceMeters!)).length;
  }

  /** True when all races in a timed distance are complete (finished or invalid). */
  private isTimedDistanceDone(distance: ProcessedDistance): boolean {
    const total = distance.processedRaces.length;
    if (!distance.distanceMeters || total === 0) return false;
    return this.timedCompletedCount(distance) === total;
  }

  /** True when the distance should show the Done badge. */
  isDistanceDone(distance: ProcessedDistance): boolean {
    if (this.liveEventNumber !== null && distance.eventNumber < this.liveEventNumber) return true;
    if (!distance.isMassStart) return this.isTimedDistanceDone(distance);
    return false;
  }

  private _scrollToFollow(distance: ProcessedDistance): void {
    let key: string;
    let selector: string;

    if (!distance.isMassStart) {
      const heatGroups = this.mergedHeatGroups(distance);
      const currentIdx = heatGroups.findIndex(g =>
        g.races.some(r => r != null && isRecentUpdate(r.lastUpdated))
      );
      if (currentIdx === -1) return;
      const targetHeat = heatGroups[Math.max(0, currentIdx - 2)];
      key = `${distance.id}:${heatGroups[currentIdx].label}`;
      selector = `[data-distance-id="${distance.id}"][data-heat-label="${targetHeat.label}"]`;
    } else {
      key = `mass:${distance.id}`;
      selector = `[data-distance-body="${distance.id}"]`;
    }

    if (key === this.currentFollowKey) return;
    this.currentFollowKey = key;

    requestAnimationFrame(() => {
      const el = document.querySelector(selector) as HTMLElement | null;
      if (!el) return;
      const top = el.getBoundingClientRect().top + window.scrollY;
      window.scrollTo({ top, behavior: 'smooth' });
    });
  }

}
