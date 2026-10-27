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
    case 'invalid_union':
      // zod 3 named a discriminated union's unknown (or missing) tag on its own (D-L209).
      return 'discriminator' in issue && issue.discriminator !== undefined
        ? 'invalid_union_discriminator'
        : issue.code;
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

/**
 * The issues as zod 3 reported them (D-L209). When a plain union's value matched
 * exactly one option's TYPE and failed that option's own check (an array over its
 * `.max()`), zod 3 reported that option's issues, at their full paths; zod 4 can
 * report the union instead. An option whose only issue is a root `invalid_type`
 * did not match. Every other issue passes through unchanged.
 */
export function wireIssues(issues: readonly z.core.$ZodIssue[]): z.core.$ZodIssue[] {
  return issues.flatMap((issue): z.core.$ZodIssue[] => {
    if (
      issue.code !== 'invalid_union' ||
      ('discriminator' in issue && issue.discriminator !== undefined)
    ) {
      return [issue];
    }
    const matched = issue.errors.filter(
      (branch) =>
        !(branch.length === 1 && branch[0]?.code === 'invalid_type' && branch[0].path.length === 0),
    );
    const [only] = matched;
    if (matched.length !== 1 || only === undefined || only.length === 0) return [issue];
    return wireIssues(
      only.map((inner) => ({ ...inner, path: [...issue.path, ...inner.path] }) as z.core.$ZodIssue),
    );
  });
}
