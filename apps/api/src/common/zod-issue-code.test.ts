import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { wireIssueCode, wireIssues } from './zod-issue-code';

/** The codes the API contract was written against (zod 3), per failing input. */
function codesOf(schema: z.ZodType, input: unknown): string[] {
  const result = schema.safeParse(input);
  if (result.success) throw new Error('control: expected the input to be refused');
  return result.error.issues.map((issue) => wireIssueCode(issue));
}

describe('wireIssueCode: zod 4 issues keep the zod 3 codes on the wire', () => {
  it('a bad uuid, regex, email, url or timestamp is invalid_string', () => {
    expect(codesOf(z.uuid(), 'nope')).toEqual(['invalid_string']);
    expect(codesOf(z.string().regex(/^a$/), 'b')).toEqual(['invalid_string']);
    expect(codesOf(z.email(), 'nope')).toEqual(['invalid_string']);
    expect(codesOf(z.url(), 'nope')).toEqual(['invalid_string']);
    expect(codesOf(z.iso.datetime({ offset: true }), 'nope')).toEqual(['invalid_string']);
  });

  it('a value outside an enum is invalid_enum_value, outside a literal invalid_literal', () => {
    expect(codesOf(z.enum(['a', 'b']), 'c')).toEqual(['invalid_enum_value']);
    expect(codesOf(z.literal(1), 2)).toEqual(['invalid_literal']);
  });

  it('a record key that fails is the code of the key failure, at the key', () => {
    const schema = z.record(z.string().regex(/^[a-z]+$/), z.number());
    const result = schema.safeParse({ BAD: 1 });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.path.join('.'))).toEqual(['BAD']);
    expect(result.error.issues.map((issue) => wireIssueCode(issue))).toEqual(['invalid_string']);
  });

  it('codes zod 4 did not rename pass through', () => {
    expect(codesOf(z.object({ a: z.string() }), {})).toEqual(['invalid_type']);
    expect(codesOf(z.string().min(2), 'a')).toEqual(['too_small']);
    expect(codesOf(z.array(z.string()).max(1), ['a', 'b'])).toEqual(['too_big']);
    expect(codesOf(z.strictObject({ a: z.string() }), { a: 'x', b: 1 })).toEqual([
      'unrecognized_keys',
    ]);
  });

  it('never carries the submitted value', () => {
    const secret = 'a-secret-value-0123456789';
    const schema = z.enum(['a', 'b']);
    const [code] = codesOf(schema, secret);
    expect(code).toBe('invalid_enum_value');
    expect(JSON.stringify(codesOf(z.uuid(), secret))).not.toContain(secret);
  });
});

describe('wireIssues: unions report as zod 3 did (D-L209)', () => {
  const wire = (schema: z.ZodType, input: unknown): Array<{ path: string; code: string }> => {
    const result = schema.safeParse(input);
    if (result.success) throw new Error('control: expected the input to be refused');
    return wireIssues(result.error.issues).map((issue) => ({
      path: issue.path.join('.'),
      code: wireIssueCode(issue),
    }));
  };

  const node = z.discriminatedUnion('type', [
    z.object({ type: z.literal('say'), text: z.string() }),
    z.object({ type: z.literal('ask'), question: z.string() }),
  ]);

  it('an unknown or missing discriminator is invalid_union_discriminator at the tag', () => {
    expect(wire(z.object({ nodes: z.array(node) }), { nodes: [{ type: 'video' }] })).toEqual([
      { path: 'nodes.0.type', code: 'invalid_union_discriminator' },
    ]);
    expect(wire(node, {})).toEqual([{ path: 'type', code: 'invalid_union_discriminator' }]);
  });

  it('a value that matched one option’s type reports that option’s own failure, at its full path', () => {
    const value = z.object({ value: z.union([z.string().max(200), z.array(z.string()).max(20)]) });
    expect(wire(value, { value: Array(21).fill('a') })).toEqual([
      { path: 'value', code: 'too_big' },
    ]);
    expect(wire(value, { value: 'a'.repeat(201) })).toEqual([{ path: 'value', code: 'too_big' }]);
    expect(
      wire(z.object({ field: z.union([z.string().regex(/^[a-z]+$/), z.number()]) }), {
        field: 'phone_x',
      }),
    ).toEqual([{ path: 'field', code: 'invalid_string' }]);
  });

  it('a value that matched no option is still invalid_union', () => {
    expect(
      wire(z.object({ value: z.union([z.string(), z.array(z.string())]) }), { value: 5 }),
    ).toEqual([{ path: 'value', code: 'invalid_union' }]);
  });
});
