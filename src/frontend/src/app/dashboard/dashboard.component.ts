import { findLiveHeat } from '../results/live-heat';
import { ChangeDetectionStrategy, ChangeDetectorRef, Component, DestroyRef, ElementRef, HostBinding, HostListener, OnInit, afterEveryRender, afterNextRender, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Title } from '@angular/platform-browser';
import { DataService } from '../results/data.service';
import type { ColorSchemeChoice } from '../color-scheme';
import { parseInteger, parseNumber, SettingsService } from '../settings/settings.service';
import { FeedStatus, TodayCompetition, ProcessedDistance, StandingsGroup, CompetitorUpdate } from '../results/data.models';
import { Observable, combineLatest, concat, filter, from, map, merge, of, startWith, switchMap, take, timer } from 'rxjs';
import { TranslateService, TranslationKey } from '../i18n/translate.service';
import { TranslatePipe } from '../i18n/translate.pipe';
import { GroupStripCardComponent } from './group-strip-card/group-strip-card.component';
import { TimedHeatCardComponent } from './timed-heat-card/timed-heat-card.component';
import { MassStartRaceRowComponent } from './mass-start-race-row/mass-start-race-row.component';
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
} from '../results/heats.util';
import { SettledScroller } from './scroll.util';
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
  protected dataService = inject(DataService);
  protected settings = inject(SettingsService);
  private titleService = inject(Title);
  protected ts = inject(TranslateService);
  private cdr = inject(ChangeDetectorRef);
  private host = inject<ElementRef<HTMLElement>>(ElementRef);
  private destroyRef = inject(DestroyRef);

  protected sortedDistances$: Observable<ProcessedDistance[]>;
  protected eventName$: Observable<string>;
  protected errors$: Observable<string[]>;
  /** Why the page has no results to show (instead of the loading skeleton), or null while it is just connecting. */
  protected emptyNotice$!: Observable<EmptyNotice | null>;
  protected displayedGroups$: Observable<Map<string, StandingsGroup[]>>;

  protected initialLiveId: string | null = null;
  protected liveEventNumber: number | null = null;
  protected selectedRaceId: string | null = null;
  protected displaySettingsOpen = false;
  protected massStartSettingsOpen = false;
  protected activeHeatKey: { distanceId: string; label: string } | null = null;

  private readonly scroller = new SettledScroller(() => this.settings.animations.value);
  private readonly autoFollow = new AutoFollow({
    follow: () => this.settings.follow.value,
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
  protected hasMassStart$: Observable<boolean>;

  /** The competitions of today, asked again every few minutes so new competitions show up and finished ones drop off while the page stays open. */
  protected readonly todayCompetitions$: Observable<TodayCompetition[]> = merge(timer(0, 5 * 60_000), this.dataService.competitionsChanged$.pipe(map(() => -1))).pipe(
    filter(n => n === 0 || document.visibilityState !== 'hidden'), // nobody sees the list of a hidden page
    switchMap(() => from(this.dataService.todayCompetitions())),
  );

  /** Length of the shown option text; on narrow screens a longer one gets a smaller font. */
  protected selectedLabelLength(competitions: TodayCompetition[]): number {
    const m = competitions.find(x => x.id === this.dataService.competitionId);
    return m ? `⚪ 00:00 - 00:00 · ${m.name} (${m.venue.name})`.length : 20;
  }

  /** Open another competition; the page reads its competitionId on load. */
  protected openCompetition(event: Event): void {
    const id = (event.target as HTMLSelectElement).value;
    if (id) window.location.search = `?competitionId=${encodeURIComponent(id)}`;
  }

  /** Only one settings group is open at a time. */
  protected toggleSettingsGroup(group: 'display' | 'massStart'): void {
    const open = group === 'display' ? !this.displaySettingsOpen : !this.massStartSettingsOpen;
    this.displaySettingsOpen = group === 'display' && open;
    this.massStartSettingsOpen = group === 'massStart' && open;
  }

  /** A click anywhere outside the settings buttons and panels folds them away. */
  @HostListener('document:click', ['$event'])
  protected closeSettingsOnOutsideClick(event: MouseEvent): void {
    if (!this.displaySettingsOpen && !this.massStartSettingsOpen) return;
    if (event.composedPath().some((el) => el instanceof Element && el.classList.contains('topbar-settings-group'))) return;
    this.closeSettings();
  }

  /** Escape folds the settings panel away. */
  @HostListener('document:keydown.escape')
  protected closeSettings(): void {
    this.displaySettingsOpen = false;
    this.massStartSettingsOpen = false;
  }

  protected isTodayCompetition(competitions: TodayCompetition[], id: string): boolean {
    return competitions.some((m) => m.id === id);
  }

  protected selectRace(id: string): void {
    this.selectedRaceId = this.selectedRaceId === id ? null : id;
  }

  protected setGroupThreshold(event: Event): void {
    const val = parseNumber((event.target as HTMLInputElement).value);
    if (val !== undefined) this.settings.groupThreshold.set(val);
  }

  protected setMaxGroups(event: Event): void {
    const val = parseInteger((event.target as HTMLInputElement).value);
    if (val !== undefined) this.settings.maxGroups.set(val);
  }

  protected setLapVariance(event: Event): void {
    const val = parseInteger((event.target as HTMLInputElement).value);
    if (val !== undefined) this.settings.lapVariance.set(val);
  }

  /** The values of the threshold example text, following the given setting (a lap of 40.0 s as the base). */
  protected lapExample(pct: number): Record<string, string> {
    const seconds = (n: number) => this.ts.num(n, 1); // a time always has a decimal
    return { pct: this.ts.num(pct), slow: seconds(40 * (1 + pct / 100)), fast: seconds(40 * (1 - pct / 100)) };
  }

  /**
   * The mouse wheel and the spinner buttons change a number input without a `change` event (that waits for blur),
   * so the example text would lag behind. They have no `inputType`; typing does and is applied on `change`, so a
   * half-typed "0." is not overwritten.
   */
  protected stepLapVariance(event: Event, timed: boolean): void {
    if ((event as InputEvent).inputType) return;
    if (timed) this.setLapVarianceTimed(event);
    else this.setLapVariance(event);
  }

  protected setLapVarianceTimed(event: Event): void {
    const val = parseNumber((event.target as HTMLInputElement).value);
    if (val !== undefined) this.settings.lapVarianceTimed.set(val);
  }

  protected setColorScheme(event: Event): void {
    this.settings.colorScheme.set((event.target as HTMLSelectElement).value as ColorSchemeChoice);
  }

  protected setAnimations(event: Event): void {
    this.settings.animations.set((event.target as HTMLInputElement).checked);
  }

  protected setShowThousandths(event: Event): void {
    this.settings.showThousandths.set((event.target as HTMLInputElement).checked);
  }

  protected setCompactColors(event: Event): void {
    this.settings.compactColors.set((event.target as HTMLInputElement).checked);
  }

  protected setShowLapTimes(event: Event): void {
    this.settings.showMassStartLapTimes.set((event.target as HTMLInputElement).checked);
  }

  /** Switches off the Angular animations (the reordering of rows and the folding of groups) with the setting. */
  @HostBinding('@.disabled') get animationsDisabled(): boolean { return !this.settings.animations.value; }

  constructor() {
    // the stylesheet stills the CSS animations and transitions under this attribute
    this.settings.animations.changes$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(on => {
      document.documentElement.setAttribute('data-animations', on ? 'on' : 'off');
    });
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
    let latest = 0;
    let result: { distanceId: string; label: string } | null = null;
    for (const distance of distances) {
      if (distance.isMassStart) continue;
      const groups = this.mergedHeatGroups(distance);
      const live = findLiveHeat(groups);
      if (live && live.updatedAt >= latest) {
        latest = live.updatedAt;
        result = { distanceId: distance.id, label: groups[live.index].label };
      }
    }
    return result;
  }

  protected isActiveHeatRow(distanceId: string, label: string): boolean {
    return this.activeHeatKey?.distanceId === distanceId && this.activeHeatKey?.label === label;
  }

  protected badgeTextClass(lane: string): string {
    const light = ['white', 'yellow', 'orange', 'pink', 'lime'];
    return light.includes((lane || '').toLowerCase()) ? 'text-dark' : 'text-white';
  }

  protected raceListKey = raceListKey;
  protected readonly timedDistanceLapSchedule = timedDistanceLapScheduleUtil;
  protected readonly timedDistanceTotalLaps = timedDistanceTotalLapsUtil;
  protected readonly trimmedRaces = trimmedRacesUtil;
  protected readonly heatGroupLaneColors = heatGroupLaneColorsUtil;

  /**
   * Returns true when the race at raceIdx is the first competitor of a new
   * standings group (different lapsCount from the previous race), so we can
   * render a small visual gap between groups.
   */
  protected isFirstInNewGroup(distance: ProcessedDistance, raceIdx: number): boolean {
    const races = distance.processedRaces;
    if (!races || raceIdx <= 0 || raceIdx >= races.length) return false;
    return races[raceIdx].laps_count !== races[raceIdx - 1].laps_count;
  }

  /**
   * Returns the StandingsGroup that contains the given race id, or null.
   * Used to render a group divider above the first member of each group.
   */
  protected groupForRace(distance: ProcessedDistance, raceId: string): StandingsGroup | null {
    if (!distance.standingsGroups) return null;
    return distance.standingsGroups.find(g => g.races[0]?.id === raceId) ?? null;
  }

  /** Returns the display name for a standings group. */
  protected groupDisplayName(group: StandingsGroup, isFirst: boolean, anyFinished = false): string {
    if (group.isOthers) return this.ts.t('tailOfRace');
    if (isFirst && !anyFinished) return this.ts.t('headOfRace');
    return this.ts.t('groupLabel', { n: group.groupNumber });
  }

  /**
   * Returns heat groups for rendering, merging consecutive heats where the
   * first has only white/red lanes and the second has only yellow/blue lanes.
   */
  protected mergedHeatGroups(distance: ProcessedDistance): { label: string; races: (CompetitorUpdate | null)[] }[] {
    return mergeHeatGroups(
      distance.heatGroups,
      (n) => this.ts.t('heatLabel', { n }),
      (a, b) => this.ts.t('heatMergedLabel', { a, b }),
    );
  }

  /** Max trimmed lane count across all heat groups in a distance, so narrower heats don't spread wider than their siblings. */
  protected distanceMaxLaneCount(groups: MergedHeatGroup<CompetitorUpdate>[]): number {
    return Math.max(0, ...groups.map(g => this.trimmedRaces(g.races).length));
  }

  protected setFollow(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.settings.follow.set(checked);
    this.autoFollow.restart();
  }

/** True when a timed race counts as complete: all laps done OR has an invalid_reason. */
  private timedRaceComplete(race: CompetitorUpdate, distanceMeters: number): boolean {
    return timedRaceCompleteUtil(race, distanceMeters);
  }

  /** Number of completed races in a timed distance. */
  protected timedCompletedCount(distance: ProcessedDistance): number {
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
  protected isDistanceDone(distance: ProcessedDistance): boolean {
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
  if (connection === 'No competition') return { titleKey: 'feedNoCompetitionTitle', bodyKey: 'feedNoCompetitionBody' };
  if (connection === 'Error' || connection === 'Disconnected') return { titleKey: 'feedDisconnectedTitle', bodyKey: 'feedDisconnectedBody' };
  if (feed?.state === 'not_live') return { titleKey: 'feedNotLiveTitle', bodyKey: 'feedNotLiveBody', message: feed.message };
  if (feed?.state === 'unavailable') return { titleKey: 'feedUnavailableTitle', bodyKey: 'feedUnavailableBody' };
  if (feed?.state === 'ok') return { titleKey: 'feedEmptyTitle', bodyKey: 'feedEmptyBody' };
  return waitedLong ? { titleKey: 'feedSlowTitle', bodyKey: 'feedSlowBody' } : null;
}
