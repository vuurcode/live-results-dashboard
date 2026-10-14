import { expect, test } from '@playwright/test';

// The page follows the browser language; Norwegian tags (nb, nn, no) all use Bokmål.
const LANGUAGES = [
  ['de-DE', 'de'],
  ['fr-FR', 'fr'],
  ['it-IT', 'it'],
  ['es-ES', 'es'],
  ['nb-NO', 'nb'],
  ['nn-NO', 'nb'],
  ['sv-SE', 'sv'],
  ['ja-JP', 'en'],
] as const;

for (const [locale, lang] of LANGUAGES) {
  test.describe(locale, () => {
    test.use({ locale });
    test(`shows the page in ${lang}`, async ({ page }) => {
      await page.goto('/?competitionId=e2e-pairs');
      await expect(page.locator('html')).toHaveAttribute('lang', lang);
      await expect(page).toHaveTitle(/Live Results Experiment - Proof of Concept/);
    });
  });
}
