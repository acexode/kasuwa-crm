import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EN_CATALOGUE, REGISTERED_LOCALES, bundleMessages, type MessageId } from '@kasuwa/i18n';
import { DEAL_SORTS, REQUIREMENT_FIELDS } from '../../lib/pipelines-api';
import { PIPELINE_ERROR_IDS, PIPELINE_INDEX_MESSAGE_IDS, PIPELINE_MESSAGE_IDS } from './message-ids';
import { fieldLabel, sortLabel } from './pipeline-model';

/**
 * A screen that asks for a message id it did not bundle throws — at REQUEST
 * time, in whichever language the person chose. `tsc` cannot see it, so this
 * reads the SOURCES and checks every literal catalogue id they name is in the
 * bundle the page sends, then the ids a source COMPUTES.
 */

const here = dirname(fileURLToPath(import.meta.url));

function catalogueIds(file: string): string[] {
  const source = readFileSync(resolve(here, file), 'utf8');
  const ids = [...source.matchAll(/['"`]([a-z][\w-]*(?:\.[\w-]+)+)['"`]/g)].map((match) => match[1] ?? '');
  return [...new Set(ids.filter((id) => id in EN_CATALOGUE))];
}

const BOARD_SOURCES = [
  'pipeline-screen.tsx',
  'pipeline-board.tsx',
  'pipeline-parts.tsx',
  'deal-list.tsx',
  'move-sheet.tsx',
  'requirement-prompt.tsx',
  'move-refusal.ts',
  'deal-create.tsx',
  'pipeline-model.ts',
  '../crm/crm-shell.tsx',
  '../admin/panel.tsx',
];

describe('the pipeline screens bundle every id they render', () => {
  const board = new Set<string>(PIPELINE_MESSAGE_IDS);

  for (const file of BOARD_SOURCES) {
    it(`${file} names nothing outside PIPELINE_MESSAGE_IDS`, () => {
      const named = catalogueIds(file);
      expect(named.length, `${file} names no message id: the scan is reading nothing`).toBeGreaterThan(0);
      // panel.tsx names the admin console's error copy; the board draws only its slow state.
      const drawn = file === '../admin/panel.tsx' ? named.filter((id) => id.startsWith('admin.slow.')) : named;
      expect(drawn.filter((id) => !board.has(id))).toEqual([]);
    });
  }

  it('pipeline-index-screen.tsx names nothing outside PIPELINE_INDEX_MESSAGE_IDS', () => {
    const index = new Set<string>(PIPELINE_INDEX_MESSAGE_IDS);
    expect(catalogueIds('pipeline-index-screen.tsx').filter((id) => !index.has(id))).toEqual([]);
  });

  it('bundles the computed ids a scan cannot see: field labels, sort labels and every error', () => {
    const computed: string[] = [...REQUIREMENT_FIELDS.map(fieldLabel), ...DEAL_SORTS.map(sortLabel), ...PIPELINE_ERROR_IDS];
    expect(computed.filter((id) => !board.has(id))).toEqual([]);
    expect(PIPELINE_ERROR_IDS.filter((id) => !PIPELINE_INDEX_MESSAGE_IDS.includes(id))).toEqual([]);
  });

  it('resolves in every registered locale, so no language throws at request time', () => {
    for (const locale of REGISTERED_LOCALES) {
      const bundle = bundleMessages(locale, PIPELINE_MESSAGE_IDS);
      // T-0145: an ICU message crosses parsed (not a string), so "resolved" means present.
      expect(PIPELINE_MESSAGE_IDS.filter((id: MessageId) => bundle[id] === undefined), locale).toEqual([]);
    }
  });
});
