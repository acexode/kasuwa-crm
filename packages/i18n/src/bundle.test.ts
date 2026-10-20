import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { IntlMessageFormat } from 'intl-messageformat';
import { describe, expect, it } from 'vitest';
import { FORMATTED_ELEMENT_TYPES } from './bundle';
import {
  MESSAGE_IDS,
  REGISTERED_LOCALES,
  bundleMessages,
  createBundleTranslator,
  requiredPluralCategories,
  translate,
  type MessageId,
} from './index';
import ha from './locales/ha.json';

/**
 * The server-resolves / client-formats split that keeps nine catalogues out of
 * the browser bundle (see the note on `MessageBundle`).
 *
 * The property that matters is not "it formats a string". It is that the bundle
 * cannot silently pretend: a missing id has to throw here exactly as it does in
 * `createTranslator`, because the alternative — a blank button — hides the bug
 * until a customer reports it.
 */
describe('bundleMessages', () => {
  it('resolves through the fallback chain, not from one file', () => {
    // `en-NG` is an overlay holding only what differs. `nav.skipToContent` is
    // not in it, so this can only come from `en` — which is the chain working.
    const bundle = bundleMessages('en-NG', ['app.tagline', 'nav.skipToContent']);
    expect(bundle['app.tagline']).toContain('Naija');
    expect(bundle['nav.skipToContent']).toBe('Skip to content');
  });

  it('throws on an id that does not exist', () => {
    expect(() => bundleMessages('en', ['auth.signIn.nope' as 'app.name'])).toThrow(/auth\.signIn\.nope/);
  });
});

describe('createBundleTranslator', () => {
  it('throws when a screen forgot to ask for a string', () => {
    const t = createBundleTranslator('en', bundleMessages('en', ['app.name']));
    expect(() => t.t('auth.signIn.title')).toThrow(/not in the bundle/);
  });

  it('formats ICU arguments, including the plural on the lockout counter', () => {
    const t = createBundleTranslator('en', bundleMessages('en', ['auth.attemptsRemaining']));
    expect(t.t('auth.attemptsRemaining', { count: 1 })).toContain('1 more try');
    expect(t.t('auth.attemptsRemaining', { count: 4 })).toContain('4 more tries');
  });

  it('uses the LOCALE’s plural rules, not English ones', () => {
    // The failure this guards against is invisible to an English reviewer: a
    // catalogue written with only `one`/`other` renders `other` for every
    // category the language actually requires. Hausa needs `one` and `other`;
    // the point is that the formatter is asked in Hausa, not in English.
    const t = createBundleTranslator('ha', bundleMessages('ha', ['auth.attemptsRemaining']));
    const one = t.t('auth.attemptsRemaining', { count: 1 });
    const many = t.t('auth.attemptsRemaining', { count: 4 });

    expect(one).not.toBe('');
    expect(one).not.toBe(many);
    expect(ha['auth.attemptsRemaining']).toContain('plural,');
    for (const category of requiredPluralCategories('ha')) {
      expect(ha['auth.attemptsRemaining']).toMatch(new RegExp(`\\b${category}\\s*\\{`));
    }
  });
});

/**
 * T-0145: ICU messages cross to the browser already parsed, and the browser
 * formats them with `bundle.ts`'s own formatter instead of loading
 * `intl-messageformat` (about 12 KB gzipped on every page). What must hold is
 * that a screen cannot tell: the same words come out, in the locale's plural
 * rules, for every message every catalogue has.
 */
