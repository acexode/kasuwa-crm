import ar from './locales/ar.json';
import arPassthrough from './locales/ar.passthrough.json';
import arReview from './locales/ar.review.json';
import en from './locales/en.json';
import enReview from './locales/en.review.json';
import enNG from './locales/en-NG.json';
import enNGReview from './locales/en-NG.review.json';
import fr from './locales/fr.json';
import frPassthrough from './locales/fr.passthrough.json';
import frReview from './locales/fr.review.json';
import ha from './locales/ha.json';
import haPassthrough from './locales/ha.passthrough.json';
import haReview from './locales/ha.review.json';
import ig from './locales/ig.json';
import igPassthrough from './locales/ig.passthrough.json';
import igReview from './locales/ig.review.json';
import pcm from './locales/pcm.json';
import pcmPassthrough from './locales/pcm.passthrough.json';
import pcmReview from './locales/pcm.review.json';
import sw from './locales/sw.json';
import swPassthrough from './locales/sw.passthrough.json';
import swReview from './locales/sw.review.json';
import yo from './locales/yo.json';
import yoPassthrough from './locales/yo.passthrough.json';
import yoReview from './locales/yo.review.json';

/**
 * Every catalogue in the repository, with the two files that say what it means:
 * its declared passthroughs and its review attestation.
 *
 * A catalogue being HERE does not make its language offered. Registration and
 * offering are deliberately separate: Arabic is registered so RTL can be
 * exercised against real strings, and is not on the menu. What turns a
 * registered catalogue into an offered language is `completeness.ts`.
 */

/** Where the language menu's list comes from: the P01/1 design export. */
export const DESIGN_MENU_LOCALES = ['en', 'fr', 'pcm', 'ha', 'yo', 'ig', 'sw'] as const;

/**
 * Endonyms, transcribed from `docs/design/P01/v1.0/Kasuwa Auth Screen.dc.html`.
 * A language menu written in English is useless to the person who cannot read
 * English, which is the entire population it exists for. The diacritics are
 * part of the word: "Yorùbá", not "Yoruba (Nigeria)".
 */
export const LOCALE_LABELS: Readonly<Record<string, string>> = {
  en: 'English',
  'en-NG': 'English (Naija)',
  fr: 'Français',
  ha: 'Hausa',
  ig: 'Igbo',
  sw: 'Kiswahili',
  pcm: 'Pidgin',
  yo: 'Yorùbá',
  ar: 'العربية',
};

/**
 * `source`  — written in this repository, not translated for us. English and
 *             its regional overlays.
 * `reviewed` — a named human who reads the language signed it off (D-P1).
 * `awaiting-review` — a draft. Honest, useful to work against, NOT offerable.
 */
export type ReviewStatus = 'source' | 'reviewed' | 'awaiting-review';

const REVIEW_STATUSES: readonly string[] = ['source', 'reviewed', 'awaiting-review'];

export interface LocaleReview {
  readonly status: ReviewStatus;
  readonly method: string;
  readonly reviewer: string | null;
  readonly reviewedAt: string | null;
  readonly note: string;
  readonly decision: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('review file is not a JSON object');
  }
  return value as Record<string, unknown>;
}

function asNullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error(`review field "${field}" is not a string`);
  return value;
}

/**
 * Parsed rather than cast, because this file decides whether a language is
 * shown to users. A malformed attestation must fail loudly at load, not degrade
 * into "offered".
 */
export function parseReview(locale: string, raw: unknown): LocaleReview {
  const record = asRecord(raw);
  const status = record['status'];

  if (typeof status !== 'string' || !REVIEW_STATUSES.includes(status)) {
    throw new Error(
      `${locale}.review.json: status must be one of ${REVIEW_STATUSES.join(', ')}, got ${String(status)}`,
    );
  }

  const reviewer = asNullableString(record['reviewer'], 'reviewer');

  if (status === 'reviewed' && (reviewer === null || reviewer.trim() === '')) {
    // D-P1: "A language with no named reviewer should be treated as option 4
    // until it has one." An unsigned sign-off is not a sign-off.
    throw new Error(`${locale}.review.json: status "reviewed" requires a named reviewer`);
  }

  return {
    status: status as ReviewStatus,
    method: asNullableString(record['method'], 'method') ?? 'unspecified',
    reviewer,
    reviewedAt: asNullableString(record['reviewedAt'], 'reviewedAt'),
    note: asNullableString(record['note'], 'note') ?? '',
    decision: asNullableString(record['decision'], 'decision') ?? 'D-P1',
  };
}

export interface LocaleSource {
  readonly locale: string;
  readonly messages: Readonly<Record<string, string>>;
  /** Message ids this locale declares may legitimately match English. */
  readonly passthrough: readonly string[];
  readonly review: LocaleReview;
}

function source(
  locale: string,
  messages: Readonly<Record<string, string>>,
  passthrough: readonly string[],
  review: unknown,
): LocaleSource {
  return { locale, messages, passthrough, review: parseReview(locale, review) };
}

/** Every registered catalogue, keyed by locale tag. */
export const LOCALE_SOURCES: Readonly<Record<string, LocaleSource>> = {
  en: source('en', en, [], enReview),
  'en-NG': source('en-NG', enNG, [], enNGReview),
  fr: source('fr', fr, frPassthrough, frReview),
  ha: source('ha', ha, haPassthrough, haReview),
  ig: source('ig', ig, igPassthrough, igReview),
  sw: source('sw', sw, swPassthrough, swReview),
  pcm: source('pcm', pcm, pcmPassthrough, pcmReview),
  yo: source('yo', yo, yoPassthrough, yoReview),
  ar: source('ar', ar, arPassthrough, arReview),
};

export { en as EN_CATALOGUE, enNG as EN_NG_CATALOGUE };
