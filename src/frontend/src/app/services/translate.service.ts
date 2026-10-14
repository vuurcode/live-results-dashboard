import { Injectable, inject } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { LANGUAGES, pickLanguage } from '../i18n/languages';
import type { Translations } from '../i18n/translations';

export type TranslationKey = keyof Translations;

@Injectable({ providedIn: 'root' })
export class TranslateService {
  private sanitizer = inject(DomSanitizer);
  private readonly language = pickLanguage(navigator.language);
  private readonly translations: Translations = LANGUAGES[this.language];

  constructor() {
    document.documentElement.lang = this.language;
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

  /** A number with at most two decimals (at least `minDecimals`), in the decimal separator of the language. */
  num(n: number, minDecimals = 0): string {
    const [whole, fraction = ''] = String(Math.round(n * 100) / 100).split('.');
    const decimals = fraction.padEnd(minDecimals, '0');
    return decimals ? `${whole}${this.language === 'en' ? '.' : ','}${decimals}` : whole;
  }

  html(key: TranslationKey, params?: Record<string, string | number>): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(this.t(key, params));
  }
}
