import { IntlMessageFormat } from 'intl-messageformat';
import { DESIGN_MENU_LOCALES, LOCALE_SOURCES } from './catalogues';
import type { LocaleSource } from './catalogues';
import { requiredPluralCategories } from './plurals';

/**
 * The completeness gate.
 *
 *   Shipping a menu entry that falls back to English is worse than offering
 *   fewer languages.
 *
 * That sentence is the whole design. A hand-kept `SUPPORTED_LOCALES` drifts in
 * two directions and one of them ships the bug: somebody adds the constant
 * ahead of the catalogue, to "unblock the menu". So the constant is not kept at
 * all — it is COMPUTED here, from the catalogues themselves, and the list of
 * languages offered is the list of languages finished by construction.
 *
 * "Finished" has two halves and both are mechanical:
 *
 *   complete  — every message id present, nothing silently left in English,
 *               every plural category the language requires, no invented
 *               placeholders, parseable ICU.
 *   attested  — a named human who reads the language signed it off, or it is
 *               the source language. D-P1: "A language with no named reviewer
 *               should be treated as option 4 until it has one."
 *
 * The second half is why a machine-drafted catalogue that passes every
 * structural check still does not reach the menu. Structural completeness
 * proves the catalogue has no holes; it cannot prove the words are right, and
 * for the strings a user acts on ("Delete", "This cannot be undone") wrong is
 * worse than missing.
 */

export type LocaleKind = 'source' | 'full' | 'overlay';

export interface LocaleReadiness {
  readonly locale: string;
  readonly kind: LocaleKind;
  readonly complete: boolean;
  readonly attested: boolean;
  /** Complete AND attested. Only a ready locale can be offered. */
  readonly ready: boolean;
  /** Human-readable reasons it is not ready. Empty when it is. */
  readonly problems: readonly string[];
}

const SOURCE_LOCALE = 'en';

function baseTag(locale: string): string {
  return locale.split('-')[0] ?? locale;
}

function isOverlay(locale: string): boolean {
  return locale.includes('-') && baseTag(locale) !== locale;
}

/**
 * ICU argument node types, from `@formatjs/icu-messageformat-parser`. Named
 * here rather than imported so this file has no second dependency on the
 * parser's package layout.
 */
const NODE_LITERAL = 0;
const NODE_POUND = 7;
const NODE_TAG = 8;

interface AstNode {
  readonly type: number;
  readonly value?: unknown;
  readonly options?: Record<string, { value: readonly AstNode[] }>;
  readonly children?: readonly AstNode[];
}

/**
 * Every argument name in a message, taken from the parsed AST.
 *
 * **Do not do this with a regular expression.** The obvious pattern —
 * `/\{\s*(\w+)/g` — also matches the first word of a plural BRANCH BODY, so
 * `{count, plural, one {a single step} …}` reports a placeholder named `a`.
 * The first draft of this function did exactly that, and so did the acceptance
 * test that was meant to catch it, which is how it survived review twice.
 *
 * It hid because it only bites Latin script: `\w` is `[A-Za-z0-9_]`, so the
 * Arabic catalogue's `zero {لا خطوات}` passed while a Hausa branch had to be
 * written `{# mataki}` to get through. That is a real cost — it silently
 * forbids every plural form that does not lead with the number, which is a
 * normal way to write "a single step" in most of these languages.
 *
 * The AST has no such ambiguity: a branch body is a list of literal nodes, and
 * only an argument node carries a name.
 */
export function placeholderNames(message: string): Set<string> {
  const names = new Set<string>();

  const walk = (nodes: readonly AstNode[]): void => {
    for (const node of nodes) {
      if (node.type === NODE_LITERAL || node.type === NODE_POUND) continue;

      if (typeof node.value === 'string' && node.type !== NODE_TAG) {
        names.add(node.value);
      }

      if (node.options) {
        for (const branch of Object.values(node.options)) walk(branch.value);
      }
      if (node.children) walk(node.children);
    }
  };

  walk(new IntlMessageFormat(message, SOURCE_LOCALE).getAst() as readonly AstNode[]);
  return names;
}

function hasPluralArgument(message: string): boolean {
  return message.includes('plural,');
}

