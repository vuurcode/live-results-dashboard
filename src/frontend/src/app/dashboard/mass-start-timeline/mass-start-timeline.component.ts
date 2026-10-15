import { AfterViewInit, ChangeDetectorRef, Component, DoCheck, ElementRef, EventEmitter, Input, NgZone, OnDestroy, Output, ViewChild, inject } from '@angular/core';
import { BadgeModule } from '@coreui/angular';
import { CompetitorUpdate } from '../../results/data.models';
import { TranslatePipe } from '../../i18n/translate.pipe';
import { isRecentUpdate } from '../../results/time.util';
import { layoutTimeline, timelineGaps, timelineScale } from '../../results/timeline.util';

interface PlacedRacer {
  race: CompetitorUpdate;
  gapText: string;
  offset: number;
  row: number;
}

const ROW_REM = 2;
// badge widths, estimated at the default font size and scaled with the font size of the page
const NUMBER_PX = 44; // start number badge, padding and borders
const CHAR_PX = 8;

/**
 * The unfinished racers of a mass start along one time axis: the leader at the right edge, the others to the left of
 * it by their gap behind the leader. The width stands for the slowest lap time; a racer who would touch another one
 * moves to a line below.
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
  protected rows = 1;
  protected readonly rowRem = ROW_REM;
  protected isRecentUpdate = isRecentUpdate;

  private width = 0;
  private unit = 1;
  private signature = '';
  private observer: ResizeObserver | null = null;

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
    const scale = timelineScale(this.races);
    const gaps = timelineGaps(this.races, scale);
    const texts = new Map(gaps.map(({ race, gap }) => [race.id, race === gaps[0].race ? '' : `+${gap.toFixed(1)}s`]));
    const items = gaps.map(({ race, gap }) => ({
      id: race.id,
      gap,
      width: (NUMBER_PX + CHAR_PX * (race.name.length + (texts.get(race.id)?.length ?? 0))) * this.unit,
    }));
    const placements = new Map(layoutTimeline(items, scale, this.width).map((p) => [p.id, p]));
    this.placed = gaps.map(({ race }) => {
      const p = placements.get(race.id)!;
      return { race, gapText: texts.get(race.id) ?? '', offset: p.offset, row: p.row };
    });
    this.rows = Math.max(1, ...this.placed.map((p) => p.row + 1));
  }
}
