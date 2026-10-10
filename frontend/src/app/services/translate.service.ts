import { Injectable, inject } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { en, nl, Translations } from '../i18n/translations';

export type TranslationKey = keyof Translations;

@Injectable({ providedIn: 'root' })
export class TranslateService {
  private sanitizer = inject(DomSanitizer);
  private readonly translations: Translations = (() => {
    const dutch = (navigator.language || 'en').toLowerCase().startsWith('nl');
    document.documentElement.lang = dutch ? 'nl' : 'en';
    return dutch ? nl : en;
  })();

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
