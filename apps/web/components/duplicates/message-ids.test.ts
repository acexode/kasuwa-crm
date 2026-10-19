import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EN_CATALOGUE, REGISTERED_LOCALES, bundleMessages, type MessageId } from '@kasuwa/i18n';
import { DUPLICATES_MESSAGE_IDS } from './message-ids';
import { mergeRefusal, undoRefusal } from './duplicates-model';
import { CONTACTS_DUPLICATES_MESSAGE_IDS } from '../contacts/message-ids';

/**
 * The duplicates screen draws every string from the bundle the server page
 * sends (`DUPLICATES_MESSAGE_IDS`): an id it names that is not there is not an
 * English fallback, it is a thrown error in the browser, in whichever language
 * the person chose.
 */

const here = dirname(fileURLToPath(import.meta.url));

function namedIds(file: string): string[] {
  const source = readFileSync(resolve(here, file), 'utf8');
  const ids = [...source.matchAll(/['"`]([a-z][\w-]*(?:\.[\w-]+)+)['"`]/g)].map((match) => match[1] ?? '');
  return [...new Set(ids.filter((id) => id in EN_CATALOGUE))];
}

describe('the duplicates screen bundles every id it renders', () => {
  const bundled = new Set<string>(DUPLICATES_MESSAGE_IDS);
  const files = readdirSync(here).filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && file !== 'message-ids.ts');

  for (const file of files) {
    it(`${file} names nothing outside DUPLICATES_MESSAGE_IDS`, () => {
      expect(namedIds(file).filter((id) => !bundled.has(id))).toEqual([]);
    });
  }

  it('bundles a sentence for every refusal the five operations can answer', () => {
    const codes = ['validation_failed', 'not_authenticated', 'not_permitted', 'not_found', 'stale_write', 'too_many_requests', 'already_merged', 'undo_expired', 'network'] as const;
    for (const code of codes) {
      expect(bundled.has(mergeRefusal({ code }).message), `merge ${code}`).toBe(true);
      expect(bundled.has(undoRefusal({ code }).message), `undo ${code}`).toBe(true);
    }
    for (const id of ['duplicates.error.staleWrite', 'duplicates.error.fieldNotEditable', 'duplicates.error.alreadyMerged']) expect(bundled.has(id), id).toBe(true);
  });

  it('bundles every status, source, channel and consent word a comparison can draw', () => {
    for (const id of ['records.status.new', 'records.source.web_form', 'records.channel.sms', 'records.consent.withdrawn', 'import.mapfield.dnd']) expect(bundled.has(id), id).toBe(true);
  });

  it('resolves in every registered locale, and the Contacts link’s words too', () => {
    for (const locale of REGISTERED_LOCALES) {
      const bundle = bundleMessages(locale, [...DUPLICATES_MESSAGE_IDS, ...CONTACTS_DUPLICATES_MESSAGE_IDS]);
      expect([...DUPLICATES_MESSAGE_IDS, ...CONTACTS_DUPLICATES_MESSAGE_IDS].filter((id: MessageId) => typeof bundle[id] !== 'string'), locale).toEqual([]);
    }
  });
});
