import { Injectable } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { en, nl, Translations } from '../i18n/translations';

export type TranslationKey = keyof Translations;

@Injectable({ providedIn: 'root' })
export class TranslateService {
  private readonly translations: Translations;

  constructor(private sanitizer: DomSanitizer) {
    const lang = (navigator.language || 'en').toLowerCase();
    this.translations = lang.startsWith('nl') ? nl : en;
  }

  t(key: TranslationKey, params?: Record<string, string | number>): string {
    let str: string = this.translations[key] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        str = str.replace(`{${k}}`, String(v));
      }
    }
    return str;
  }

  html(key: TranslationKey, params?: Record<string, string | number>): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(this.t(key, params));
  }
}
