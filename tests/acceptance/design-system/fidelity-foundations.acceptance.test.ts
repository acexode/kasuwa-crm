import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as ui from '@kasuwa/ui';
import { FONT_WEIGHTS, RADIUS, TYPE_SCALE } from '@kasuwa/ui';
import { describe, expect, it } from 'vitest';

/**
 * ACCEPTANCE — T-0127, design fidelity foundations: tokens and icons (D-L193).
 *
 * Committed FAILING by the lead before assignment.
 *
 * The D-L193 audit (team/reports/ui-audit/foundations.md) found the v1.1 colour
 * tokens exact, but the screen exports use a vocabulary the token set lacks:
 * 13/15/11px text, 28px/800 titles, 6/10/14px radii, 36/40/48px controls and
 * 22/16/15px icons. Builders rounded each one to the nearest token, so every
 * screen came out bigger and looser than its design. This suite pins that
 * vocabulary so the component and screen tasks after it have the steps the
 * design uses, and can no longer round.
 *
 * It is NOT a visual check. A side-by-side screenshot comparison
 * (`tools/design-parity.mjs`) is the visual gate; these are the properties a
 * screenshot cannot prove.
 */

const repoRoot = resolve(__dirname, '..', '..', '..');
const read = (...segments: string[]) => readFileSync(resolve(repoRoot, ...segments), 'utf8');

type Step = {
  size: string;
  lineHeight: string;
  weight: string;
  tracking: string;
  transform?: string;
};
const scale = TYPE_SCALE as unknown as Record<string, Step>;

describe('acceptance: the type steps the screen exports use exist (T-0127)', () => {
  it.each([
    ['title', '28px', '36px', '800'],
    ['title-sm', '26px', '34px', '800'],
    ['card-title', '16px', '24px', '700'],
    ['label', '15px', '22px', '600'],
    ['meta', '13px', '19px', '400'],
    ['overline', '11px', '16px', '700'],
  ])('%s is %s/%s at weight %s', (name, size, lineHeight, weight) => {
    const step = scale[name];
    expect(step, `TYPE_SCALE.${name} is missing`).toBeDefined();
    expect(step?.size).toBe(size);
    expect(step?.lineHeight).toBe(lineHeight);
    expect(step?.weight).toBe(weight);
  });

  it('title tracks -0.01em and overline is caps at 0.06em', () => {
    expect(scale.title?.tracking).toBe('-0.01em');
    expect(scale.overline?.transform).toBe('uppercase');
    expect(scale.overline?.tracking).toBe('0.06em');
  });

  it('has the 44px/800 auth headline step (P01 brand panel)', () => {
    const step = Object.values(scale).find((candidate) => candidate.size === '44px');
    expect(step, 'no 44px step').toBeDefined();
    expect(step?.weight).toBe('800');
  });

  it('keeps every existing v1.1 step unchanged', () => {
    expect(scale.h2).toMatchObject({ size: '32px', lineHeight: '40px', weight: '700' });
    expect(scale['body-sm']).toMatchObject({ size: '14px', lineHeight: '20px' });
    expect(scale.caption).toMatchObject({ size: '12px', lineHeight: '16px', weight: '500' });
  });

  it('declares weights 500 and 700, which the type steps use', () => {
    const weights = Object.values(FONT_WEIGHTS as Record<string, string>);
    expect(weights).toEqual(expect.arrayContaining(['400', '500', '600', '700', '800']));
  });
});

