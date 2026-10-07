import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EN_CATALOGUE, REGISTERED_LOCALES, bundleMessages, type MessageId } from '@kasuwa/i18n';
import { AccountTier } from '../../lib/accounts-api';
import { CONTACTS_MESSAGE_IDS } from '../contacts/message-ids';
import { ACCOUNTS_MESSAGE_IDS } from './message-ids';
import { ACCOUNT_SORTS, sortLabel, tierLabel } from './accounts-model';

/**
 * A screen that asks for a message id it did not bundle throws — at REQUEST
 * time, on the server, in whichever language the person chose. `tsc` cannot
 * see it (the id is a valid `MessageId`), so this reads the SOURCES and checks
 * every literal catalogue id they name is in the bundle the page sends.
 *
 * It reads the shared list pieces too (`components/records/list-parts.tsx`):
 * both P04 screens render them, so both bundles must carry their ids.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** Every quoted string in a source that is a message id in the English catalogue. */
function catalogueIds(file: string): string[] {
  const source = readFileSync(resolve(here, file), 'utf8');
  const ids = [...source.matchAll(/['"`]([a-z][\w-]*(?:\.[\w-]+)+)['"`]/g)].map((match) => match[1] ?? '');
  return [...new Set(ids.filter((id) => id in EN_CATALOGUE))];
}

const SOURCES: Readonly<Record<string, readonly MessageId[]>> = {
  'accounts-screen.tsx': ACCOUNTS_MESSAGE_IDS,
  'account-sheet.tsx': ACCOUNTS_MESSAGE_IDS,
  'accounts-model.ts': ACCOUNTS_MESSAGE_IDS,
  '../records/list-parts.tsx': ACCOUNTS_MESSAGE_IDS,
  '../crm/crm-shell.tsx': ACCOUNTS_MESSAGE_IDS,
};

describe('the accounts screen bundles every id it renders', () => {
  for (const [file, bundle] of Object.entries(SOURCES)) {
    it(`${file} names nothing outside ACCOUNTS_MESSAGE_IDS`, () => {
      const available = new Set<string>(bundle);
      const named = catalogueIds(file);
      expect(named.length, `${file} names no message id: the scan is reading nothing`).toBeGreaterThan(0);
      expect(named.filter((id) => !available.has(id))).toEqual([]);
    });
  }

  it('the shared list pieces are in the contacts bundle too', () => {
    const available = new Set<string>(CONTACTS_MESSAGE_IDS);
    expect(catalogueIds('../records/list-parts.tsx').filter((id) => !available.has(id))).toEqual([]);
  });

  it('bundles a label for every tier and every sort, the computed ids a scan cannot see', () => {
    const available = new Set<string>(ACCOUNTS_MESSAGE_IDS);
    for (const tier of AccountTier.options) {
      expect(tierLabel(tier).endsWith(`.tier.${tier}`)).toBe(true);
      expect(available.has(tierLabel(tier)), tier).toBe(true);
    }
    for (const sort of ACCOUNT_SORTS) {
      expect(available.has(sortLabel(sort)), sort).toBe(true);
    }
  });

  it('resolves in every registered locale', () => {
    // `bundleMessages` throws on a missing id: what the server does on every request.
    for (const locale of REGISTERED_LOCALES) {
      expect(() => bundleMessages(locale, ACCOUNTS_MESSAGE_IDS), locale).not.toThrow();
    }
  });
});
