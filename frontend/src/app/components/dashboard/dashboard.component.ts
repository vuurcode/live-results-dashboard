import { ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, HostListener, OnDestroy, OnInit, afterEveryRender, afterNextRender, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Title } from '@angular/platform-browser';
import { DataService } from '../../services/data.service';
import { FeedStatus, TodayMatch, ProcessedDistance, StandingsGroup, CompetitorUpdate } from '../../models/data.models';
import { Observable, combineLatest, concat, defer, from, map, of, startWith, Subscription, switchMap, timer } from 'rxjs';
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
import { isRecentUpdate } from '../../logic/time.util';
import {
  timedDistanceLapSchedule as timedDistanceLapScheduleUtil,
  timedDistanceTotalLaps as timedDistanceTotalLapsUtil,
  timedRaceComplete as timedRaceCompleteUtil,
  mergeHeatGroups,
  trimmedRaces as trimmedRacesUtil,
  heatGroupLaneColors as heatGroupLaneColorsUtil,
  type MergedHeatGroup,
} from '../../logic/heats.util';
import { RaceCode } from '../../logic/race-codes';
import { followScrollTop } from '../../logic/scroll.util';
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
export class DashboardComponent implements OnInit, OnDestroy {
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

  private currentFollowKey: string | null = null;
  /** Index of the heat being followed in the live distance; auto-follow only moves forward from it. */
  private followHeatIndex = -1;
  /** The live distance the page follows; auto-follow never goes back to an earlier distance. */
  private followedDistanceId: string | null = null;
  private followedEventNumber = -1;
  private followScrollSub: Subscription | null = null;
  private scrolledToLiveOnLoad = false;
  private activeHeatSub: Subscription | null = null;
  private resetSub: Subscription | null = null;
  private resizeObserver: ResizeObserver | null = null;

  // Hide mass start settings if no mass start present
  hasMassStart$: Observable<boolean>;

  /** Matches happening today, for the match picker in the top bar. */
  readonly todayMatches$: Observable<TodayMatch[]> = defer(() => from(this.dataService.todayMatches()));

