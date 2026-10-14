import { describe, expect, it } from 'vitest';
import { LANGUAGES, pickLanguage } from './languages';
import { en } from './en';

describe('pickLanguage', () => {
  it('picks the language of a browser tag', () => {
    expect(pickLanguage('nl-NL')).toBe('nl');
    expect(pickLanguage('DE-at')).toBe('de');
    expect(pickLanguage('fr')).toBe('fr');
    expect(pickLanguage('it-IT')).toBe('it');
    expect(pickLanguage('es-419')).toBe('es');
    expect(pickLanguage('sv-SE')).toBe('sv');
  });

  it('maps the Norwegian tags to Bokmål', () => {
    for (const tag of ['nb-NO', 'nn-NO', 'no', 'no-NO']) expect(pickLanguage(tag)).toBe('nb');
  });

  it('falls back to English', () => {
    expect(pickLanguage('ja-JP')).toBe('en');
    expect(pickLanguage('')).toBe('en');
    expect(pickLanguage(undefined)).toBe('en');
  });
});

describe('translations', () => {
  for (const [code, translations] of Object.entries(LANGUAGES)) {
    it(`${code} has every text, with the same placeholders as English`, () => {
      expect(Object.keys(translations).sort()).toEqual(Object.keys(en).sort());
      for (const [key, text] of Object.entries(translations)) {
        const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
        expect(placeholders(text), key).toEqual(placeholders((en as unknown as Record<string, string>)[key]));
      }
    });
  }
});
