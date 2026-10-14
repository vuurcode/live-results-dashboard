import { expect, test } from '@playwright/test';

// The page follows the browser language; Norwegian tags (nb, nn, no) all use Bokmål.
const LANGUAGES = [
  ['de-DE', 'de', 'Live-Ergebnisse'],
  ['fr-FR', 'fr', 'Résultats en direct'],
  ['it-IT', 'it', 'Risultati in diretta'],
  ['es-ES', 'es', 'Resultados en directo'],
  ['nb-NO', 'nb', 'Live resultater'],
  ['nn-NO', 'nb', 'Live resultater'],
  ['sv-SE', 'sv', 'Liveresultat'],
  ['ja-JP', 'en', 'Live Results Dashboard'],
] as const;

for (const [locale, lang, title] of LANGUAGES) {
  test.describe(locale, () => {
    test.use({ locale });
    test(`shows the page in ${lang}`, async ({ page }) => {
      await page.goto('/?competitionId=e2e-pairs');
      await expect(page.locator('html')).toHaveAttribute('lang', lang);
      await expect(page).toHaveTitle(new RegExp(title));
    });
  });
}
