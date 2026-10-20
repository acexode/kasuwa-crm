import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EN_CATALOGUE, REGISTERED_LOCALES, bundleMessages, type MessageId } from '@kasuwa/i18n';
import { CRM_SHELL_MESSAGE_IDS } from '../crm/crm-nav';
import { SEARCH_TYPES } from '../../lib/search-api';
import { SEARCH_AI_MESSAGE_IDS, SEARCH_PANEL_MESSAGE_IDS, SHELL_SEARCH_STRINGS, groupLabel, withSearchMessages } from './message-ids';
import { SEARCH_MESSAGE_IDS } from './screen-message-ids';

/**
 * The palette can open on EVERY CRM screen where `crm_search` is live, so
 * every string it names must be in the bundle those pages send then
 * (`withSearchMessages`): a missing one throws at request time, in whichever
 * language the person chose.
 */

const here = dirname(fileURLToPath(import.meta.url));

function catalogueIds(file: string): string[] {
  const source = readFileSync(resolve(here, file), 'utf8');
  const ids = [...source.matchAll(/['"`]([a-z][\w-]*(?:\.[\w-]+)+)['"`]/g)].map((match) => match[1] ?? '');
  return [...new Set(ids.filter((id) => id in EN_CATALOGUE))];
}

describe('the search panel and palette bundle every id they render', () => {
  const panel = new Set<string>(SEARCH_PANEL_MESSAGE_IDS);
  const ai = new Set<string>(SEARCH_AI_MESSAGE_IDS);
  for (const file of ['search-panel.tsx', 'command-palette.tsx']) {
    it(`${file} names nothing outside SEARCH_PANEL_MESSAGE_IDS and the ai_assistant ids`, () => {
      const named = catalogueIds(file);
      expect(named.length).toBeGreaterThan(0);
      expect(named.filter((id) => !panel.has(id) && !ai.has(id))).toEqual([]);
    });
  }

  it('the AI strings are their own set, never in the panel bundle (T-0150, D-L194)', () => {
    expect(SEARCH_AI_MESSAGE_IDS.filter((id) => panel.has(id))).toEqual([]);
    // Every id the palette and dropdown name under ai_assistant is in it.
    const aiNamed = [...catalogueIds('command-palette.tsx'), ...catalogueIds('search-dropdown.tsx')].filter((id) =>
      /(^search\.ai\.|Ai$|\.ai$)/.test(id),
    );
    expect(aiNamed.length).toBeGreaterThan(0);
    expect(aiNamed.filter((id) => !ai.has(id))).toEqual([]);
  });

  it('the shell names no search string as a literal: only SHELL_SEARCH_STRINGS, all in the panel bundle', () => {
    expect(catalogueIds('../crm/crm-shell.tsx').filter((id) => id.startsWith('search.'))).toEqual([]);
    expect(Object.values(SHELL_SEARCH_STRINGS).filter((id) => !panel.has(id))).toEqual([]);
  });

  it('a CRM page carries the search strings only where crm_search is live (D-L137 L3)', () => {
    const base: readonly MessageId[] = ['app.name'];
    expect(withSearchMessages(base, ['contacts'])).toEqual(base);
    expect(withSearchMessages(base, ['contacts', 'search'])).toEqual([...base, ...SEARCH_PANEL_MESSAGE_IDS]);
    // The AI strings ride only with ai_assistant (T-0150): a page without the assistant sends none of them.
    expect(withSearchMessages(base, ['contacts', 'ai_assistant'])).toEqual(base);
    expect(withSearchMessages(base, ['contacts', 'search', 'ai_assistant'])).toEqual([
      ...base,
      ...SEARCH_PANEL_MESSAGE_IDS,
      ...SEARCH_AI_MESSAGE_IDS,
    ]);
    expect(CRM_SHELL_MESSAGE_IDS.filter((id) => id.startsWith('search.'))).toEqual([]);
  });

  it('search-screen.tsx names nothing outside SEARCH_MESSAGE_IDS', () => {
    const screen = new Set<string>(SEARCH_MESSAGE_IDS);
    expect(catalogueIds('search-screen.tsx').filter((id) => !screen.has(id))).toEqual([]);
  });

  it('bundles every group label, which a scan cannot see', () => {
    expect(SEARCH_TYPES.map(groupLabel).filter((id) => !panel.has(id))).toEqual([]);
  });

  it('resolves in every registered locale', () => {
    for (const locale of REGISTERED_LOCALES) {
      const ids = [...SEARCH_PANEL_MESSAGE_IDS, ...SEARCH_AI_MESSAGE_IDS];
      const bundle = bundleMessages(locale, ids);
      // T-0145: an ICU message crosses parsed (not a string), so "resolved" means present.
      expect(ids.filter((id: MessageId) => bundle[id] === undefined), locale).toEqual([]);
    }
  });
});
