import { describe, expect, it } from 'vitest';
import {
  DUPLICATES_LIMIT,
  DUPLICATES_WINDOW_MS,
  DuplicatesThrottleGuard,
  retryAfterSeconds,
} from './duplicates-throttle.guard';
import {
  CreateContactMergeBody,
  customChoiceKey,
  isComplianceKey,
  isMergeFieldKey,
} from './merges.schemas';

const ID_A = '11111111-0000-4000-8000-0000000000a1';
const ID_B = '11111111-0000-4000-8000-0000000000b1';

describe('DuplicatesThrottleGuard (M7)', () => {
  it('admits the limit per user per window, then refuses until the window ends; users are separate', () => {
    const guard = new DuplicatesThrottleGuard();
    const now = 1_000_000;
    for (let n = 0; n < DUPLICATES_LIMIT; n += 1) expect(guard.admit('t:u1', now)).toBeNull();
    expect(guard.admit('t:u1', now)).toBe(now + DUPLICATES_WINDOW_MS);
    expect(guard.admit('t:u2', now)).toBeNull();
    expect(guard.admit('t:u1', now + DUPLICATES_WINDOW_MS)).toBeNull();
  });

  it('keeps the limit inside the suite bounds of 60..600', () => {
    expect(DUPLICATES_LIMIT).toBeGreaterThanOrEqual(60);
    expect(DUPLICATES_LIMIT).toBeLessThanOrEqual(600);
  });

  it('answers Retry-After in whole seconds, never below 1', () => {
    expect(retryAfterSeconds(10_500, 10_000)).toBe(1);
    expect(retryAfterSeconds(10_000, 10_000)).toBe(1);
    expect(retryAfterSeconds(70_000, 10_001)).toBe(60);
  });
});

describe('merge body', () => {
  it('knows the choosable fields, the compliance fields and the custom pattern', () => {
    expect(isMergeFieldKey('ownerUserId')).toBe(true);
    expect(isMergeFieldKey('dnd')).toBe(false);
    expect(isComplianceKey('consentState')).toBe(true);
    expect(customChoiceKey('custom.tier__c')).toBe('tier__c');
    expect(customChoiceKey('custom.Tier__c')).toBeNull();
    expect(customChoiceKey('tier__c')).toBeNull();
  });

  it('accepts a well-formed body and refuses unknown keys, sides and extra properties', () => {
    const body = { survivorId: ID_A, mergedId: ID_B, survivorVersion: 1, mergedVersion: 2 };
    expect(
      CreateContactMergeBody.safeParse({
        ...body,
        choices: { status: 'merged', 'custom.tier__c': 'survivor' },
      }).success,
    ).toBe(true);
    expect(CreateContactMergeBody.safeParse({ ...body, choices: { nope: 'merged' } }).success).toBe(
      false,
    );
    expect(CreateContactMergeBody.safeParse({ ...body, choices: { status: 'both' } }).success).toBe(
      false,
    );
    expect(CreateContactMergeBody.safeParse({ ...body, extra: 1 }).success).toBe(false);
    expect(CreateContactMergeBody.safeParse({ ...body, survivorVersion: 0 }).success).toBe(false);
  });
});
