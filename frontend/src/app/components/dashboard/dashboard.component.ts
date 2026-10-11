import { isNeverLive } from '../../logic/race-codes';
import { ChangeDetectionStrategy, ChangeDetectorRef, Component, DestroyRef, ElementRef, HostListener, OnInit, afterEveryRender, afterNextRender, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Title } from '@angular/platform-browser';
import { DataService } from '../../services/data.service';
import { FeedStatus, TodayMatch, ProcessedDistance, StandingsGroup, CompetitorUpdate } from '../../models/data.models';
import { Observable, combineLatest, concat, defer, from, map, of, startWith, switchMap, take, timer } from 'rxjs';
import { TranslateService, TranslationKey } from '../../services/translate.service';
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
import {
  timedDistanceLapSchedule as timedDistanceLapScheduleUtil,
  timedDistanceTotalLaps as timedDistanceTotalLapsUtil,
  timedRaceComplete as timedRaceCompleteUtil,
  mergeHeatGroups,
  trimmedRaces as trimmedRacesUtil,
  heatGroupLaneColors as heatGroupLaneColorsUtil,
  type MergedHeatGroup,
} from '../../logic/heats.util';
import { SettledScroller } from '../../logic/scroll.util';
import { AutoFollow } from './auto-follow';
import { raceListAnimation, raceListKey } from './dashboard.animations';

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
export class DashboardComponent implements OnInit {
  sortedDistances$: Observable<ProcessedDistance[]>;
  eventName$: Observable<string>;
  errors$: Observable<string[]>;
  /** Why the page has no results to show (instead of the loading skeleton), or null while it is just connecting. */
  emptyNotice$!: Observable<EmptyNotice | null>;
  displayedGroups$: Observable<Map<string, StandingsGroup[]>>;

  initialLiveId: string | null = null;
  liveEventNumber: number | null = null;
  selectedRaceId: string | null = null;
  displaySettingsOpen = false;
  massStartSettingsOpen = false;
  activeHeatKey: { distanceId: string; label: string } | null = null;

  private readonly scroller = new SettledScroller();
  private readonly autoFollow = new AutoFollow({
    follow: () => this.dataService.follow,
    heatGroups: (distance) => this.mergedHeatGroups(distance),
    scrollTo: (selector, anchor) => this.scroller.scrollTo(selector, anchor),
    liveDistanceChanged: (live) => {
      this.initialLiveId = live.id;
      this.liveEventNumber = live.eventNumber;
      this.cdr.markForCheck();
    },
  });
  private resizeObserver: ResizeObserver | null = null;

  // Hide mass start settings if no mass start present
  hasMassStart$: Observable<boolean>;

  /** Matches happening today, for the match picker in the top bar. */
  readonly todayMatches$: Observable<TodayMatch[]> = defer(() => from(this.dataService.todayMatches()));

  /** Length of the shown option text; on narrow screens a longer one gets a smaller font. */
  selectedLabelLength(matches: TodayMatch[]): number {
    const m = matches.find(x => x.id === this.dataService.competitionId);
    return m ? `00:00 - 00:00 · ${m.name} (${m.venue.name})`.length : 20;
  }

  /** Open another match; the page reads its competitionId on load. */
  onMatchChange(event: Event): void {
    const id = (event.target as HTMLSelectElement).value;
    if (id) window.location.search = `?competitionId=${encodeURIComponent(id)}`;
  }

  /** Only one settings group is open at a time. */
  toggleSettingsGroup(group: 'display' | 'massStart'): void {
    const open = group === 'display' ? !this.displaySettingsOpen : !this.massStartSettingsOpen;
    this.displaySettingsOpen = group === 'display' && open;
    this.massStartSettingsOpen = group === 'massStart' && open;
  }

  /** A click anywhere outside the settings buttons and panels folds them away. */
  @HostListener('document:click', ['$event'])
  closeSettingsOnOutsideClick(event: MouseEvent): void {
    if (!this.displaySettingsOpen && !this.massStartSettingsOpen) return;
    if (event.composedPath().some((el) => el instanceof Element && el.classList.contains('topbar-settings-group'))) return;
    this.closeSettings();
  }

