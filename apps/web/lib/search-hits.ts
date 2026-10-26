import { z } from 'zod';

/**
 * The hits `searchRecords` and `lookupRecords` answer with
 * (`docs/api/records.openapi.yaml`, T-0085): what the SERVER serves on each
 * hit, parsed. Nothing here is sent; the request side is `search-api.ts`,
 * which holds no scope argument (CLAUDE.md 2.2). Kept apart so that module
 * is only the request (T-0151).
 */

export const SEARCH_TYPES = ['contact', 'lead', 'account', 'deal'] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

/** A lead's status, served on lead hits only (LeadSearchHit); the P27 rows draw it as a status pill (T-0138). */
export const LEAD_HIT_STATUSES = ['new', 'contacted', 'qualified', 'unqualified'] as const;
export type LeadHitStatus = (typeof LEAD_HIT_STATUSES)[number];

const PersonHit = z.object({
  id: z.string(),
  programmeId: z.string().optional(),
  status: z.enum(LEAD_HIT_STATUSES).optional().catch(undefined),
  displayName: z.string().optional(),
  givenNames: z.string().nullable().optional(),
  familyName: z.string().nullable().optional(),
  companyName: z.string().nullable().optional(),
  withheldFields: z.array(z.string()),
});

const NamedHit = z.object({
  id: z.string(),
  programmeId: z.string().optional(),
  name: z.string(),
});

export interface PersonSearchHit {
  readonly kind: 'person';
  readonly id: string;
  /** The hit's programme, as served; P27 names it only behind `programme_scope_search` (T-0138). */
  readonly programmeId?: string | undefined;
  /** A lead hit's status (contacts carry none). */
  readonly status?: LeadHitStatus | undefined;
  readonly displayName?: string | undefined;
  readonly givenNames?: string | null | undefined;
  readonly familyName?: string | null | undefined;
  readonly companyName?: string | null | undefined;
  readonly withheldFields: readonly string[];
}

export interface NamedSearchHit {
  readonly kind: 'named';
  readonly id: string;
  readonly programmeId?: string | undefined;
  readonly name: string;
}

export type SearchHit = PersonSearchHit | NamedSearchHit;

export interface SearchGroup {
  readonly type: SearchType;
  readonly hits: readonly SearchHit[];
}

/** At most three hits per group (the contract's `maxItems`); never more drawn. */
export const HITS_PER_GROUP = 3;

export function parseHit(type: SearchType, raw: unknown): SearchHit | null {
  if (type === 'contact' || type === 'lead') {
    const parsed = PersonHit.safeParse(raw);
    return parsed.success ? { kind: 'person', ...parsed.data } : null;
  }
  const parsed = NamedHit.safeParse(raw);
  return parsed.success ? { kind: 'named', ...parsed.data } : null;
}
