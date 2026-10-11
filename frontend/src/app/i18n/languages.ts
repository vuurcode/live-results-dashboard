import { de } from './de';
import { en } from './en';
import { es } from './es';
import { fr } from './fr';
import { it } from './it';
import { nb } from './nb';
import { nl } from './nl';
import { sv } from './sv';
import type { Translations } from './translations';

/** The supported languages by their ISO 639-1 code; English is the fallback. */
export const LANGUAGES: Readonly<Record<string, Translations>> = { en, nl, de, fr, it, es, nb, sv };

export const DEFAULT_LANGUAGE = 'en';

/** The language for a browser language tag such as `nb-NO`; Nynorsk (`nn`) and the macro language (`no`) use Norwegian Bokmål. */
export function pickLanguage(tag: string | undefined): string {
  const code = (tag || DEFAULT_LANGUAGE).toLowerCase().split('-')[0];
  const language = code === 'no' || code === 'nn' ? 'nb' : code;
  return language in LANGUAGES ? language : DEFAULT_LANGUAGE;
}
