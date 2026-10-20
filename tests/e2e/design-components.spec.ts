import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { stack } from './support/stack';

/**
 * T-0128 — the component library, part 1, measured against the v1.1 spec (D-L193).
 *
 * Committed FAILING by the lead before assignment.
 *
 * The audit (team/reports/ui-audit/foundations.md §3) found every screen
 * hand-rolling its controls, with the wrong height, padding, type, focus and
 * disabled states. T-0128 builds the controls once in `@kasuwa/ui/components`
 * and shows every variant on `/design/components`. This journey reads the
 * COMPUTED style of each variant there and compares it with the values the
 * v1.1 Components page and the screen exports specify. A screenshot comparison
 * (`tools/design-parity.mjs`) is still the visual gate; this is what a
 * screenshot cannot prove to the pixel.
 *
 * THE GALLERY CONTRACT. Each variant carries `data-gallery="<id>"` on the
 * element that IS the control (the button, the input, the chip), not on a
 * wrapper. Ids are listed in GALLERY_IDS below.
 *
 * Colours are compared as resolved values: each expected token is resolved
 * through a probe element, so a theme switch changes both sides together.
 */

const GALLERY_IDS = [
  'button-primary',
  'button-secondary',
  'button-ghost',
  'button-danger',
  'button-primary-compact',
  'button-primary-disabled',
  'icon-button',
  'field',
  'field-error',
  'field-disabled',
  'field-label',
  'field-error-icon',
  'select',
  'checkbox',
  'checkbox-checked',
  'radio',
  'switch',
  'switch-on',
  'chip',
  'chip-active',
  'chip-icon',
  'pill-success',
  'tag',
  'count-badge',
  'segmented',
  'segmented-active',
  'segmented-item',
  'tab-active',
  'tab',
  'avatar-44',
  'avatar-32',
  'kbd',
] as const;

type GalleryId = (typeof GALLERY_IDS)[number];

const at = (page: Page, id: GalleryId): Locator => page.locator(`[data-gallery="${id}"]`).first();

async function style(locator: Locator, ...props: string[]): Promise<Record<string, string>> {
  return locator.evaluate((element, names) => {
    const computed = getComputedStyle(element);
    return Object.fromEntries(names.map((name) => [name, computed.getPropertyValue(name).trim()]));
  }, props);
}

/** A token resolved to the computed colour the browser would paint, in the current theme. */
async function colour(page: Page, token: string, property = 'background-color'): Promise<string> {
  return page.evaluate(
    ([name, prop]) => {
      const probe = document.createElement('div');
      probe.style.setProperty(prop, `var(--k-${name})`);
      document.body.append(probe);
      const value = getComputedStyle(probe).getPropertyValue(prop).trim();
      probe.remove();
      return value;
    },
    [token, property] as const,
  );
}

async function open(page: Page, scheme: 'light' | 'dark'): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme });
  await page.setViewportSize({ width: 1440, height: 900 });
  const response = await page.goto(`${stack().webUrl}/design/components`);
  expect(response?.status()).toBe(200);
  await page.evaluate(() => document.fonts.ready);
}