describe('acceptance: radii, control heights, icon sizes and shell dimensions (T-0127)', () => {
  it('has the 6, 10 and 14px radii alongside the v1.1 ones', () => {
    const radii = Object.values(RADIUS as Record<string, string>);
    expect(radii).toEqual(
      expect.arrayContaining(['4px', '6px', '8px', '10px', '12px', '14px', '16px', '999px']),
    );
  });

  it('exports CONTROL_HEIGHT with 36/40/44/48/52', () => {
    const heights = (ui as Record<string, unknown>).CONTROL_HEIGHT as
      Record<string, string> | undefined;
    expect(heights, 'CONTROL_HEIGHT is not exported from @kasuwa/ui').toBeDefined();
    expect(Object.values(heights ?? {})).toEqual(
      expect.arrayContaining(['36px', '40px', '44px', '48px', '52px']),
    );
  });

  it('exports ICON_SIZE with the sizes the designs use, independent of the type scale', () => {
    const sizes = (ui as Record<string, unknown>).ICON_SIZE as Record<string, string> | undefined;
    expect(sizes, 'ICON_SIZE is not exported from @kasuwa/ui').toBeDefined();
    expect(Object.values(sizes ?? {})).toEqual(
      expect.arrayContaining([
        '14px',
        '15px',
        '16px',
        '18px',
        '20px',
        '22px',
        '24px',
        '28px',
        '32px',
      ]),
    );
  });

  it('exports SHELL with the app-shell dimensions', () => {
    const shell = (ui as Record<string, unknown>).SHELL as Record<string, string> | undefined;
    expect(shell, 'SHELL is not exported from @kasuwa/ui').toBeDefined();
    expect(shell).toMatchObject({
      header: '60px',
      rail: '72px',
      adminNav: '272px',
      bottomBar: '64px',
      mobileHeader: '56px',
    });
  });

  it('emits every new step into the generated CSS and the Tailwind preset', () => {
    const css = read('packages/ui/src/tokens.generated.css');
    for (const name of ['title', 'card-title', 'label', 'meta', 'overline']) {
      expect(css, `--k-font-size-${name} missing from tokens.generated.css`).toContain(
        `--k-font-size-${name}:`,
      );
    }
    expect(css).toMatch(/:\s*10px/);
    expect(css).toMatch(/:\s*36px/);
    expect(css).toMatch(/:\s*22px/);
  });
});

describe('acceptance: icons (T-0127)', () => {
  const subset = read('packages/ui/icon-subset.txt')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

  it.each([
    'home',
    'event_note',
    'apartment',
    'menu',
    'content_copy',
    'gavel',
    'mark_email_read',
    'business_center',
    'undo',
    'design_services',
    'dashboard_customize',
    'push_pin',
    'trending_up',
    'bookmark',
    'bookmark_add',
    'check_box',
    'import_export',
    'view_column',
    'upload',
    'swipe_left',
    'view_kanban',
    'add_circle',
    'account_tree',
    'receipt_long',
    'thumb_up',
    'thumb_down',
    'approval',
    'move_up',
    'flag',
    'photo_camera',
    'schedule_send',
    'snooze',
    'event_available',
    'event_busy',
    'alt_route',
    'call_end',
    'groups',
    'publish',
    'published_with_changes',
    'radio_button_checked',
    'sync_alt',
    'hub',
    'schema',
    'rule',
    'workspaces',
    'gpp_maybe',
    'settings',
    'bedtime',
    'join',
    'replay',
    'notifications_active',
    'signal_disconnected',
    'network_check',
    'headset_mic',
  ])('the subset ships %s', (name) => {
    expect(subset).toContain(name);
  });

  it('ships the FILL axis, so an active tab and the bell can use filled glyphs', () => {
    expect(read('packages/ui/scripts/fetch-fonts.mjs')).toMatch(/FILL[^@]*@[^']*0\.\.1/);
  });

  it('sizes icons from ICON_SIZE, not from type steps that also set a font weight', () => {
    const icon = read('apps/web/components/icon.tsx');
    expect(icon).not.toMatch(/text-h[1-6]|text-body-lg/);
  });
});

describe('acceptance: dark-mode scrim (T-0127)', () => {
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (entry === 'node_modules' || entry === '.next') return [];
      return statSync(path).isDirectory() ? files(path) : path.endsWith('.tsx') ? [path] : [];
    });
  }

  it('never dims the page with the inverse colour, which turns cream in dark mode', () => {
    const offenders = files(resolve(repoRoot, 'apps/web')).filter((file) =>
      /bg-inverse[^"'`]*opacity-|opacity-[0-9]+[^"'`]*bg-inverse/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map((file) => file.slice(repoRoot.length + 1))).toEqual([]);
  });
});
