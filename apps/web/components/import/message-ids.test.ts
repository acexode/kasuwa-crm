import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EN_CATALOGUE, REGISTERED_LOCALES, bundleMessages, type MessageId } from '@kasuwa/i18n';
import { IMPORT_MESSAGE_IDS } from './message-ids';
import { refusalId, rowErrorId } from './import-text';
import { ROW_ERROR_CODES } from '../../lib/import-model';

/**
 * The import wizard draws every string from the bundle the server page sends
 * (`IMPORT_MESSAGE_IDS`): an id it names that is not there is not an English
 * fallback, it is a thrown error in the browser, in whichever language the
 * person chose.
 */

const here = dirname(fileURLToPath(import.meta.url));

function namedIds(file: string): string[] {
  const source = readFileSync(resolve(here, file), 'utf8');
  const ids = [...source.matchAll(/['"`]([a-z][\w-]*(?:\.[\w-]+)+)['"`]/g)].map((match) => match[1] ?? '');
  return [...new Set(ids.filter((id) => id in EN_CATALOGUE))];
}

describe('the import wizard bundles every id it renders', () => {
  const bundled = new Set<string>(IMPORT_MESSAGE_IDS);
  const files = readdirSync(here).filter((file) => /\.tsx$/.test(file));

  for (const file of files) {
    it(`${file} names nothing outside IMPORT_MESSAGE_IDS`, () => {
      expect(namedIds(file).filter((id) => !bundled.has(id))).toEqual([]);
    });
  }

  it('bundles a sentence for every row error and every refusal the API can name', () => {
    expect(ROW_ERROR_CODES.map(rowErrorId).filter((id) => !bundled.has(id))).toEqual([]);
    expect(rowErrorId('a_code_added_later')).toBe('import.error.other');
    for (const code of ['file_too_large', 'unsupported_type', 'mapping_incomplete', 'duplicate_mapping', 'unknown_reference', 'field_not_editable']) {
      expect(bundled.has(`import.error.${code}`), code).toBe(true);
    }
  });

  it('resolves in every registered locale', () => {
    for (const locale of REGISTERED_LOCALES) {
      const bundle = bundleMessages(locale, IMPORT_MESSAGE_IDS);
      expect(IMPORT_MESSAGE_IDS.filter((id: MessageId) => typeof bundle[id] !== 'string'), locale).toEqual([]);
    }
  });
});

describe('the sentence for a refusal', () => {
  it('prefers the reason a refusal names, then its own code, then the network', () => {
    expect(refusalId({ code: 'not_permitted', details: [{ path: 'status', code: 'field_not_editable' }] })).toBe('import.error.field_not_editable');
    expect(refusalId({ code: 'not_permitted' })).toBe('records.error.not_permitted');
    expect(refusalId({ code: 'validation_failed', details: [{ path: 'columns.3.field', code: 'duplicate_mapping' }] })).toBe('import.error.duplicate_mapping');
    expect(refusalId({ code: 'validation_failed', details: [{ path: 'columns.7.index', code: 'unknown_column' }] })).toBe('records.error.validation_failed');
    expect(refusalId({ code: 'import_status_conflict' })).toBe('records.error.import_status_conflict');
    expect(refusalId({ code: 'upload_mismatch' })).toBe('records.error.upload_mismatch');
    expect(refusalId({ code: 'network' })).toBe('records.error.network');
  });
});
