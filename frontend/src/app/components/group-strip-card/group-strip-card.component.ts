import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { BadgeModule, CardModule } from '@coreui/angular';
import { StandingsGroup, CompetitorUpdate } from '../../models/data.models';
import { TranslateService } from '../../services/translate.service';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { isRecentUpdate } from '../../logic/time.util';
import { raceListAnimation, groupCardAnimation } from '../dashboard/dashboard.animations';

@Component({
  selector: 'app-group-strip-card',
  standalone: true,
  imports: [CommonModule, BadgeModule, CardModule, TranslatePipe],
  templateUrl: './group-strip-card.component.html',
  styleUrls: ['../dashboard/dashboard.component.scss'],
  animations: [raceListAnimation, groupCardAnimation],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GroupStripCardComponent {
  @Input({ required: true }) group!: StandingsGroup;
  @Input() firstGroup = false;
  @Input() groupIndex = 0;
  @Input() anyFinished = false;
  @Input() selectedRaceId: string | null = null;

  @Output() raceSelect = new EventEmitter<string>();

  private ts = inject(TranslateService);

  isRecentUpdate = isRecentUpdate;

  /** Returns d-none classes so card at groupIndex is hidden when viewport is too narrow. */
  groupCardClass(groupIndex: number): string {
    if (groupIndex === 0) return '';
    if (groupIndex === 1) return 'd-none d-sm-block';
    if (groupIndex === 2) return 'd-none d-md-block';
    if (groupIndex === 3) return 'd-none d-lg-block';
    return 'd-none d-xl-block';
  }

  /** Returns the display name for a standings group. */
  groupDisplayName(group: StandingsGroup, isFirst: boolean, anyFinished = false): string {
    if (group.isOthers) return this.ts.t('tailOfRace');
    if (isFirst && !anyFinished) return this.ts.t('headOfRace');
    return this.ts.t('groupLabel', { n: group.groupNumber });
  }

  /** Stable animation state key — changes whenever the sort order of the list changes. */
  raceListKey(races: CompetitorUpdate[]): string {
    return races.map(r => r.id).join(',');
  }
}
