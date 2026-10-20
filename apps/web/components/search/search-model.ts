import type { MessageId } from '@kasuwa/i18n/bundle';
import type { IconName } from '@kasuwa/ui';
import { hitHref, personName, type SearchGroup, type SearchHit, type SearchType } from '../../lib/search-api';

/**
 * The pure half of the P27 rows (T-0138): what a hit draws, the highlight of
 * the typed text inside it, and the object facets. No React, so the rules are
 * readable (and testable) without a browser.
 *
 * ONLY WHAT IS SERVED (R14, R15). A hit carries its name, a person's company,
 * a lead's status and its programme, and nothing else: no phone, owner,
 * amount or update time. A row never invents one.
 */

/** The 32px (dropdown) and 40px (results) tiles, per the export's `T` table. */
export const TYPE_ICON: Readonly<Record<SearchType, IconName>> = {
  contact: 'person',
  lead: 'campaign',
  account: 'apartment',
  deal: 'handshake',
};

/** contact primary, account info, deal success (P27 `T`); a lead, which P27 does not draw, takes the accent. */
export const TYPE_TINT: Readonly<Record<SearchType, string>> = {
  contact: 'bg-primary-soft text-primary-text',
  lead: 'bg-accent-soft text-accent-text',
  account: 'bg-info-soft text-info-text',
  deal: 'bg-success-soft text-success-text',
};

/** The results page's type tag ("Contact", "Account"). */
export const TYPE_LABEL: Readonly<Record<SearchType, MessageId>> = {
  contact: 'search.type.contact',
  lead: 'search.type.lead',
  account: 'search.type.account',
  deal: 'search.type.deal',
};

/** A lead status pill, in the P04 list's tones. */
export const LEAD_STATUS_TONE: Readonly<Record<string, string>> = {
  new: 'bg-info-soft text-info-text',
  contacted: 'bg-primary-soft text-primary-text',
  qualified: 'bg-success-soft text-success-text',
  unqualified: 'bg-surface-sunken text-text-2',
};

export const LEAD_STATUS_LABEL: Readonly<Record<string, MessageId>> = {
  new: 'records.status.new',
  contacted: 'records.status.contacted',
  qualified: 'records.status.qualified',
  unqualified: 'records.status.unqualified',
};

export interface SearchRow {
  readonly id: string;
  readonly type: SearchType;
  readonly hit: SearchHit;
  /** `null` draws the lock and the neutral "withheld" label (D-L68). */
  readonly name: string | null;
  /** A person's company, when served and not the name itself. */
  readonly detail: string | null;
  readonly status: string | null;
  readonly href: string | null;
}

export function rowsOf(baseId: string, groups: readonly SearchGroup[], dealsLive: boolean): SearchRow[] {
  return groups.flatMap((group) =>
    group.hits.map((hit, index) => {
      const name = hit.kind === 'person' ? personName(hit) : hit.name;
      const company =
        hit.kind === 'person' && typeof hit.companyName === 'string' && hit.companyName.trim() !== '' && hit.companyName !== name
          ? hit.companyName
          : null;
      return {
        // A lead is in the contact AND the lead group: ids come from the group and the position, never the record.
        id: `${baseId}-${group.type}-${index}`,
        type: group.type,
        hit,
        name,
        detail: company,
        status: hit.kind === 'person' && group.type === 'lead' && hit.status !== undefined ? hit.status : null,
        href: hitHref(group.type, hit.id, dealsLive),
      };
    }),
  );
}

// ---------------------------------------------------------------------------
// Highlight
// ---------------------------------------------------------------------------

export interface Segment {
  readonly text: string;
  readonly match: boolean;
}

/**
 * Folds one character the way the search folds a field (NFD, combining marks
 * removed, lower-cased), so a match found in the folded text maps back to the
 * characters the person sees: "ade" marks the "Adé" of "Adébáyọ̀".
 */
function foldWithMap(text: string): { folded: string; origin: number[] } {
  let folded = '';
  const origin: number[] = [];
  let offset = 0;
  for (const character of text) {
    const piece = character.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    for (let index = 0; index < piece.length; index += 1) origin.push(offset);
    folded += piece;
    offset += character.length;
  }
  origin.push(text.length);
  return { folded, origin };
}

/**
 * The parts of `text` that match a word of the query, for the accent-soft
 * mark (P27 A1, C). Each word is found once, at the start of a word where it
 * can be, else anywhere. A lookup (a number or address) marks nothing: the
 * hit carries no number to mark.
 */
export function highlight(text: string, query: string): Segment[] {
  const words = query
    .normalize('NFKC')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/\s+/u)
    .filter((word) => word !== '');
  if (words.length === 0 || text === '') return [{ text, match: false }];
  const { folded, origin } = foldWithMap(text);
  const ranges: [number, number][] = [];
  for (const word of words) {
    let at = -1;
    for (let from = folded.indexOf(word); from >= 0; from = folded.indexOf(word, from + 1)) {
      if (from === 0 || /[\s\-'’(&·]/u.test(folded.charAt(from - 1))) {
        at = from;
        break;
      }
      if (at < 0) at = from;
    }
    if (at >= 0) ranges.push([origin[at] ?? 0, origin[at + word.length] ?? text.length]);
  }
  if (ranges.length === 0) return [{ text, match: false }];
  ranges.sort((a, b) => a[0] - b[0]);
  const segments: Segment[] = [];
  let cursor = 0;
  for (const [rawStart, end] of ranges) {
    const start = Math.max(rawStart, cursor);
    if (end <= start) continue;
    if (start > cursor) segments.push({ text: text.slice(cursor, start), match: false });
    segments.push({ text: text.slice(start, end), match: true });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false });
  return segments;
}

// ---------------------------------------------------------------------------
// Object facets (no counts, D-P13)
// ---------------------------------------------------------------------------

/** The served types that have at least one hit in this answer: a chip or an enabled box, never a number. */
export function typesWithHits(groups: readonly SearchGroup[]): SearchType[] {
  return groups.filter((group) => group.hits.length > 0).map((group) => group.type);
}

/** The groups a set of chosen types keeps; none chosen keeps them all. */
export function narrow(groups: readonly SearchGroup[], chosen: readonly SearchType[]): SearchGroup[] {
  return chosen.length === 0 ? [...groups] : groups.filter((group) => chosen.includes(group.type));
}
