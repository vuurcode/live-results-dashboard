import { AfterViewInit, ChangeDetectorRef, Component, DoCheck, ElementRef, EventEmitter, Input, NgZone, OnDestroy, Output, ViewChild, inject } from '@angular/core';
import { BadgeModule } from '@coreui/angular';
import { CompetitorUpdate } from '../../results/data.models';
import { TranslatePipe } from '../../i18n/translate.pipe';
import { parseSeconds } from '../../results/time.util';
import { TIMELINE_SECONDS, layoutTimeline, timelineGaps } from '../../results/timeline.util';

interface Tick {
  seconds: number;
  offset: number;
  label: boolean;
}

interface PlacedRacer {
  race: CompetitorUpdate;
  gapText: string;
  offset: number;
  row: number;
  /** Before the start there is no leader or gap: the racers sit at the left edge instead of hanging off the right */
  fromLeft: boolean;
  /** The racer has not reported the leader's current lap yet: they show where they were on the previous lap */
  stale: boolean;
}

const ROW_REM = 2;
// badge widths, estimated at the default font size and scaled with the font size of the page
const LANE_PAD_REM = 0.75; // room above and below the racers so the finish line shows on its own
const NUMBER_PX = 28; // start number badge without its digits, padding and borders
const CHAR_PX = 8;
const LABEL_STEPS = [1, 2, 5, 10, 15, 30, 60];
const LABEL_PX = 48; // room a tick label needs, at the default font size
const FINE_SECONDS = 5; // the first seconds get a dotted line every tenth of a second
const MIN_LINE_PX = 4; // grid lines closer together than this are left out

/**
 * The unfinished racers of a mass start along one time axis: the leader at the right edge, the others to the left of
 * it by their gap behind the leader, going down the rows like stairs, with a row added where they would collide. The width stands for a fixed number of seconds, and
 * racers further behind the leader than that sit at the left edge.
 */
@Component({
  selector: 'app-mass-start-timeline',
  standalone: true,
  imports: [BadgeModule, TranslatePipe],
  templateUrl: './mass-start-timeline.component.html',
  styleUrls: ['./mass-start-timeline.component.scss'],
})
export class MassStartTimelineComponent implements AfterViewInit, DoCheck, OnDestroy {
  private cdr = inject(ChangeDetectorRef);
  private zone = inject(NgZone);

  @Input({ required: true }) races: CompetitorUpdate[] = [];
  @Input() selectedRaceIds: ReadonlySet<string> = new Set();
  @Output() readonly raceSelect = new EventEmitter<string>();
  @ViewChild('lane', { static: true }) private lane!: ElementRef<HTMLElement>;

  protected placed: PlacedRacer[] = [];
  protected ticks: Tick[] = [];
  /** Offsets of the lines for every tenth of a second, left out where they would be closer together than MIN_LINE_PX */
  protected fineOffsets: number[] = [];
  protected rows = 1;
  /** The lap the leader has completed while the finish line is under way; the line starts over whenever it changes */
  protected lineKeys: number[] = [];
  /** How long the finish line takes for its run: half again the scale, the last part of it slowing down */
  protected readonly lineSeconds = TIMELINE_SECONDS * 1.5;
  /** Every racer on the timeline has crossed the line for the current lap: it sprints off and fades out from where it is */
  protected lineDone = false;
  protected lineFromPx = 0;
  /** Seconds the finish line had been under way when its animation was created, by the race clock */
  protected lineElapsed = 0;
  /** Racers whose previous-lap position the finish line has passed without their new time coming in */
  protected readonly faded = new Set<string>();
  protected readonly rowRem = ROW_REM;
  protected readonly padRem = LANE_PAD_REM;

  private lineLap = 0;
  private lineShown = false;
  private lineBegan = 0; // when the animation of the current lap was created, in performance.now() milliseconds
  private lineClock = 0; // the leader's race clock at the current lap, in milliseconds
  private clockOffset = Infinity; // performance.now() minus the race clock, at the least delayed update
  private readonly reported = new Map<string, string>(); // per racer the laps and time of the update last seen
  protected width = 0;
  private unit = 1;
  private signature = '';
  private observer: ResizeObserver | null = null;
  private watching = 0;

