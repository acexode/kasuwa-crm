import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EN_CATALOGUE, REGISTERED_LOCALES, bundleMessages, type MessageId } from '@kasuwa/i18n';
import { ContactSource, RecordsErrorCode } from '../../lib/records-api';
import { LEADS_MESSAGE_IDS } from './message-ids';
import { LEAD_SORTS, LEAD_STATUSES, leadSortLabel, sourceLabel, statusLabel } from './leads-model';

/**
 * A screen that asks for a message id it did not bundle throws — at REQUEST
 * time, on the server, in whichever language the person chose. `tsc` cannot
 * see it (the id is a valid `MessageId`), so this reads the SOURCES and checks
 * every literal catalogue id they name is in the bundle the page sends, and
 * then the ids a source COMPUTES (a status, a source, a sort, an error code).
 */

const here = dirname(fileURLToPath(import.meta.url));

/** Every quoted string in a source that is a message id in the English catalogue. */
function catalogueIds(file: string): string[] {
  const source = readFileSync(resolve(here, file), 'utf8');
  const ids = [...source.matchAll(/['"`]([a-z][\w-]*(?:\.[\w-]+)+)['"`]/g)].map((match) => match[1] ?? '');
  return [...new Set(ids.filter((id) => id in EN_CATALOGUE))];
}

const SOURCES = [
  'leads-screen.tsx',
  'leads-table.tsx',
  'leads-kanban.tsx',
  'convert-sheet.tsx',
  'lead-parts.tsx',
  'leads-model.ts',
  '../records/list-parts.tsx',
  '../crm/crm-shell.tsx',
];

describe('the leads screen bundles every id it renders', () => {
  const available = new Set<string>(LEADS_MESSAGE_IDS);

  for (const file of SOURCES) {
    it(`${file} names nothing outside LEADS_MESSAGE_IDS`, () => {
      const named = catalogueIds(file);
      expect(named.length, `${file} names no message id: the scan is reading nothing`).toBeGreaterThan(0);
      expect(named.filter((id) => !available.has(id))).toEqual([]);
    });
  }

  it('bundles the computed ids a scan cannot see: every status, source, sort and error code', () => {
    const computed: string[] = [
      ...LEAD_STATUSES.map(statusLabel),
      statusLabel('customer'),
      ...ContactSource.options.map(sourceLabel),
      ...LEAD_SORTS.map(leadSortLabel),
      ...RecordsErrorCode.options.map((code) => `records.error.${code}`),
      'records.error.network',
    ];
    expect(computed.filter((id) => !available.has(id))).toEqual([]);
  });

  it('names a label for each lead stage, the Company column and already_linked', () => {
    for (const stage of LEAD_STATUSES) {
      expect(available.has(`records.status.${stage}`), stage).toBe(true);
    }
    expect([...available].some((id) => id.endsWith('.col.companyName'))).toBe(true);
    expect([...available].some((id) => id.endsWith('.already_linked'))).toBe(true);
  });

  it('resolves in every registered locale', () => {
    // `bundleMessages` throws on a missing id: what the server does on every request.
    for (const locale of REGISTERED_LOCALES) {
      expect(() => bundleMessages(locale, LEADS_MESSAGE_IDS as readonly MessageId[]), locale).not.toThrow();
    }
  });
});