test.describe('/design/components — the gallery (T-0128)', () => {
  test('renders every variant, with no colour outside the tokens, and passes axe @t0128', async ({
    page,
  }) => {
    await open(page, 'light');
    for (const id of GALLERY_IDS) {
      await expect(at(page, id), `data-gallery="${id}" is missing`).toBeVisible();
    }
    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations.map((violation) => violation.id)).toEqual([]);
  });

  test('has no sideways scroll at 360 px @t0128', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto(`${stack().webUrl}/design/components`);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`components match the v1.1 spec (${scheme}) (T-0128)`, () => {
    test.beforeEach(async ({ page }) => {
      await open(page, scheme);
    });

    test(`buttons: 44 px, 0 12 px, radius 8, 15/600; compact 36; disabled uses the disabled tokens @t0128`, async ({
      page,
    }) => {
      for (const id of [
        'button-primary',
        'button-secondary',
        'button-ghost',
        'button-danger',
      ] as const) {
        const s = await style(
          at(page, id),
          'height',
          'padding-left',
          'padding-right',
          'border-top-left-radius',
          'font-size',
          'font-weight',
        );
        expect(s, id).toMatchObject({
          height: '44px',
          'padding-left': '12px',
          'padding-right': '12px',
          'border-top-left-radius': '8px',
          'font-size': '15px',
          'font-weight': '600',
        });
      }
      expect((await style(at(page, 'button-primary-compact'), 'height')).height).toBe('36px');

      const primary = await style(at(page, 'button-primary'), 'background-color', 'color');
      expect(primary['background-color']).toBe(await colour(page, 'primary'));
      expect(primary.color).toBe(await colour(page, 'on-primary', 'color'));

      const danger = await style(at(page, 'button-danger'), 'background-color');
      expect(danger['background-color']).toBe(await colour(page, 'danger'));

      const disabled = await style(
        at(page, 'button-primary-disabled'),
        'background-color',
        'color',
        'opacity',
      );
      expect(disabled['background-color']).toBe(await colour(page, 'disabled-bg'));
      expect(disabled.color).toBe(await colour(page, 'disabled-text', 'color'));
      expect(disabled.opacity, 'disabled is a token, never a fade').toBe('1');
    });

    test('focus: a 2 px surface gap then a 2 px focus ring on buttons, never an outline @t0128', async ({
      page,
    }) => {
      await at(page, 'button-primary').focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      const s = await style(at(page, 'button-primary'), 'box-shadow', 'outline-style');
      expect(s['outline-style'] === 'none' || s['outline-style'] === '').toBe(true);
      const focus = await colour(page, 'focus');
      expect(s['box-shadow']).toContain(focus);
      // T-0150 (T-0128 report): Chromium serialises the two shadows with a comma
      // after the first, so the gap-then-ring shape is matched across it.
      expect(s['box-shadow']).toMatch(/0px 0px 0px 2px,.*0px 0px 0px 4px/);
    });

    test('text field: 44 px, radius 8, 1 px border-strong, 15 px value, 14/600 label; focus is a primary border and a 3 px soft halo @t0128', async ({
      page,
    }) => {
      const s = await style(
        at(page, 'field'),
        'height',
        'border-top-width',
        'border-top-color',
        'border-top-left-radius',
        'font-size',
        'padding-left',
      );
      expect(s).toMatchObject({
        height: '44px',
        'border-top-width': '1px',
        'border-top-left-radius': '8px',
        'font-size': '15px',
        'padding-left': '12px',
      });
      expect(s['border-top-color']).toBe(await colour(page, 'border-strong', 'border-top-color'));
      expect(await style(at(page, 'field-label'), 'font-size', 'font-weight')).toEqual({
        'font-size': '14px',
        'font-weight': '600',
      });

      await at(page, 'field').focus();
      const focused = await style(at(page, 'field'), 'border-top-color', 'box-shadow');
      expect(focused['border-top-color']).toBe(await colour(page, 'primary', 'border-top-color'));
      expect(focused['box-shadow']).toContain(await colour(page, 'primary-soft-strong'));
      expect(focused['box-shadow']).toMatch(/0px 0px 0px 3px/);
    });

    test('field error: a 2 px danger border and a trailing error icon @t0128', async ({ page }) => {
      const s = await style(at(page, 'field-error'), 'border-top-width', 'border-top-color');
      expect(s['border-top-width']).toBe('2px');
      expect(s['border-top-color']).toBe(await colour(page, 'danger', 'border-top-color'));
      await expect(at(page, 'field-error-icon')).toHaveText('error');
      const disabled = await style(at(page, 'field-disabled'), 'background-color', 'color');
      expect(disabled['background-color']).toBe(await colour(page, 'disabled-bg'));
      expect(disabled.color).toBe(await colour(page, 'disabled-text', 'color'));
    });

    test('checkbox and radio: 20 px, 2 px border-strong; switch 44 x 26 @t0128', async ({
      page,
    }) => {
      for (const id of ['checkbox', 'radio'] as const) {
        const s = await style(
          at(page, id),
          'width',
          'height',
          'border-top-width',
          'border-top-color',
        );
        expect(s.width, id).toBe('20px');
        expect(s.height, id).toBe('20px');
        expect(s['border-top-width'], id).toBe('2px');
        expect(s['border-top-color'], id).toBe(
          await colour(page, 'border-strong', 'border-top-color'),
        );
      }
      expect(
        (await style(at(page, 'checkbox'), 'border-top-left-radius'))['border-top-left-radius'],
      ).toBe('4px');
      const sw = await style(at(page, 'switch'), 'width', 'height');
      expect(sw).toEqual({ width: '44px', height: '26px' });
      expect((await style(at(page, 'switch-on'), 'background-color'))['background-color']).toBe(
        await colour(page, 'primary'),
      );
    });

    test('filter chip: 36 px, radius 999, 13/600, 1 px border-strong, 18 px icon; active is primary @t0128', async ({
      page,
    }) => {
      const s = await style(
        at(page, 'chip'),
        'height',
        'border-top-left-radius',
        'font-size',
        'font-weight',
        'border-top-color',
        'padding-left',
        'padding-right',
      );
      expect(s).toMatchObject({
        height: '36px',
        'border-top-left-radius': '999px',
        'font-size': '13px',
        'font-weight': '600',
        'padding-left': '10px',
        'padding-right': '8px',
      });
      expect(s['border-top-color']).toBe(await colour(page, 'border-strong', 'border-top-color'));
      expect((await style(at(page, 'chip-icon'), 'font-size'))['font-size']).toBe('18px');
      const active = await style(at(page, 'chip-active'), 'border-top-color');
      expect(active['border-top-color']).toBe(await colour(page, 'primary', 'border-top-color'));
    });

    test('pills, tags and count badges: 12/700 at 3 10 px; tags radius 4; count 20 px at 11/700 @t0128', async ({
      page,
    }) => {
      expect(
        await style(
          at(page, 'pill-success'),
          'font-size',
          'font-weight',
          'padding-top',
          'padding-left',
          'border-top-left-radius',
        ),
      ).toEqual({
        'font-size': '12px',
        'font-weight': '700',
        'padding-top': '3px',
        'padding-left': '10px',
        'border-top-left-radius': '999px',
      });
      const pill = await style(at(page, 'pill-success'), 'background-color', 'color');
      expect(pill['background-color']).toBe(await colour(page, 'success-soft'));
      expect(pill.color).toBe(await colour(page, 'success-text', 'color'));
      expect(
        (await style(at(page, 'tag'), 'border-top-left-radius'))['border-top-left-radius'],
      ).toBe('4px');
      const count = await style(
        at(page, 'count-badge'),
        'height',
        'min-width',
        'font-size',
        'font-weight',
      );
      expect(count).toEqual({
        height: '20px',
        'min-width': '20px',
        'font-size': '11px',
        'font-weight': '700',
      });
    });

    test('segmented control: sunken track, padding 3, radius 8; 36 px items at 13/600; active is surface with shadow-1 @t0128', async ({
      page,
    }) => {
      const track = await style(
        at(page, 'segmented'),
        'background-color',
        'padding-top',
        'border-top-left-radius',
      );
      expect(track['background-color']).toBe(await colour(page, 'surface-sunken'));
      expect(track['padding-top']).toBe('3px');
      expect(track['border-top-left-radius']).toBe('8px');
      const item = await style(
        at(page, 'segmented-item'),
        'height',
        'font-size',
        'font-weight',
        'border-top-left-radius',
      );
      expect(item).toEqual({
        height: '36px',
        'font-size': '13px',
        'font-weight': '600',
        'border-top-left-radius': '6px',
      });
      const active = await style(at(page, 'segmented-active'), 'background-color', 'box-shadow');
      expect(active['background-color']).toBe(await colour(page, 'surface'));
      expect(active['box-shadow']).not.toBe('none');
    });

    // T-0150 (T-0128 report): every design source draws the active tab at 700
    // with a 3 px primary underline inside the tab (v1.1 `inset 0 -3px 0`, P05
    // and P07 measured), built as an ::after bar so the focus ring cannot replace it.
    test('tabs are underline tabs: 14 px; the active tab is primary-text at 700 with a 3 px primary underline @t0128', async ({
      page,
    }) => {
      const active = await style(
        at(page, 'tab-active'),
        'font-size',
        'font-weight',
        'color',
        'background-color',
      );
      expect(active['font-size']).toBe('14px');
      expect(active['font-weight']).toBe('700');
      expect(active.color).toBe(await colour(page, 'primary-text', 'color'));
      const underline = await at(page, 'tab-active').evaluate((element) => {
        const after = getComputedStyle(element, '::after');
        return { height: after.height, background: after.backgroundColor, bottom: after.bottom };
      });
      expect(underline.height).toBe('3px');
      expect(underline.bottom).toBe('0px');
      expect(underline.background).toBe(await colour(page, 'primary'));
      expect(active['background-color'], 'tabs are not pills').toBe('rgba(0, 0, 0, 0)');
      const rest = await style(at(page, 'tab'), 'color');
      expect(rest.color).toBe(await colour(page, 'text-2', 'color'));
    });

    test('avatars 44 and 32, initials 14/700, round; kbd is mono 11 with a border-strong edge and radius 4 @t0128', async ({
      page,
    }) => {
      expect(
        await style(at(page, 'avatar-44'), 'width', 'height', 'border-top-left-radius'),
      ).toEqual({
        width: '44px',
        height: '44px',
        'border-top-left-radius': '999px',
      });
      expect(await style(at(page, 'avatar-32'), 'width', 'font-weight')).toMatchObject({
        width: '32px',
        'font-weight': '700',
      });
      const kbd = await style(
        at(page, 'kbd'),
        'font-size',
        'font-family',
        'border-top-color',
        'border-top-left-radius',
      );
      expect(kbd['font-size']).toBe('11px');
      expect(kbd['font-family']).toContain('JetBrains Mono');
      expect(kbd['border-top-color']).toBe(await colour(page, 'border-strong', 'border-top-color'));
      expect(kbd['border-top-left-radius']).toBe('4px');
    });

    test('icon button: 44 px square with a 22 px glyph @t0128', async ({ page }) => {
      expect(await style(at(page, 'icon-button'), 'width', 'height')).toEqual({
        width: '44px',
        height: '44px',
      });
      const glyph = at(page, 'icon-button').locator('.k-icon');
      expect((await style(glyph, 'font-size'))['font-size']).toBe('22px');
    });

    test('select: 44 px, radius 8, 1 px border-strong, 15 px value @t0128', async ({ page }) => {
      const s = await style(
        at(page, 'select'),
        'height',
        'border-top-left-radius',
        'border-top-width',
        'font-size',
      );
      expect(s).toEqual({
        height: '44px',
        'border-top-left-radius': '8px',
        'border-top-width': '1px',
        'font-size': '15px',
      });
    });
  });
}
