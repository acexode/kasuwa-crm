import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EN_CATALOGUE, REGISTERED_LOCALES, bundleMessages } from '@kasuwa/i18n';
import { CONDITION_OPERATORS, FORM_FIELD_TYPES, NODE_TYPES } from '../../lib/script-graph';
import { NETWORK, SCRIPTING_ERROR_CODES } from '../../lib/scripting-http';
import { FIELD_ERRORS } from '../script-run/run-model';
import { SCRIPT_RUN_MESSAGE_IDS, START_SCRIPT_MESSAGE_IDS } from '../script-run/message-ids';
import { AGENT_VARIABLE, BRANCH_FIELDS, CONTACT_VARIABLES, PUBLISH_REASONS } from './builder-model';
import { SCRIPT_EDITOR_MESSAGE_IDS, SCRIPT_LIST_MESSAGE_IDS } from './message-ids';

/**
 * A screen that asks for a message id it did not bundle throws at REQUEST
 * time, in whichever language the person chose, and `tsc` cannot see it. So
 * every source each P10 screen renders is read, and every literal catalogue id
 * it names, plus every id it builds from a vocabulary, must be in its bundle.
 */

const here = dirname(fileURLToPath(import.meta.url));

function catalogueIds(file: string): string[] {
  const source = readFileSync(resolve(here, file), 'utf8');
  const ids = [...source.matchAll(/['"`]([a-z][\w-]*(?:\.[\w-]+)+)['"`]/g)].map((match) => match[1] ?? '');
  return [...new Set(ids.filter((id) => id in EN_CATALOGUE))];
}

const SHELL = ['../crm/crm-shell.tsx', '../record/record-states.tsx'];

const SCREENS: readonly (readonly [name: string, ids: readonly string[], files: readonly string[], built: readonly string[]])[] = [
  ['the builder list', SCRIPT_LIST_MESSAGE_IDS, ['script-list-screen.tsx', ...SHELL], [...SCRIPTING_ERROR_CODES, NETWORK].map((code) => `scripting.error.${code}`)],
  [
    'the builder editor',
    SCRIPT_EDITOR_MESSAGE_IDS,
    ['script-editor-screen.tsx', 'node-inspector.tsx', 'script-canvas.tsx', ...SHELL],
    [
      ...NODE_TYPES.map((type) => `scripting.nodeType.${type}`),
      ...CONDITION_OPERATORS.map((operator) => `scripting.builder.operator.${operator}`),
      ...FORM_FIELD_TYPES.map((type) => `scripting.builder.fieldType.${type}`),
      ...PUBLISH_REASONS.map((reason) => `scripting.builder.reason.${reason}`),
      ...BRANCH_FIELDS.map((field) => `scripting.field.${field}`),
      ...[...CONTACT_VARIABLES, AGENT_VARIABLE].map((variable) => `scripting.builder.variable.${variable}`),
      ...['added', 'changed', 'removed'].map((kind) => `scripting.builder.diff.${kind}`),
      ...[...SCRIPTING_ERROR_CODES, NETWORK].map((code) => `scripting.error.${code}`),
    ],
  ],
  [
    'the agent run',
    SCRIPT_RUN_MESSAGE_IDS,
    ['../script-run/script-run-screen.tsx', '../script-run/disposition-sheet.tsx', ...SHELL],
    [
      ...NODE_TYPES.map((type) => `scripting.nodeType.${type}`),
      ...FIELD_ERRORS.map((code) => `scripting.run.fieldError.${code}`),
      ...['field_withheld', 'sensitive_field'].map((reason) => `scripting.run.stopped.${reason}`),
      ...['completed', 'interrupted', 'superseded'].map((outcome) => `scripting.run.outcome.${outcome}`),
      ...[...SCRIPTING_ERROR_CODES, NETWORK].map((code) => `scripting.error.${code}`),
    ],
  ],
  ['the start control', START_SCRIPT_MESSAGE_IDS, ['../script-run/start-script.tsx', '../script-run/script-menu.tsx'], [...SCRIPTING_ERROR_CODES, NETWORK].map((code) => `scripting.error.${code}`)],
];

describe('every P10 screen bundles every id it renders (T-0115, T-0116)', () => {
  for (const [name, ids, files, built] of SCREENS) {
    const available = new Set<string>(ids);
    for (const file of files) {
      it(`${name}: ${file} names nothing outside its bundle`, () => {
        const named = catalogueIds(file);
        expect(named.length, `${file} names no message id: the scan is reading nothing`).toBeGreaterThan(0);
        expect(named.filter((id) => !available.has(id))).toEqual([]);
      });
    }
    it(`${name}: every id it builds from a vocabulary is bundled and in the catalogue`, () => {
      expect(built.filter((id) => !available.has(id) || !(id in EN_CATALOGUE))).toEqual([]);
    });
    it(`${name}: resolves in every registered language`, () => {
      for (const locale of REGISTERED_LOCALES) {
        const bundle = bundleMessages(locale, ids as Parameters<typeof bundleMessages>[1]);
        expect(Object.values(bundle).filter((text) => text.trim() === '')).toEqual([]);
      }
    });
  }

  it('keeps the builder’s not-found free of words that say why (R2)', () => {
    // The page's bundle travels with the not-found state: nothing in it may tell a non-writer why.
    const english = bundleMessages('en', SCRIPT_EDITOR_MESSAGE_IDS as Parameters<typeof bundleMessages>[1]);
    const said = [...Object.keys(english), ...Object.values(english)].join(' ');
    expect(said).not.toMatch(/permission|not allowed|admin|request access/i);
  });
});