describe('parsed messages and the browser formatter (T-0145)', () => {
  interface Node {
    readonly type: number;
    readonly value?: unknown;
    readonly options?: Record<string, { readonly value: readonly Node[] }>;
  }

  /** Every argument a tree reads, with the values worth trying for it. */
  function samples(nodes: readonly Node[], found = new Map<string, unknown[]>()): Map<string, unknown[]> {
    for (const node of nodes) {
      const name = typeof node.value === 'string' ? node.value : '';
      if (node.type === 1 && !found.has(name)) found.set(name, ['Ada Obi', 42, '', 0]);
      if (node.type === 5) found.set(name, [...Object.keys(node.options ?? {}), 'not-an-option']);
      if (node.type === 6) found.set(name, [0, 1, 2, 3, 5, 6, 11, 21, 100, 1000000, 1.5]);
      for (const option of Object.values(node.options ?? {})) samples(option.value, found);
    }
    return found;
  }

  function kinds(nodes: readonly Node[]): number[] {
    return nodes.flatMap((node) => [node.type, ...Object.values(node.options ?? {}).flatMap((option) => kinds(option.value))]);
  }

  function outcome(run: () => unknown): unknown {
    try {
      return run();
    } catch {
      return 'THROWS';
    }
  }

  it('sends a message with no ICU syntax as its string, untouched', () => {
    const bundle = bundleMessages('en', ['nav.skipToContent']);
    expect(bundle['nav.skipToContent']).toBe('Skip to content');
  });

  it('sends a message with ICU syntax as a parse tree that survives JSON', () => {
    const message = bundleMessages('en', ['auth.attemptsRemaining'])['auth.attemptsRemaining'];
    expect(Array.isArray(message)).toBe(true);
    expect(JSON.parse(JSON.stringify(message))).toEqual(message);
  });

  it('formats every ICU message in every locale exactly as intl-messageformat does', () => {
    let compared = 0;
    for (const locale of REGISTERED_LOCALES) {
      const bundle = bundleMessages(locale, MESSAGE_IDS);
      const t = createBundleTranslator(locale, bundle);
      for (const id of MESSAGE_IDS) {
        const parsed = bundle[id];
        if (typeof parsed === 'string' || parsed === undefined) continue;
        const raw = translate(locale, id);
        const reference = new IntlMessageFormat(raw, locale);
        const args = samples(parsed as readonly Node[]);
        const base: Record<string, string | number> = {};
        for (const [name, tries] of args) base[name] = tries[0] as string | number;
        const cases: (Record<string, string | number> | undefined)[] = [undefined, base];
        for (const [name, tries] of args) {
          for (const value of tries) cases.push({ ...base, [name]: value as string | number });
        }
        for (const values of cases) {
          const expected = outcome(() => reference.format(values));
          const actual = outcome(() => t.t(id as MessageId, values));
          expect(actual, `${locale} ${id} ${JSON.stringify(values)}`).toEqual(expected);
          compared += 1;
        }
      }
    }
    expect(compared).toBeGreaterThan(1000);
  });

  it('meets no element kind the browser formatter does not handle, in any catalogue', () => {
    const unhandled: string[] = [];
    for (const locale of REGISTERED_LOCALES) {
      const bundle = bundleMessages(locale, MESSAGE_IDS);
      for (const id of MESSAGE_IDS) {
        const parsed = bundle[id];
        if (typeof parsed === 'string' || parsed === undefined) continue;
        const odd = kinds(parsed as readonly Node[]).filter((kind) => !FORMATTED_ELEMENT_TYPES.includes(kind));
        if (odd.length > 0) unhandled.push(`${locale} ${id}: ${odd.join(', ')}`);
      }
    }
    expect(unhandled).toEqual([]);
  });

  it('keeps intl-messageformat out of the module the browser loads', () => {
    const source = readFileSync(resolve(__dirname, 'bundle.ts'), 'utf8');
    expect(source).not.toMatch(/from 'intl-messageformat'|require\('intl-messageformat'\)/);
    expect(source).not.toMatch(/from '@formatjs\//);
  });

  it('throws on a message that did not parse, where a screen formats it', () => {
    const t = createBundleTranslator('en', { broken: 'Hello {name' });
    expect(() => t.t('broken' as 'app.name', { name: 'Ada' })).toThrow();
  });

  it('formats the lockout counter in Hausa from the parsed tree', () => {
    const t = createBundleTranslator('ha', bundleMessages('ha', ['auth.attemptsRemaining']));
    expect(t.t('auth.attemptsRemaining', { count: 1 })).toBe(translate('ha', 'auth.attemptsRemaining', { count: 1 }));
    expect(t.t('auth.attemptsRemaining', { count: 4 })).toBe(translate('ha', 'auth.attemptsRemaining', { count: 4 }));
  });
});
