import {
  COMPLIANCE_FIELDS,
  DEFAULT_PAGE_SIZE,
  MAX_CURSOR_LENGTH,
  MAX_PAGE_SIZE,
  MERGE_FIELDS,
} from '@kasuwa/domain-core';
import { CUSTOM_FIELD_KEY_PATTERN } from '@kasuwa/metadata-engine';
import { z } from 'zod';

/**
 * Boundary schemas for duplicates and merges (records.openapi.yaml, T-0093;
 * served by T-0095). Parse, never cast. Query schemas are not strict (an
 * unknown parameter is ignored, as on every records list); the merge body is.
 */

const Version = z.number().int().min(1).max(2_147_483_647);
const Side = z.enum(['survivor', 'merged']);

/** `custom.<key>`, the contract's MergeChoices pattern. */
export const CUSTOM_CHOICE = /^custom\.([a-z][a-z0-9_]*__c)$/;

const MERGE_FIELD_SET = new Set<string>(MERGE_FIELDS);
const COMPLIANCE_SET = new Set<string>(COMPLIANCE_FIELDS);

export function isMergeFieldKey(key: string): key is (typeof MERGE_FIELDS)[number] {
  return MERGE_FIELD_SET.has(key);
}

export function isComplianceKey(key: string): boolean {
  return COMPLIANCE_SET.has(key);
}

/** The custom api name of a `custom.<key>` choice, or null. */
export function customChoiceKey(key: string): string | null {
  const match = CUSTOM_CHOICE.exec(key);
  const name = match?.[1];
  return name !== undefined && CUSTOM_FIELD_KEY_PATTERN.test(name) ? name : null;
}

/** `MergeChoices`: keys a MergeField or `custom.<key>`, values a side. At most one per field. */
export const MergeChoices = z.record(z.string(), Side).superRefine((choices, ctx) => {
  for (const key of Object.keys(choices)) {
    if (!isMergeFieldKey(key) && customChoiceKey(key) === null) {
      // The key is a client's text: reported at `choices`, never named.
      ctx.addIssue({ code: 'custom', path: [], params: { reason: 'unknown_field' } });
      return;
    }
  }
});
export type MergeChoices = z.infer<typeof MergeChoices>;

/** `CreateContactMergeRequest`. Closed. */
export const CreateContactMergeBody = z.strictObject({
  survivorId: z.uuid(),
  mergedId: z.uuid(),
  survivorVersion: Version,
  mergedVersion: Version,
  choices: MergeChoices.optional(),
});
export type CreateContactMergeBody = z.infer<typeof CreateContactMergeBody>;

export const ProgrammeIdParam = z.object({ programmeId: z.uuid() });
export const MergeIdParam = z.object({ mergeId: z.uuid() });
export const ContactIdParam = z.object({ id: z.uuid() });
export const MergePreviewQuery = z.object({ with: z.uuid() });

/** `cursor` and `limit` only: no total, no offset (both lists). */
export const PageQuery = z.object({
  cursor: z.string().min(1).max(MAX_CURSOR_LENGTH).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});
