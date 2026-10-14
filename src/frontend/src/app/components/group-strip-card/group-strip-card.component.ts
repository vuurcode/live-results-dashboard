import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output, inject } from '@angular/core';
import { BadgeModule, CardModule } from '@coreui/angular';
import { StandingsGroup } from '../../models/data.models';
import { TranslateService } from '../../services/translate.service';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { isRecentUpdate } from '../../logic/time.util';
import { raceListAnimation, groupCardAnimation, raceListKey } from '../dashboard/dashboard.animations';

@Component({
  selector: 'app-group-strip-card',
  standalone: true,
  imports: [BadgeModule, CardModule, TranslatePipe],
  templateUrl: './group-strip-card.component.html',
  styleUrls: ['./group-strip-card.component.scss'],
  animations: [raceListAnimation, groupCardAnimation],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GroupStripCardComponent {
  @Input({ required: true }) group!: StandingsGroup;
  @Input() groupIndex = 0;
  @Input() anyFinished = false;
  @Input() selectedRaceId: string | null = null;

  @Output() raceSelect = new EventEmitter<string>();

  private ts = inject(TranslateService);

  isRecentUpdate = isRecentUpdate;

  get firstGroup(): boolean {
    return this.groupIndex === 0;
  }

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

  raceListKey = raceListKey;
}