  ngAfterViewInit(): void {
    this.observer = new ResizeObserver(() => {
      const width = this.lane.nativeElement.clientWidth;
      const unit = parseFloat(getComputedStyle(this.lane.nativeElement).fontSize) / 16 || 1;
      if (width === this.width && unit === this.unit) return;
      this.zone.run(() => {
        this.width = width;
        this.unit = unit;
        this.layout();
        this.cdr.markForCheck();
      });
    });
    this.observer.observe(this.lane.nativeElement);
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
    cancelAnimationFrame(this.watching);
  }

  // The races are updated in place, so the layout follows what the racers show rather than the input reference.
  ngDoCheck(): void {
    const signature = this.races.map((r) => `${r.id}:${r.laps_count}:${r.total_time}:${r.finished_rank}`).join('|');
    if (signature === this.signature) return;
    this.signature = signature;
    this.layout();
  }

  protected select(id: string): void {
    this.raceSelect.emit(id);
  }

  private layout(): void {
    if (this.races.length && this.races.every((r) => r.laps_count === 0 && r.finished_rank == null)) {
      this.layoutGrid();
      this.finishLine(0, false);
      return;
    }
    const gaps = timelineGaps(this.races, TIMELINE_SECONDS); // a racer further behind than the timeline is wide sits at its left edge
    const leaderLaps = gaps[0]?.race.laps_count ?? 0;
    const texts = gaps.map(({ gap }, i) => (i === 0 ? '' : `+${gap.toFixed(1)}s`));
    const items = gaps.map(({ race, gap }, i) => ({
      id: race.id,
      gap,
      width: (NUMBER_PX + CHAR_PX * (race.start_number.length + race.name.length + texts[i].length)) * this.unit,
    }));
    const rows = new Map(this.placed.filter((p) => !p.fromLeft).map((p) => [p.race.id, p.row]));
    this.placed = layoutTimeline(items, TIMELINE_SECONDS, this.width, rows).map((p, i) => ({
      race: gaps[i].race,
      gapText: texts[i],
      offset: p.offset,
      row: p.row,
      fromLeft: false,
      stale: gaps[i].race.laps_count < leaderLaps,
    }));
    this.ticks = this.gridTicks();
    this.rows = Math.max(1, ...this.placed.map((p) => p.row + 1));
    this.timeLine(gaps, leaderLaps);
    this.finishLine(leaderLaps, this.races.every((race) => race.laps_count >= leaderLaps));
  }

  // The line is timed from the data, not from when an update arrived. The totals are the race clock, which runs along
  // with the wall clock, and an update never arrives before its time: the least delayed update seen so far gives the
  // offset between the two, so it only ever moves back. The leader crossed at their total, which puts the start of the
  // line at the offset plus that.
  private timeLine(gaps: { race: CompetitorUpdate; gap: number }[], leaderLaps: number): void {
    if (!gaps.length) return;
    const now = performance.now();
    if (leaderLaps < this.lineLap) { // the results started over
      this.clockOffset = Infinity;
      this.reported.clear();
    }
    if (leaderLaps !== this.lineLap) {
      this.lineBegan = now;
      this.lineClock = parseSeconds(gaps[0].race.total_time) * 1000;
    }
    for (const { race } of gaps) {
      const update = `${race.laps_count}:${race.total_time}`;
      if (this.reported.get(race.id) === update) continue;
      this.reported.set(race.id, update);
      this.clockOffset = Math.min(this.clockOffset, now - parseSeconds(race.total_time) * 1000);
    }
    if (Number.isFinite(this.clockOffset)) this.lineElapsed = Math.max(0, this.lineBegan - this.clockOffset - this.lineClock) / 1000;
  }

