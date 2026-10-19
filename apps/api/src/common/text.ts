/**
 * Free text at the HTTP boundary (T-0055, D-L78). The helpers moved into
 * @kasuwa/domain-core with T-0094, so the import worker validates CSV rows
 * with exactly the same rule; this file keeps every API import path working.
 */
export {
  NUL_REASON,
  TOO_LONG_REASON,
  TOO_SHORT_REASON,
  codePointLength,
  hasNul,
  text,
} from '@kasuwa/domain-core';
