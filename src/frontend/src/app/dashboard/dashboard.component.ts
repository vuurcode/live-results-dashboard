import { findLiveHeat } from '../results/live-heat';
import { ChangeDetectionStrategy, ChangeDetectorRef, Component, DestroyRef, ElementRef, HostBinding, HostListener, OnInit, afterEveryRender, afterNextRender, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Title } from '@angular/platform-browser';
import { DataService } from '../results/data.service';
import type { ColorSchemeChoice } from '../color-scheme';
import { parseInteger, parseNumber, SettingsService } from '../settings/settings.service';
import { FeedStatus, TodayCompetition, ProcessedDistance, StandingsGroup, CompetitorUpdate } from '../results/data.models';
import { Observable, combineLatest, concat, filter, from, map, merge, of, shareReplay, startWith, switchMap, take, timer } from 'rxjs';
import { TranslateService, TranslationKey } from '../i18n/translate.service';
import { TranslatePipe } from '../i18n/translate.pipe';
import { MassStartTimelineComponent } from './mass-start-timeline/mass-start-timeline.component';
import { IndividualHeatCardComponent } from './individual-heat-card/individual-heat-card.component';
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
  individualDistanceLapSchedule as individualDistanceLapScheduleUtil,
  individualDistanceTotalLaps as individualDistanceTotalLapsUtil,
  individualRaceComplete as individualRaceCompleteUtil,
  pairHeatGroups,
  trimmedRaces as trimmedRacesUtil,
  heatGroupLaneColors as heatGroupLaneColorsUtil,
  type MergedHeatGroup,
} from '../results/heats.util';
import { lastViewedVenue, preselectCompetition, rememberVenue } from '../results/competition.util';
import { SettledScroller } from './scroll.util';
import { UserScrollGuard } from './user-scroll';
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
    MassStartTimelineComponent,
    IndividualHeatCardComponent,
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

  protected initialLiveId: string | null = null;
  protected liveEventNumber: number | null = null;
  /** Mass start competitors the viewer follows; several can be selected at once. A new set on every change, for the OnPush rows. */
  protected selectedRaceIds: ReadonlySet<string> = new Set();
  protected displaySettingsOpen = false;
  protected activeHeatKey: { distanceId: string; label: string } | null = null;

  private readonly scroller = new SettledScroller(() => this.settings.animations.value);
  private readonly autoFollow = new AutoFollow({
    follow: () => this.settings.follow.value,
    heatGroups: (distance) => this.mergedHeatGroups(distance),
    scrollTo: (selector, anchor) => (this.viewerScrolled ? undefined : this.scroller.scrollTo(selector, anchor)),
    liveDistanceChanged: (live) => {
      this.initialLiveId = live.id;
      this.liveEventNumber = live.eventNumber;
      this.cdr.markForCheck();
    },
  });
  /** The viewer scrolled themselves: the page stays where they put it until the live heat is in view again and they have stopped. */
  private viewerScrolled = false;
  private resumeTimer: ReturnType<typeof setInterval> | null = null;
  private readonly userScroll = new UserScrollGuard(() => this.viewerTookOver());
  private resizeObserver: ResizeObserver | null = null;

  // Hide mass start settings if no mass start present
  protected hasMassStart$: Observable<boolean>;

  /** The competitions of today, asked again every few minutes so new competitions show up and finished ones drop off while the page stays open. */
  protected readonly todayCompetitions$: Observable<TodayCompetition[]> = merge(timer(0, 5 * 60_000), this.dataService.competitionsChanged$.pipe(map(() => -1))).pipe(
    filter(n => n === 0 || document.visibilityState !== 'hidden'), // nobody sees the list of a hidden page
    switchMap(() => from(this.dataService.todayCompetitions())),
    shareReplay({ bufferSize: 1, refCount: true }), // the list in the page and the venue preselection share one request
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

  /** Opens or folds away the settings panel. */
  protected toggleSettings(): void {
    this.displaySettingsOpen = !this.displaySettingsOpen;
    this.publishTopbarBottom();
  }

  /** The settings panel hangs under the top bar, which is lower than its pinned spot while the page is near the top: the panel's height limit is the room left below the bar. */
  @HostListener('window:scroll')
  @HostListener('window:resize')
  protected publishTopbarBottom(): void {
    const bar: HTMLElement | null = this.host.nativeElement.querySelector('.topbar');
    if (bar) this.host.nativeElement.style.setProperty('--topbar-bottom', `${Math.max(0, bar.getBoundingClientRect().bottom)}px`);
  }

  /** A click anywhere outside the settings buttons and panels folds them away. */
  @HostListener('document:click', ['$event'])
  protected closeSettingsOnOutsideClick(event: MouseEvent): void {
    if (!this.displaySettingsOpen) return;
    if (event.composedPath().some((el) => el instanceof Element && el.classList.contains('topbar-settings-group'))) return;
    this.closeSettings();
  }

  /** Escape folds the settings panel away. */
  @HostListener('document:keydown.escape')
  protected closeSettings(): void {
    this.displaySettingsOpen = false;
  }

  protected isTodayCompetition(competitions: TodayCompetition[], id: string): boolean {
    return competitions.some((m) => m.id === id);
  }

  protected selectRace(id: string): void {
    const next = new Set(this.selectedRaceIds);
    if (!next.delete(id)) next.add(id);
    this.selectedRaceIds = next;
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
  protected stepLapVariance(event: Event, individual: boolean): void {
    if ((event as InputEvent).inputType) return;
    if (individual) this.setLapVarianceIndividual(event);
    else this.setLapVariance(event);
  }

  protected setLapVarianceIndividual(event: Event): void {
    const val = parseNumber((event.target as HTMLInputElement).value);
    if (val !== undefined) this.settings.lapVarianceIndividual.set(val);
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
    // The venue of the viewed competition is remembered; a page without a competition (or with one the backend does not know)
    // opens the live competition of the remembered venue, else its first.
    combineLatest([this.todayCompetitions$, this.dataService.status$]).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(([competitions, { status }]) => {
      const current = competitions.find((c) => c.id === this.dataService.competitionId);
      if (current) rememberVenue(current.venue.code);
      if (status !== 'No competition') return;
      const target = preselectCompetition(competitions, lastViewedVenue());
      if (target && target.id !== this.dataService.competitionId) window.location.replace(`?competitionId=${encodeURIComponent(target.id)}`);
    });
    // the browser would restore the previous scroll position on reload, after the page has landed on the live distance
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    this.destroyRef.onDestroy(() => this.resizeObserver?.disconnect());
    const detach = this.userScroll.attach();
    this.destroyRef.onDestroy(() => {
      detach();
      if (this.resumeTimer) clearInterval(this.resumeTimer);
    });
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

  private viewerTookOver(): void {
    this.viewerScrolled = true;
    this.scroller.cancel();
    this.resumeTimer ??= setInterval(() => this.resumeFollowing(), 500);
  }

  /** Follows the live heat again once the viewer has stopped scrolling and the heat is in view. */
  private resumeFollowing(): void {
    if (this.userScroll.scrolling() || !this.liveHeatInView()) return;
    clearInterval(this.resumeTimer ?? undefined);
    this.resumeTimer = null;
    this.viewerScrolled = false;
    this.autoFollow.restart();
    this.sortedDistances$.pipe(take(1)).subscribe(distances => this.autoFollow.update(distances));
  }

  private liveHeatInView(): boolean {
    const el = document.querySelector('[data-live]') ?? (this.initialLiveId ? document.querySelector(`[data-distance-body="${this.initialLiveId}"]`) : null);
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < window.innerHeight;
  }

  protected isActiveHeatRow(distanceId: string, label: string): boolean {
    return this.activeHeatKey?.distanceId === distanceId && this.activeHeatKey?.label === label;
  }

  protected badgeTextClass(lane: string): string {
    const light = ['white', 'yellow', 'orange', 'pink', 'lime'];
    return light.includes((lane || '').toLowerCase()) ? 'text-dark' : 'text-white';
  }

  protected raceListKey = raceListKey;
  protected readonly individualDistanceLapSchedule = individualDistanceLapScheduleUtil;
  protected readonly individualDistanceTotalLaps = individualDistanceTotalLapsUtil;
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

  /** Returns the heat groups for rendering, one row per heat. */
  protected mergedHeatGroups(distance: ProcessedDistance): { label: string; races: (CompetitorUpdate | null)[] }[] {
    return pairHeatGroups(distance.heatGroups, (n) => this.ts.t('heatLabel', { n }));
  }

  /** Whether the distance is skated by quartets: some pair skates on yellow or blue, so two pairs make up the four lanes of a row. */
  protected hasQuartet(groups: MergedHeatGroup<CompetitorUpdate>[]): boolean {
    return groups.some((g) => g.races.some((r) => r?.lane === 'yellow' || r?.lane === 'blue'));
  }

  /** Whether the heat is the yellow/blue pair that completes the quartet started by the heat before it. */
  protected isQuartetSecond(groups: MergedHeatGroup<CompetitorUpdate>[], index: number): boolean {
    return index > 0 && this.hasQuartet([groups[index]]) && !this.hasQuartet([groups[index - 1]]);
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

/** True when a individual race race counts as complete: all laps done OR has an invalid_reason. */
  private individualRaceComplete(race: CompetitorUpdate, distanceMeters: number): boolean {
    return individualRaceCompleteUtil(race, distanceMeters);
  }

  /** Number of completed races in a individual race distance. */
  protected individualCompletedCount(distance: ProcessedDistance): number {
    if (!distance.distanceMeters) return 0;
    return distance.processedRaces.filter(r => this.individualRaceComplete(r, distance.distanceMeters!)).length;
  }

  /** True when all races in a individual race distance are complete (finished or invalid). */
  private isIndividualDistanceDone(distance: ProcessedDistance): boolean {
    const total = distance.processedRaces.length;
    if (!distance.distanceMeters || total === 0) return false;
    return this.individualCompletedCount(distance) === total;
  }

  /** True when the distance should show the Done badge. */
  protected isDistanceDone(distance: ProcessedDistance): boolean {
    if (this.liveEventNumber !== null && distance.eventNumber < this.liveEventNumber) return true;
    if (!distance.isMassStart) return this.isIndividualDistanceDone(distance);
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
