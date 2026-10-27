import type { z } from 'zod';

/**
 * The code a validation issue carries on the wire (`details[].code`).
 *
 * The API's contract was written against zod 3's issue codes, and clients
 * switch on them (docs/api, the web run model, the e2e mocks). Zod 4 renamed
 * and merged several, so this maps the zod 4 issue back onto the vocabulary
 * the contract already has. A code zod 4 did not touch passes through.
 *
 *   zod 4 `invalid_format`          -> `invalid_string`   (uuid, regex, email, datetime, ...)
 *   zod 4 `invalid_value`, 1 value  -> `invalid_literal`
 *   zod 4 `invalid_value`, n values -> `invalid_enum_value`
 *   zod 4 `invalid_key`             -> the code of the key's own failure
 *
 * Never reads the issue's message or input: a code names the failure, never the
 * value (CLAUDE.md section 6.1).
 */
export function wireIssueCode(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case 'invalid_format':
      return 'invalid_string';
    case 'invalid_value':
      return issue.values.length === 1 ? 'invalid_literal' : 'invalid_enum_value';
    case 'invalid_key': {
      const [inner] = issue.issues;
      return inner === undefined ? 'invalid_string' : wireIssueCode(inner as z.core.$ZodIssue);
    }
    default:
      return issue.code;
  }
}
