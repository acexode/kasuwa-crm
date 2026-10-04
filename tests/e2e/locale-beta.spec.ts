import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { DESIGN_MENU_LOCALES, LOCALE_SOURCES, localeLabel, translate } from '@kasuwa/i18n';
import { stack } from './support/stack';

/**
 * D-P1, as answered 2026-10-03: every language on the menu ships; one that no
 * named reviewer has signed off carries a Beta badge and a "help improve this
 * translation" link; a reviewer's sign-off removes it.
 *
 * One test per language on the design's menu, `locale=<tag>` in its title.
 *
 * WHAT EACH TEST EXPECTS IS READ FROM `packages/i18n`, NOT TYPED HERE. A
 * language is "signed off" when its `<tag>.review.json` says `reviewed` (or it
 * is the source language). When a reviewer signs one off, its test flips from
 * "shows Beta" to "shows no Beta" with no edit to this file — which is the
 * only way this spec stays true the day after a reviewer is named.
 *
 * Against the default server (every flag at its default) on `P01/1`, the
 * first screen anyone sees and the one the menu was designed on.
 */

function signedOff(locale: string): boolean {
  const status = LOCALE_SOURCES[locale]?.review.status;
  return status === 'reviewed' || status === 'source';
}

async function openMenu(page: Page): Promise<void> {
  // By test id: its accessible name is "Language: …" in whichever language
  // the page is in, which is the point of the next few lines.
  await page.getByTestId('language-button').click();
  await expect(page.getByRole('listbox')).toBeVisible();
}

function option(page: Page, locale: string) {
  return page.locator(`[role="option"][lang="${locale}"]`);
}

test.describe('the language menu marks unreviewed languages Beta (D-P1) @locale-beta', () => {
  for (const locale of DESIGN_MENU_LOCALES) {
    const beta = !signedOff(locale);

    test(`locale=${locale} ${beta ? 'shows a Beta badge and the help link' : 'shows no Beta badge'} @locale-beta`, async ({
      page,
    }) => {
      const { webUrl } = stack();
      await page.goto(webUrl);
      await expect(page.locator('[data-screen="P01/1"]')).toBeVisible();

      await openMenu(page);
      const entry = option(page, locale);
      // The endonym, diacritics included — never a tag, never an English name.
      await expect(entry).toContainText(localeLabel(locale));
      await expect(entry.getByTestId('language-beta')).toHaveCount(beta ? 1 : 0);

      if (!beta) {
        // The menu is read by people who may not read English; the badge
        // must also pass contrast where it does appear, so scan the open menu.
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
          .analyze();
        const blocking = results.violations.filter(
          (violation) => violation.impact === 'critical' || violation.impact === 'serious',
        );
        expect(
          blocking.map((violation) => `${violation.id}: ${violation.help}`),
          'serious or critical accessibility violations with the language menu open',
        ).toEqual([]);
        return;
      }

      // The badge reads in the UI's language (English here), and the link is
      // there because a Beta language is on the menu.
      await expect(entry.getByTestId('language-beta')).toHaveText(translate('en', 'lang.beta'));
      // toContainText: the link also carries its icon's ligature name.
      await expect(page.getByTestId('language-help')).toContainText(
        translate('en', 'lang.beta.help'),
      );

      // Choosing it renders the page in it — complete, never English (the
      // completeness gate) — and the badge and link follow into that language.
      await entry.click();
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await openMenu(page);
      await expect(option(page, locale).getByTestId('language-beta')).toHaveText(
        translate(locale, 'lang.beta'),
      );
      const help = page.getByTestId('language-help');
      await expect(help).toContainText(translate(locale, 'lang.beta.help'));

      // And the link goes somewhere that names this language as Beta.
      await help.click();
      await expect(page.getByTestId('beta-languages')).toContainText(localeLabel(locale));
    });
  }
});