/** Checks one message against its English source. Returns problems, not throws. */
function checkMessage(
  locale: string,
  id: string,
  message: string,
  english: string,
  required: readonly string[],
): string[] {
  const problems: string[] = [];

  try {
    // Parsing is the only way to know an ICU message will render. A malformed
    // one throws on the screen that uses it, for the one user who chose that
    // language — the least observable failure the product can have.
    new IntlMessageFormat(message, locale);
  } catch (error) {
    problems.push(`${id}: unparseable ICU — ${(error as Error).message}`);
    return problems;
  }

  if (hasPluralArgument(message)) {
    for (const category of required) {
      if (!new RegExp(`\\b${category}\\s*\\{`).test(message)) {
        problems.push(`${id}: missing the "${category}" plural category`);
      }
    }
  }

  const expected = placeholderNames(english);
  for (const name of placeholderNames(message)) {
    if (!expected.has(name)) {
      problems.push(`${id}: unknown placeholder {${name}} — it will not be supplied`);
    }
  }
  for (const name of expected) {
    if (!placeholderNames(message).has(name)) {
      problems.push(`${id}: dropped placeholder {${name}} — the sentence will have a hole in it`);
    }
  }

  return problems;
}

function kindOf(locale: string): LocaleKind {
  if (locale === SOURCE_LOCALE) return 'source';
  return isOverlay(locale) ? 'overlay' : 'full';
}

/** Why `locale` is or is not finished. The gate, and the error message for it. */
export function localeReadiness(locale: string): LocaleReadiness {
  const kind = kindOf(locale);
  const entry: LocaleSource | undefined = LOCALE_SOURCES[locale];

  if (entry === undefined) {
    return {
      locale,
      kind,
      complete: false,
      attested: false,
      ready: false,
      problems: [`no catalogue at packages/i18n/src/locales/${locale}.json`],
    };
  }

  const english = LOCALE_SOURCES[SOURCE_LOCALE];
  if (english === undefined) {
    throw new Error('the English catalogue is missing; nothing can be checked against it');
  }

  const problems: string[] = [];
  const required = requiredPluralCategories(locale);
  const ids = Object.keys(english.messages);
  const declared = new Set(entry.passthrough);

  for (const id of Object.keys(entry.messages)) {
    if (!(id in english.messages)) {
      problems.push(`${id}: not a message id — it exists in ${locale} but not in English`);
    }
  }

  for (const id of ids) {
    const source = english.messages[id];
    if (source === undefined) continue;
    const message = entry.messages[id];

    if (message === undefined) {
      // An overlay is a partial catalogue by design: it holds only what differs
      // from its base, and the fallback chain supplies the rest. A full
      // catalogue with a hole is a language that falls back to English.
      if (kind !== 'overlay') {
        problems.push(`${id}: untranslated — no entry in ${locale}.json`);
      }
      continue;
    }

    if (kind !== 'source' && message === source && !declared.has(id)) {
      // Identical to English and not declared. It may be correct — a product
      // name, an abbreviation, a loanword — but an undeclared match is
      // indistinguishable from an untranslated string, and treating the two the
      // same is how half a catalogue ships.
      problems.push(
        `${id}: identical to English and not declared in ${locale}.passthrough.json`,
      );
      continue;
    }

    problems.push(...checkMessage(locale, id, message, source, required));
  }

  for (const id of entry.passthrough) {
    if (!(id in english.messages)) {
      problems.push(`${id}: declared as a passthrough but is not a message id`);
    }
  }

  const complete = problems.length === 0;
  const attested = entry.review.status === 'source' || entry.review.status === 'reviewed';

  if (!attested) {
    problems.push(
      `not attested: ${locale}.review.json says "${entry.review.status}"` +
        (entry.review.reviewer === null
          ? ' and names no reviewer (D-P1)'
          : ` (reviewer: ${entry.review.reviewer})`),
    );
  }

  return { locale, kind, complete, attested, ready: complete && attested, problems };
}

/** Readiness for every registered catalogue, in registration order. */
export function allLocaleReadiness(): readonly LocaleReadiness[] {
  return Object.keys(LOCALE_SOURCES).map(localeReadiness);
}

/**
 * The offered set, derived.
 *
 * Two independent conditions, and both are needed. The design export says which
 * languages the menu is FOR (`DESIGN_MENU_LOCALES`); readiness says which are
 * FINISHED. Offering is the intersection. Being in the design list is not
 * enough — that is the drift the gate exists to stop — and being finished is
 * not enough either, which is what keeps Arabic off a menu it was never on.
 *
 * A regional overlay rides on its base: `en-NG` is offered when `en` is offered
 * and the overlay itself is ready.
 */
export function deriveSupportedLocales(): readonly string[] {
  const offered = DESIGN_MENU_LOCALES.filter((locale) => localeReadiness(locale).ready);
  const offeredSet = new Set<string>(offered);

  const overlays = Object.keys(LOCALE_SOURCES).filter(
    (locale) =>
      isOverlay(locale) && offeredSet.has(baseTag(locale)) && localeReadiness(locale).ready,
  );

  return [...offered, ...overlays];
}
