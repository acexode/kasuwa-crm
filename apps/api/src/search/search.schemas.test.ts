import { describe, expect, it } from 'vitest';
import {
  looksLikeIdentifier,
  parseEmail,
  parseLookupShape,
  parseLookupTypes,
  parsePhone,
  parseSearchQuery,
  type Parsed,
} from './search.schemas';

// Every value is synthetic; phone numbers are placeholders.
const codes = <T>(parsed: Parsed<T>): string[] =>
  parsed.ok ? [] : parsed.details.map((detail) => `${detail.path}:${detail.code}`);

describe('parseSearchQuery: the contract order, first code only (R17)', () => {
  it.each([
    [{}, 'q:query_required'],
    [{ phone: '08031234567' }, 'q:query_required'],
    [{ types: 'bogus' }, 'q:query_required'],
    [{ q: 'zqorder', phone: '08031234567' }, 'phone:identifier_in_url'],
    [{ q: 'zqorder', email: 'zq@example.test' }, 'email:identifier_in_url'],
    [{ q: `0803 123 4567 ${'x'.repeat(100)}` }, 'q:identifier_in_url'],
    [{ q: '08031234567\u0000' }, 'q:identifier_in_url'],
    [{ q: 'sample@example.test', types: 'bogus' }, 'q:identifier_in_url'],
    [{ q: ['zq', '08031234567'] }, 'q:identifier_in_url'],
    [{ q: 'zq\u0001', types: 'bogus' }, 'q:invalid_string'],
    [{ q: '́'.repeat(101) }, 'q:invalid_string'],
    [{ q: 'zq\tsample' }, 'q:invalid_string'],
    [{ q: ['zq', 'zqorder'] }, 'q:invalid_string'],
    [{ q: 'z', types: 'bogus' }, 'types:unknown_type'],
    [{ q: 'zqorder', types: 'contact,lead' }, 'types:unknown_type'],
    [{ q: 'zqorder', types: 'Contact' }, 'types:unknown_type'],
    [{ q: 'zqorder', types: '' }, 'types:unknown_type'],
    [{ q: 'zqorder', types: ['contact', 'contact'] }, 'types:duplicate_type'],
    [{ q: 'z' }, 'q:query_too_short'],
    [{ q: '  z  ' }, 'q:query_too_short'],
    [{ q: '́́́' }, 'q:query_too_short'],
  ])('%j -> %s', (query, expected) => {
    expect(codes(parseSearchQuery(query))).toEqual([expected]);
  });

  it('folds q, bounds the range and puts the types in canonical order (R15)', () => {
    const parsed = parseSearchQuery({ q: '  Zqfóld   Sa ', types: ['deal', 'contact'] });
    expect(parsed).toEqual({
      ok: true,
      value: { range: { prefix: 'zqfold sa', upper: 'zqfold sb' }, types: ['contact', 'deal'] },
    });
  });

  it('ignores unknown parameters and answers all four types by default (R16)', () => {
    const parsed = parseSearchQuery({ q: 'zq', programmeId: 'x', limit: '50' });
    expect(parsed.ok && parsed.value.types).toEqual(['contact', 'lead', 'account', 'deal']);
  });

  it('never puts a submitted value in a detail', () => {
    const parsed = parseSearchQuery({ q: 'zqecho', email: 'zq.echo@example.test' });
    expect(JSON.stringify(parsed)).not.toContain('zq.echo');
  });
});

describe('looksLikeIdentifier (CR21)', () => {
  it.each(['08031234567', '+234 803 123 4567', '(0803) 123-4567', 'a@b', '０８０３１２３４５６７'])(
    'refuses %s',
    (q) => expect(looksLikeIdentifier(q)).toBe(true),
  );
  it.each(['Sample 2026', 'Unit 12 Block 3456', 'Sample 12345', 'Fixture-12.34'])(
    'lets %s through',
    (q) => expect(looksLikeIdentifier(q)).toBe(false),
  );
});

describe('lookupRecords body: the contract order', () => {
  it.each([
    [[], 'body:invalid_type'],
    ['0803 000 0001', 'body:invalid_type'],
    [null, 'body:invalid_type'],
    [{ phone: '0803 000 0001', '08031230086': 1 }, 'body:unknown_property'],
    [{ phone: '0803 000 0001', email: 'zq@example.test', zq: 1 }, 'body:unknown_property'],
    [JSON.parse('{"__proto__": {"phone": "0803 000 0001"}}') as unknown, 'body:unknown_property'],
    [{}, 'phone:one_term_required'],
    [{ phone: '0803 000 0001', email: 'zq@example.test' }, 'phone:one_term_required'],
    [{ types: ['contact'] }, 'phone:one_term_required'],
  ])('%j -> %s', (body, expected) => {
    expect(codes(parseLookupShape(body))).toEqual([expected]);
  });

  it('never echoes a client key', () => {
    expect(JSON.stringify(parseLookupShape({ phone: 'x', '08031230086': 1 }))).not.toContain(
      '0803',
    );
  });

  it('phone: the schema shape, then the normaliser', () => {
    const accept = () => '+2348030000001';
    const refuse = () => null;
    expect(parsePhone('0803 000 0001', accept)).toEqual({ ok: true, value: '+2348030000001' });
    expect(codes(parsePhone('0803 000 0001', refuse))).toEqual(['phone:invalid_phone']);
    for (const raw of ['zq-0803', '12345', 8030000001, '0'.repeat(33), '0803\t0000001']) {
      expect(codes(parsePhone(raw, accept)), String(raw)).toEqual(['phone:invalid_phone']);
    }
  });

  it('email: one whole address once trimmed', () => {
    expect(parseEmail('  Zq.Mail@Example.Test ')).toEqual({
      ok: true,
      value: 'Zq.Mail@Example.Test',
    });
    for (const raw of [
      'zq',
      'zq.mail',
      'zq.mail@',
      '@example.test',
      'zq@example',
      'a b@x.test',
      1,
    ]) {
      expect(codes(parseEmail(raw)), String(raw)).toEqual(['email:invalid_email']);
    }
  });

  it('types: absent is all four; not an array, empty, unknown or repeated is refused', () => {
    expect(parseLookupTypes(undefined)).toEqual({
      ok: true,
      value: ['contact', 'lead', 'account', 'deal'],
    });
    expect(parseLookupTypes(['lead', 'contact'])).toEqual({ ok: true, value: ['contact', 'lead'] });
    expect(codes(parseLookupTypes('contact'))).toEqual(['types:invalid_type']);
    expect(codes(parseLookupTypes([]))).toEqual(['types:too_small']);
    expect(codes(parseLookupTypes(['bogus']))).toEqual(['types:unknown_type']);
    expect(codes(parseLookupTypes(['lead', 'lead']))).toEqual(['types:duplicate_type']);
  });
});