  /** Escape folds the settings panel away. */
  @HostListener('document:keydown.escape')
  closeSettings(): void {
    this.displaySettingsOpen = false;
    this.massStartSettingsOpen = false;
  }

  isTodayMatch(matches: TodayMatch[], id: string): boolean {
    return matches.some((m) => m.id === id);
  }

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

  /** The values of the threshold example text, following the given setting (a lap of 40.0 s as the base). */
  lapExample(pct: number): Record<string, string> {
    const seconds = (n: number) => this.ts.num(n, 1); // a time always has a decimal
    return { pct: this.ts.num(pct), slow: seconds(40 * (1 + pct / 100)), fast: seconds(40 * (1 - pct / 100)) };
  }

  /**
   * The mouse wheel and the spinner buttons change a number input without a `change` event (that waits for blur),
   * so the example text would lag behind. They have no `inputType`; typing does and is applied on `change`, so a
   * half-typed "0." is not overwritten.
   */
  onLapVarianceStep(event: Event, timed: boolean): void {
    if ((event as InputEvent).inputType) return;
    if (timed) this.onLapVarianceTimedChange(event);
    else this.onLapVarianceChange(event);
  }

  onLapVarianceTimedChange(event: Event): void {
    const val = parseFloat((event.target as HTMLInputElement).value);
    if (!isNaN(val)) this.dataService.setLapVarianceThresholdTimed(val);
  }

  onThousandthsChange(event: Event): void {
    this.dataService.setShowThousandths((event.target as HTMLInputElement).checked);
  }

  onCompactColorsChange(event: Event): void {
    this.dataService.setCompactColors((event.target as HTMLInputElement).checked);
  }

  onShowLapTimesChange(event: Event): void {
    this.dataService.setShowMassStartLapTimes((event.target as HTMLInputElement).checked);
  }

  public dataService = inject(DataService);
  private titleService = inject(Title);
  public ts = inject(TranslateService);
  private cdr = inject(ChangeDetectorRef);
  private host = inject<ElementRef<HTMLElement>>(ElementRef);
  private destroyRef = inject(DestroyRef);

