import { describe, expect, it } from 'vitest';
import { createTranslator, type MessageId } from '@kasuwa/i18n';
import { NAV_GROUPS, NAV_MESSAGE_IDS, filterNav } from './nav-model';

/**
 * `P02/A1` — "find a setting filters every group".
 *
 * The failure this guards is subtle: a filter that only searched the group
 * currently expanded would find one "Retention" and look like it worked.
 */

const t = createTranslator('en');
const label = (id: MessageId) => t.t(id);

function settingIds(groups: readonly { items: readonly { settingId: string }[] }[]): string[] {
  return groups.flatMap((group) => group.items.map((item) => item.settingId));
}

describe('the settings menu', () => {
  it('resolves every one of its labels, in every offered language', () => {
    // A menu entry that throws at request time is a blank sidebar for whoever
    // chose that language. `bundleMessages` throws on a missing id, so this is
    // the same check the server does, run before a browser is involved.
    for (const id of NAV_MESSAGE_IDS) {
      expect(() => t.t(id), id).not.toThrow();
    }
  });

  it('has a unique settingId per item, because badges key on it', () => {
    const ids = settingIds(NAV_GROUPS);
    expect(new Set(ids).size, 'duplicate settingId').toBe(ids.length);
  });

  it('matches items across every group, not only the first one that hits', () => {
    const found = settingIds(filterNav(NAV_GROUPS, 'retention', label));
    expect(found).toContain('b-ret');
    expect(found).toContain('d-ret');
  });

  it('keeps a whole group when the group name itself matches', () => {
    // Somebody typing "channels" wants the channels group, not an empty one.
    const groups = filterNav(NAV_GROUPS, 'channels', label);
    const channels = groups.find((group) => group.id === 'channels');
    expect(channels?.items.length).toBe(5);
  });

  it('ignores case and accents', () => {
    expect(settingIds(filterNav(NAV_GROUPS, 'MFA', label))).toContain('u-mfa');
    expect(settingIds(filterNav(NAV_GROUPS, 'fiscal', label))).toContain('c-fy');
  });

  it('returns nothing rather than everything when nothing matches', () => {
    expect(filterNav(NAV_GROUPS, 'zzzzz', label)).toHaveLength(0);
  });

  it('returns every group for an empty query', () => {
    expect(filterNav(NAV_GROUPS, '   ', label)).toHaveLength(NAV_GROUPS.length);
  });

  it('links only to screens that exist', () => {
    // A menu entry that navigates to a 404 is worse than one that is visibly
    // not ready — the same rule as the language menu.
    const linked = NAV_GROUPS.flatMap((group) =>
      group.items.filter((item) => item.href !== null).map((item) => item.href),
    );
    // Grows one entry per screen that is actually built. `roles`,
    // `field-security` and `audit` joined it with P02 group 4.
    expect(linked).toEqual([
      '/admin/roles',
      '/admin/field-security',
      '/admin/programmes',
      '/admin/audit',
    ]);
  });
});
