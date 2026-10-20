import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EN_CATALOGUE, REGISTERED_LOCALES, bundleMessages, type MessageId } from '@kasuwa/i18n';
import { DEAL_TIMELINE_FIELDS } from '../../lib/deal-detail-api';
import { REQUIREMENT_FIELDS } from '../../lib/pipelines-api';
import { PIPELINE_ERROR_IDS } from '../pipeline/message-ids';
import { fieldLabel } from '../pipeline/pipeline-model';
import { DEAL_MESSAGE_IDS } from './message-ids';
import { dealFieldLabel } from './deal-model';

/**
 * A screen that asks for a message id it did not bundle throws — at REQUEST
 * time, in whichever language the person chose. `tsc` cannot see it, so this
 * reads the SOURCES the deal draws and checks every literal catalogue id they
 * name is in the bundle the page sends, then the ids a source COMPUTES.
 */

const here = dirname(fileURLToPath(import.meta.url));

function catalogueIds(file: string): string[] {
  const source = readFileSync(resolve(here, file), 'utf8');
  const ids = [...source.matchAll(/['"`]([a-z][\w-]*(?:\.[\w-]+)+)['"`]/g)].map(
    (match) => match[1] ?? '',
  );
  return [...new Set(ids.filter((id) => id in EN_CATALOGUE))];
}

const DEAL_SOURCES = [
  'deal-screen.tsx',
  'deal-sheet.tsx',
  '../pipeline/move-sheet.tsx',
  '../pipeline/requirement-prompt.tsx',
  '../pipeline/move-refusal.ts',
  '../pipeline/pipeline-parts.tsx',
  '../pipeline/pipeline-model.ts',
  '../record/record-states.tsx',
  '../record/record-timeline.tsx',
  '../record/activity-form.tsx',
  '../record/record-core.ts',
  '../crm/crm-shell.tsx',
];

/** Ids a shared source names that the deal never draws. */
const NOT_DRAWN_HERE: ReadonlySet<string> = new Set([
  // pipeline-parts' offline banner is the board's; the deal draws the record one.
  'pipeline.offline.synced',
  // pipeline-model's sort labels belong to the list view.
  'pipeline.sort.updated',
  'pipeline.sort.created',
  'pipeline.sort.name',
  'pipeline.sort.waiting',
  // T-0135: pipeline-parts' InStageChip and CloseShort draw these on the board
  // and list cards; the deal imports neither.
  'pipeline.card.rotting',
  'pipeline.card.stale',
  'pipeline.card.inStage',
  'pipeline.card.overdue',
]);

describe('the deal detail bundles every id it renders', () => {
  const bundle = new Set<string>(DEAL_MESSAGE_IDS);

  for (const file of DEAL_SOURCES) {
    it(`${file} names nothing outside DEAL_MESSAGE_IDS`, () => {
      const named = catalogueIds(file);
      expect(
        named.length,
        `${file} names no message id: the scan is reading nothing`,
      ).toBeGreaterThan(0);
      expect(named.filter((id) => !bundle.has(id) && !NOT_DRAWN_HERE.has(id))).toEqual([]);
    });
  }

  it('bundles the computed ids a scan cannot see: every timeline field, requirement field and error', () => {
    const computed: string[] = [
      ...DEAL_TIMELINE_FIELDS.map((field) => dealFieldLabel(field)),
      ...REQUIREMENT_FIELDS.map(fieldLabel),
      ...PIPELINE_ERROR_IDS,
      ...['note', 'task', 'call', 'meeting'].map((type) => `record.activity.type.${type}`),
      ...['note', 'task', 'call'].map((type) => `record.log.title.${type}`),
    ];
    expect(computed.filter((id) => !bundle.has(id))).toEqual([]);
  });

  it('labels a former checker apart from a former owner (D-L127)', () => {
    expect(EN_CATALOGUE['deal.checker.former']).toBeDefined();
    expect(EN_CATALOGUE['deal.checker.former']).not.toBe(EN_CATALOGUE['records.owner.former']);
  });

  it('resolves in every registered locale, so no language throws at request time', () => {
    for (const locale of REGISTERED_LOCALES) {
      const messages = bundleMessages(locale, DEAL_MESSAGE_IDS);
      expect(
        DEAL_MESSAGE_IDS.filter((id: MessageId) => typeof messages[id] !== 'string'),
        locale,
      ).toEqual([]);
    }
  });
});
