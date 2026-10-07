import { z } from 'zod';

/**
 * Free text at the HTTP boundary (T-0055, D-L78).
 *
 * Postgres `text` cannot store U+0000. Bound as a parameter it fails with
 * SQLSTATE 22021, which reaches a client as a scrubbed `500`: nothing leaks,
 * but client input must never cause a 500. A NUL is therefore refused here,
 * as `400 validation_failed` with the reason code `invalid_character` at the
 * field's path, and never silently stripped (stripping would store a value
 * the client did not send).
 *
 * Lengths are counted in CODE POINTS, as the contract's JSON Schema
 * `minLength`/`maxLength` are and as Postgres `char_length` (0019's
 * `account_name_length_check`) is. Zod's own `.min`/`.max` count UTF-16 units,
 * which would refuse a 200-character name containing an emoji.
 *
 * Shared, so every free-text field gets the same rule: D-L78 asks for it on
 * the contacts write path too (a tracked follow-up, not done here).
 */

export const NUL_REASON = 'invalid_character';
export const TOO_SHORT_REASON = 'too_small';
export const TOO_LONG_REASON = 'too_big';

/** True when `value` holds a NUL. */
export function hasNul(value: string): boolean {
  return value.includes('\u0000');
}

/** Length in code points, as JSON Schema and Postgres count it. */
export function codePointLength(value: string): number {
  return [...value].length;
}

/**
 * A string of `min`..`max` code points with no NUL. Each failure is a custom
 * issue carrying a stable `params.reason`, which the error filter turns into
 * `details[].code`; the value itself is never echoed.
 */
export function text(min: number, max: number) {
  return z.string().superRefine((value, context) => {
    if (hasNul(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'contains a NUL character',
        params: { reason: NUL_REASON },
      });
      return;
    }
    const length = codePointLength(value);
    if (length < min) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `shorter than ${min}`,
        params: { reason: TOO_SHORT_REASON },
      });
    } else if (length > max) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `longer than ${max}`,
        params: { reason: TOO_LONG_REASON },
      });
    }
  });
}
