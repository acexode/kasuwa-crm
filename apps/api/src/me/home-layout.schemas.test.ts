import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HOME_LAYOUT_MAX_ITEMS,
  HOME_ROLES,
  HOME_SPANS,
  HOME_WIDGET_TYPES,
  HomeLayoutBody,
} from './home-layout.schemas';

const webModel = readFileSync(
  join(__dirname, '..', '..', '..', 'web', 'components', 'home', 'home-model.ts'),
  'utf8',
);

/** The quoted words (or numbers) of `export const NAME = [ ... ] as const;`. */
function listOf(name: string): string[] {
  const match = new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const;`, 'u').exec(webModel);
  if (match === null) throw new Error(`home-model.ts has no list ${name}`);
  return [...(match[1] ?? '').matchAll(/'([^']+)'|(\d+)/gu)].map((m) => m[1] ?? m[2] ?? '');
}

describe('the Home layout vocabulary is the web’s (T-0159)', () => {
  it('has the same widget types, in the same order', () => {
    expect([...HOME_WIDGET_TYPES]).toEqual(listOf('WIDGET_TYPES'));
  });

  it('has the same grid widths', () => {
    expect(HOME_SPANS.map(String)).toEqual(listOf('SPANS'));
  });

  it('has the same roles', () => {
    const union = /export type HomeRole = ([^;]+);/u.exec(webModel)?.[1] ?? '';
    const roles = [...union.matchAll(/'([^']+)'/gu)].map((m) => m[1]);
    expect([...HOME_ROLES]).toEqual(roles);
  });
});

describe('HomeLayoutBody', () => {
  const ok = { role: 'rep', items: [{ type: 'nba', span: 12 }] };

  it('accepts a layout, an empty one, and exactly the maximum', () => {
    expect(HomeLayoutBody.safeParse(ok).success).toBe(true);
    expect(HomeLayoutBody.safeParse({ role: 'exec', items: [] }).success).toBe(true);
    const full = Array.from({ length: HOME_LAYOUT_MAX_ITEMS }, () => ({ type: 'nba', span: 4 }));
    expect(HomeLayoutBody.safeParse({ role: 'rep', items: full }).success).toBe(true);
  });

  it('refuses what the contract does not name', () => {
    const tooMany = Array.from({ length: HOME_LAYOUT_MAX_ITEMS + 1 }, () => ({ type: 'nba', span: 4 }));
    const refused: unknown[] = [
      { ...ok, userId: '00000000-0000-4000-8000-000000000001' },
      { ...ok, tenantId: '00000000-0000-4000-8000-000000000002' },
      { role: 'ceo', items: [] },
      { items: [] },
      { role: 'rep', items: 'nba' },
      { role: 'rep', items: [{ type: 'no-such-widget', span: 4 }] },
      { role: 'rep', items: [{ type: 'nba', span: 5 }] },
      { role: 'rep', items: [{ type: 'nba', span: 4, colour: 'red' }] },
      { role: 'rep', items: tooMany },
      null,
      'rep',
    ];
    for (const body of refused) {
      expect(HomeLayoutBody.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});