  // A racer who is slower than the previous lap stays where they were until the finish line reaches that spot, which
  // is when they fade out; a racer who reports in time moves to the new place instead.
  private watchStale(): void {
    this.faded.forEach((id) => {
      if (!this.placed.some((p) => p.race.id === id && p.stale)) this.faded.delete(id);
    });
    if (this.watching || !this.placed.some((p) => p.stale && !this.faded.has(p.race.id))) return;
    this.zone.runOutsideAngular(() => {
      const step = () => {
        this.watching = 0;
        const line = this.lane.nativeElement.querySelector('.timeline-finish');
        const waiting = this.placed.filter((p) => p.stale && !this.faded.has(p.race.id));
        if (!line || !waiting.length) return;
        const travelled = -new DOMMatrixReadOnly(getComputedStyle(line).transform).m41;
        const passed = waiting.filter((p) => p.offset <= travelled);
        if (passed.length) {
          this.zone.run(() => {
            passed.forEach((p) => this.faded.add(p.race.id));
            this.cdr.markForCheck();
          });
        }
        if (passed.length < waiting.length) this.watching = requestAnimationFrame(step);
      };
      this.watching = requestAnimationFrame(step);
    });
  }

  // The finish line leaves the leader's side when the leader has crossed it and then moves along the axis at the pace of
  // the scale, so a racer's badge meets it as they cross. Once every racer has crossed it sprints to the far side and
  // fades out; it starts over with the leader's next lap.
  private finishLine(leaderLaps: number, everyoneCrossed: boolean): void {
    if (leaderLaps !== this.lineLap) {
      this.lineLap = leaderLaps;
      this.lineDone = false;
      this.faded.clear();
      this.lineShown = this.width > 0; // a lap that began while the timeline was hidden (a closed accordion) has no line to animate
    }
    this.lineKeys = leaderLaps > 0 && this.lineShown ? [leaderLaps] : [];
    if (everyoneCrossed && leaderLaps > 0 && !this.lineDone) {
      const line = this.lane.nativeElement.querySelector('.timeline-finish');
      this.lineFromPx = line ? new DOMMatrixReadOnly(getComputedStyle(line).transform).m41 : 0;
      this.lineDone = true;
    }
    this.watchStale();
  }

  // The racers of a mass start that has not started: one under the other at the left edge.
  private layoutGrid(): void {
    if (this.width <= 0) return;
    this.placed = this.races.map((race, row) => ({ race, gapText: '', offset: 0, row, fromLeft: true, stale: false }));
    this.ticks = this.gridTicks();
    this.rows = Math.max(1, this.races.length);
  }

  // A grid line every second (when they are not too close together), a label on every few of them where the labels fit.
  private gridTicks(): Tick[] {
    if (this.width <= 0) return [];
    const pxPerSecond = this.width / TIMELINE_SECONDS;
    const labelEvery = LABEL_STEPS.find((s) => s * pxPerSecond >= LABEL_PX * this.unit) ?? LABEL_STEPS[LABEL_STEPS.length - 1];
    const lineEvery = pxPerSecond >= MIN_LINE_PX * this.unit ? 1 : labelEvery;
    const offset = (s: number) => s * pxPerSecond;
    this.fineOffsets = pxPerSecond / 10 >= MIN_LINE_PX * this.unit ? Array.from({ length: FINE_SECONDS * 10 + 1 }, (_, i) => (i / 10) * pxPerSecond).filter((_, i) => i % 10) : [];
    const ticks: Tick[] = [];
    for (let s = 0; s <= TIMELINE_SECONDS; s += lineEvery) {
      // both ends are always labelled, the ones between where the labels fit
      const label = s === 0 || s === TIMELINE_SECONDS || (s % labelEvery === 0 && offset(s) >= LABEL_PX * this.unit && offset(s) <= this.width - LABEL_PX * this.unit);
      ticks.push({ seconds: s, offset: offset(s), label });
    }
    return ticks;
  }
}