  /** Length of the shown option text; on narrow screens a longer one gets a smaller font. */
  selectedLabelLength(matches: TodayMatch[]): number {
    const m = matches.find(x => x.id === this.dataService.competitionId);
    return m ? `${m.venue.name} · ${m.name}`.length : 20;
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

  /** The start time is only worth showing until the match has begun. */
  hasNotStarted(match: TodayMatch): boolean {
    return new Date(match.start).getTime() > Date.now();
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
    const fmt = (n: number) => this.ts.num(n);
    return { pct: fmt(pct), slow: fmt(40 * (1 + pct / 100)), fast: fmt(40 * (1 - pct / 100)) };
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

  private titleSub: Subscription | null = null;

  public dataService = inject(DataService);
  private titleService = inject(Title);
  public ts = inject(TranslateService);
  private cdr = inject(ChangeDetectorRef);
  private host = inject<ElementRef<HTMLElement>>(ElementRef);

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
    // the browser would restore the previous scroll position on reload, after the page has landed on the live distance
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    this.titleSub = this.dataService.eventName$.subscribe(name => {
      const pageTitle = this.ts.t('pageTitle');
      this.titleService.setTitle(name ? `${name} | ${pageTitle}` : pageTitle);
    });
    this.resetSub = this.dataService.reset$.subscribe(() => {
      this.initialLiveId = null;
      this.liveEventNumber = null;
      this.currentFollowKey = null;
      this.followHeatIndex = -1;
      this.followedDistanceId = null;
      this.followedEventNumber = -1;
      this.scrolledToLiveOnLoad = false;
      this.cdr.markForCheck();
    });
    this.followScrollSub = this.sortedDistances$.subscribe(distances => {
      const live = distances.find(d => d.isLive);
      if (!live) return;
      if (!this.dataService.follow) {
        // without auto-follow the page still lands on the live distance once, when it first shows up
        if (!this.scrolledToLiveOnLoad) {
          this.scrolledToLiveOnLoad = true;
          this._scrollTo(`[data-distance-header="${live.id}"]`, this.HEADER_ANCHOR);
        }
        return;
      }
      // When the live distance moves on, expand its accordion and scroll to it; a flip back to an earlier distance is ignored
      if (live.id !== this.followedDistanceId) {
        if (live.eventNumber < this.followedEventNumber) return;
        this.followedDistanceId = live.id;
        this.followedEventNumber = live.eventNumber;
        this.initialLiveId = live.id;
        this.liveEventNumber = live.eventNumber;
        this.currentFollowKey = null;
        this.followHeatIndex = -1;
        this.cdr.markForCheck();
        this._scrollTo(`[data-distance-header="${live.id}"]`, this.HEADER_ANCHOR);
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
    this.resizeObserver?.disconnect();
  }


  isActiveHeatRow(distanceId: string, label: string): boolean {
    return this.activeHeatKey?.distanceId === distanceId && this.activeHeatKey?.label === label;
  }

  badgeTextClass(lane: string): string {
    const light = ['white', 'yellow', 'orange', 'pink', 'lime'];
    return light.includes((lane || '').toLowerCase()) ? 'text-dark' : 'text-white';
  }

  raceListKey = raceListKey;

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
  distanceMaxLaneCount(groups: MergedHeatGroup<CompetitorUpdate>[]): number {
    return Math.max(0, ...groups.map(g => this.trimmedRaces(g.races).length));
  }

  /** Lane color per slot index, derived from any non-null race across all heat groups. */
  heatGroupLaneColors(groups: MergedHeatGroup<CompetitorUpdate>[]): (string | null)[] {
    return heatGroupLaneColorsUtil(groups);
  }

  onFollowChange(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.dataService.setFollow(checked);
    this.currentFollowKey = null;
    this.followHeatIndex = -1;
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
    let anchor: number;

    if (!distance.isMassStart) {
      const heatGroups = this.mergedHeatGroups(distance);
      const currentIdx = heatGroups.reduce(
        (last, g, i) => (g.races.some(r => r != null && !isWithdrawn(r) && isRecentUpdate(r.lastUpdated)) ? i : last), -1);
      // an update in an earlier heat (e.g. a manual time correction) must not pull the page back
      if (currentIdx === -1 || currentIdx < this.followHeatIndex) return;
      this.followHeatIndex = currentIdx;
      const current = heatGroups[currentIdx];
      key = `${distance.id}:${current.label}`;
      selector = `[data-distance-id="${distance.id}"][data-heat-label="${current.label}"]`;
      anchor = this.HEAT_ANCHOR;
    } else {
      key = `mass:${distance.id}`;
      selector = `[data-distance-body="${distance.id}"]`;
      anchor = this.HEADER_ANCHOR;
    }

    if (key === this.currentFollowKey) return;
    this.currentFollowKey = key;

    this._scrollTo(selector, anchor);
  }

  /** Where the followed element lands, as a fraction of the viewport height from the top. */
  private readonly HEAT_ANCHOR = 0.3; // active heat a third of the way down, previous heats still partly visible
  private readonly HEADER_ANCHOR = 0.03; // a small breathing margin above a distance

  /** Longest wait for the page to stop changing height before scrolling anyway. */
  private readonly SETTLE_MAX_MS = 1000;
  /** How long the page height has to stay the same to count as settled. */
  private readonly SETTLE_STABLE_MS = 150;
  /** A scroll shorter than this fraction of the viewport height is not worth making. */
  private readonly SCROLL_DEAD_ZONE = 0.1;
  private scrollRun = 0;

  /**
   * Scrolls the element matching `selector` into place. A distance that is opening, or cards that are just arriving, make
   * the page grow for a moment; scrolling before that is over aims at a page that is still too short, so this waits until
   * the page height has been steady for a short while.
   */
  private _scrollTo(selector: string, anchorRatio: number): void {
    const run = ++this.scrollRun; // a newer scroll replaces one that is still waiting
    const started = performance.now();
    let height = -1;
    let steadySince = started;
    const step = (now: number) => {
      if (run !== this.scrollRun) return;
      const current = document.documentElement.scrollHeight;
      if (current !== height) {
        height = current;
        steadySince = now;
      }
      if (now - steadySince < this.SETTLE_STABLE_MS && now - started < this.SETTLE_MAX_MS) {
        requestAnimationFrame(step);
        return;
      }
      const el = document.querySelector(selector) as HTMLElement | null;
      if (!el) return;
      const top = followScrollTop(
        el.getBoundingClientRect().top,
        window.scrollY,
        window.innerHeight,
        document.documentElement.scrollHeight,
        anchorRatio,
      );
      if (Math.abs(top - window.scrollY) < window.innerHeight * this.SCROLL_DEAD_ZONE) return; // already in place: no nudging back and forth
      window.scrollTo({ top, behavior: 'smooth' });
    };
    requestAnimationFrame(step);
  }

}

const DISCONNECT_GRACE_MS = 3000;

/** A withdrawn race is loaded up front and says nothing about the timing that is going on. */
function isWithdrawn(race: CompetitorUpdate): boolean {
  return [race.invalid_reason, ...(race.remark ?? '').split(/\s+/)].some(c => c?.toUpperCase() === RaceCode.Withdrawn);
}

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
