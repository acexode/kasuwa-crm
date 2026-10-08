import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EN_CATALOGUE, REGISTERED_LOCALES, bundleMessages } from '@kasuwa/i18n';
import { AccountTier } from '../../lib/accounts-api';
import { AccountTimelineField } from '../../lib/account-record-api';
import { ActivityType } from '../../lib/contact-record-api';
import { tierLabel } from '../accounts/accounts-model';
import { ACCOUNT_CREATE_ONLY_MESSAGE_IDS } from '../accounts/message-ids';
import { accountFieldLabel } from './account-record-model';
import { ACCOUNT_RECORD_MESSAGE_IDS } from './message-ids';

/**
 * A screen that asks for a message id it did not bundle throws — at REQUEST
 * time, in whichever language the person chose — and `tsc` cannot see it. So
 * this reads every source the account record renders, the shared record and
 * list pieces and T-0057's sheet included, and checks each literal catalogue
 * id it names is in the bundle the page sends.
 */

const here = dirname(fileURLToPath(import.meta.url));

function catalogueIds(file: string): string[] {
  const source = readFileSync(resolve(here, file), 'utf8');
  const ids = [...source.matchAll(/['"`]([a-z][\w-]*(?:\.[\w-]+)+)['"`]/g)].map((match) => match[1] ?? '');
  return [...new Set(ids.filter((id) => id in EN_CATALOGUE))];
}

const SOURCES = [
  'account-record-screen.tsx',
  'account-record-model.ts',
  '../accounts/account-sheet.tsx',
  '../record/record-timeline.tsx',
  '../record/activity-form.tsx',
  '../record/record-states.tsx',
  '../record/record-core.ts',
  '../crm/crm-shell.tsx',
];

describe('the account record bundles every id it renders', () => {
  const available = new Set<string>(ACCOUNT_RECORD_MESSAGE_IDS);
  // The record opens the sheet to edit, never to create (`mode` is always `edit` there).
  const createOnly = new Set<string>(ACCOUNT_CREATE_ONLY_MESSAGE_IDS);

  for (const file of SOURCES) {
    it(`${file} names nothing outside ACCOUNT_RECORD_MESSAGE_IDS`, () => {
      const named = catalogueIds(file);
      expect(named.length, `${file} names no message id: the scan is reading nothing`).toBeGreaterThan(0);
      expect(named.filter((id) => !available.has(id) && !(file.endsWith('account-sheet.tsx') && createOnly.has(id)))).toEqual([]);
    });
  }

  it('ships nothing of the create flow: the record never creates an account', () => {
    expect(ACCOUNT_RECORD_MESSAGE_IDS.filter((id) => createOnly.has(id))).toEqual([]);
  });

  it('bundles the computed ids a scan cannot see: tiers, activity types and every timeline field', () => {
    for (const tier of AccountTier.options) expect(available.has(tierLabel(tier)), tier).toBe(true);
    for (const type of ActivityType.options) expect(available.has(`record.activity.type.${type}`), type).toBe(true);
    for (const field of AccountTimelineField.options) {
      expect(available.has(accountFieldLabel(field) ?? `<no label for ${field}>`), field).toBe(true);
    }
  });

  it('resolves in every registered locale', () => {
    // `bundleMessages` throws on a missing id: what the server does on every request.
    for (const locale of REGISTERED_LOCALES) {
      expect(() => bundleMessages(locale, ACCOUNT_RECORD_MESSAGE_IDS), locale).not.toThrow();
    }
  });
});
