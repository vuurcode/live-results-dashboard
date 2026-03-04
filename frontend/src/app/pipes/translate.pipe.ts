import { Pipe, PipeTransform } from '@angular/core';
import { TranslateService, TranslationKey } from '../services/translate.service';

@Pipe({ name: 'translate', standalone: true, pure: true })
export class TranslatePipe implements PipeTransform {
  constructor(private ts: TranslateService) {}

  transform(key: TranslationKey, params?: Record<string, string | number>): string {
    return this.ts.t(key, params);
  }
}