  constructor() {
    // CoreUI's accordion template puts aria-expanded on the collapsible region (a plain div), which
    // ARIA does not allow there. The header button already exposes the expanded state, so drop it.
    afterEveryRender(() => {
      this.host.nativeElement
        .querySelectorAll('.accordion-collapse[aria-expanded]')
        .forEach(el => el.removeAttribute('aria-expanded'));
    });
    // The top bar and the open distance's title stay pinned while scrolling. The title sticks right
    // below the top bar, whose height changes when it wraps, so publish it as a CSS variable.
    afterNextRender(() => {
      const bar: HTMLElement | null = this.host.nativeElement.querySelector('.topbar');
      if (!bar || typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(() => {
        this.host.nativeElement.style.setProperty('--topbar-h', `${bar.offsetHeight}px`);
      });
      observer.observe(bar);
      this.resizeObserver = observer;
    });
    this.eventName$ = this.dataService.eventName$;
    this.errors$ = this.dataService.errors$;
    this.emptyNotice$ = combineLatest([
      this.dataService.feed$,
      this.dataService.status$.pipe(
        // a dropped connection is usually back within moments, so the disconnected notice waits a little
        switchMap(status => status.status === 'Error' || status.status === 'Disconnected'
          ? concat(of({ ...status, status: 'Connecting...' as const }), timer(DISCONNECT_GRACE_MS).pipe(map(() => status)))
          : of(status)),
      ),
      timer(10_000).pipe(map(() => true), startWith(false)), // a connection that stays silent is reported, not shown as loading forever
    ]).pipe(
      map(([feed, status, waitedLong]) => emptyNotice(feed, status.status, waitedLong)),
    );
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
        return sorted;
      }),
    );
  }

  ngOnInit() {
    // the browser would restore the previous scroll position on reload, after the page has landed on the live distance
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    this.destroyRef.onDestroy(() => this.resizeObserver?.disconnect());
    this.dataService.eventName$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(name => {
      const pageTitle = this.ts.t('pageTitle');
      this.titleService.setTitle(name ? `${name} | ${pageTitle}` : pageTitle);
    });
    this.dataService.reset$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      this.initialLiveId = null;
      this.liveEventNumber = null;
      this.autoFollow.reset();
      this.cdr.markForCheck();
    });
    this.sortedDistances$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(distances => this.autoFollow.update(distances));
    // after a suspension the page lands on the live distance again, as on a fresh load
    this.dataService.resumed$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      this.autoFollow.reset();
      this.sortedDistances$.pipe(take(1)).subscribe(distances => this.autoFollow.update(distances));
    });
    this.sortedDistances$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(distances => {
      this.activeHeatKey = this.findActiveHeat(distances);
      this.cdr.markForCheck();
    });
  }

  /** The heat whose lap times updated most recently (the later one when they changed together; the page follows by the same rule), ignoring mass starts; heats that were never timed here are never live. */
  private findActiveHeat(distances: ProcessedDistance[]): { distanceId: string; label: string } | null {
    let maxTime = 0;
    let result: { distanceId: string; label: string } | null = null;
    for (const distance of distances) {
      if (distance.isMassStart) continue;
      for (const group of this.mergedHeatGroups(distance)) {
        for (const race of group.races) {
          if (race?.lapsUpdatedAt && !isNeverLive(race) && race.lapsUpdatedAt >= maxTime) {
            maxTime = race.lapsUpdatedAt;
            result = { distanceId: distance.id, label: group.label };
          }
        }
      }
    }
    return result;
  }

  isActiveHeatRow(distanceId: string, label: string): boolean {
    return this.activeHeatKey?.distanceId === distanceId && this.activeHeatKey?.label === label;
  }

  badgeTextClass(lane: string): string {
    const light = ['white', 'yellow', 'orange', 'pink', 'lime'];
    return light.includes((lane || '').toLowerCase()) ? 'text-dark' : 'text-white';
  }

  raceListKey = raceListKey;
  readonly timedDistanceLapSchedule = timedDistanceLapScheduleUtil;
  readonly timedDistanceTotalLaps = timedDistanceTotalLapsUtil;
  readonly trimmedRaces = trimmedRacesUtil;
  readonly heatGroupLaneColors = heatGroupLaneColorsUtil;

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

  /** Max trimmed lane count across all heat groups in a distance, so narrower heats don't spread wider than their siblings. */
  distanceMaxLaneCount(groups: MergedHeatGroup<CompetitorUpdate>[]): number {
    return Math.max(0, ...groups.map(g => this.trimmedRaces(g.races).length));
  }

  onFollowChange(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.dataService.setFollow(checked);
    this.autoFollow.restart();
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
}

const DISCONNECT_GRACE_MS = 3000;

interface EmptyNotice {
  titleKey: TranslationKey;
  bodyKey: TranslationKey;
  /** The data source's own text, shown as a quote */
  message?: string;
}

/** What to tell the viewer while there are no results to show. */
function emptyNotice(feed: FeedStatus | null, connection: string, waitedLong: boolean): EmptyNotice | null {
  if (connection === 'No match') return { titleKey: 'feedNoMatchTitle', bodyKey: 'feedNoMatchBody' };
  if (connection === 'Error' || connection === 'Disconnected') return { titleKey: 'feedDisconnectedTitle', bodyKey: 'feedDisconnectedBody' };
  if (feed?.state === 'not_live') return { titleKey: 'feedNotLiveTitle', bodyKey: 'feedNotLiveBody', message: feed.message };
  if (feed?.state === 'unavailable') return { titleKey: 'feedUnavailableTitle', bodyKey: 'feedUnavailableBody' };
  if (feed?.state === 'ok') return { titleKey: 'feedEmptyTitle', bodyKey: 'feedEmptyBody' };
  return waitedLong ? { titleKey: 'feedSlowTitle', bodyKey: 'feedSlowBody' } : null;
}
