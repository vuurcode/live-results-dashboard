import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output, inject } from '@angular/core';
import { BadgeModule, CardModule } from '@coreui/angular';
import { StandingsGroup } from '../../results/data.models';
import { TranslateService } from '../../i18n/translate.service';
import { TranslatePipe } from '../../i18n/translate.pipe';
import { isRecentUpdate } from '../../results/time.util';
import { raceListAnimation, groupCardAnimation, raceListKey } from '../dashboard.animations';

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
  private ts = inject(TranslateService);

  @Input({ required: true }) group!: StandingsGroup;
  @Input() groupIndex = 0;
  @Input() anyFinished = false;
  @Input() selectedRaceId: string | null = null;

  @Output() readonly raceSelect = new EventEmitter<string>();

  protected isRecentUpdate = isRecentUpdate;

  protected get firstGroup(): boolean {
    return this.groupIndex === 0;
  }

  /** Returns d-none classes so card at groupIndex is hidden when viewport is too narrow. */
  protected groupCardClass(groupIndex: number): string {
    if (groupIndex === 0) return '';
    if (groupIndex === 1) return 'd-none d-sm-block';
    if (groupIndex === 2) return 'd-none d-md-block';
    if (groupIndex === 3) return 'd-none d-lg-block';
    return 'd-none d-xl-block';
  }

  /** Returns the display name for a standings group. */
  protected groupDisplayName(group: StandingsGroup, isFirst: boolean, anyFinished = false): string {
    if (group.isOthers) return this.ts.t('tailOfRace');
    if (isFirst && !anyFinished) return this.ts.t('headOfRace');
    return this.ts.t('groupLabel', { n: group.groupNumber });
  }

  protected raceListKey = raceListKey;
}
