import { DatabaseError } from 'pg';
import { describe, expect, it } from 'vitest';
import { isSqlState, scrubError, scrubbedFields } from './scrub-error';

/** Invented probe values (CLAUDE.md 6): none can occur in a log by chance. */
const EMAIL = 'ngozi.okafor.unit-probe@example.test';
const NIN = '00000000099';

function pgError(code: string): DatabaseError {
  return Object.assign(new DatabaseError(`value "${EMAIL}" rejected`, 0, 'error'), { code });
}

describe('scrubError: the class', () => {
  it('names a pg error by its class, not by pg’s `name` of "error"', () => {
    expect(scrubError(pgError('23505'))).toEqual({ errorClass: 'DatabaseError', code: '23505' });
  });

  it('logs a thrown non-Error as UnknownError, whatever name it carries', () => {
    expect(scrubError({ name: 'Chidinma' })).toEqual({ errorClass: 'UnknownError', code: null });
    expect(scrubError({ name: EMAIL }).errorClass).toBe('UnknownError');
    class Person {
      readonly name = 'Chidinma';
    }
    expect(scrubError(new Person()).errorClass).toBe('UnknownError');
    expect(scrubError('a string thrown').errorClass).toBe('UnknownError');
    expect(scrubError(null)).toEqual({ errorClass: 'UnknownError', code: null });
  });

  it('never takes a class name that is not an identifier', () => {
    const renamed = new Error('x');
    renamed.name = EMAIL;
    Object.defineProperty(renamed, 'constructor', { value: { name: 'not an identifier' } });
    expect(scrubError(renamed).errorClass).toBe('UnknownError');
  });
});

describe('scrubError: the code', () => {
  it('rejects a five-digit value that is not a real SQLSTATE class, on an Error or an object', () => {
    expect(isSqlState('12345')).toBe(false);
    expect(scrubError(Object.assign(new Error('x'), { code: '12345' })).code).toBeNull();
    expect(scrubError({ code: '12345' }).code).toBeNull();
    expect(scrubError(pgError('12345')).code).toBeNull();
  });

  it('accepts real SQLSTATEs, including the lettered classes', () => {
    for (const code of ['23505', '23514', '22P02', '40001', '0A000', 'P0001', 'XX000', '57014']) {
      expect(isSqlState(code), code).toBe(true);
    }
    expect(scrubError(pgError('22P02')).code).toBe('22P02');
  });

  it('only takes a code from an Error', () => {
    expect(scrubError({ code: '23505' }).code).toBeNull();
    expect(scrubError({ code: 'ECONNREFUSED' }).code).toBeNull();
  });

  it('prefers a wrapped pg DatabaseError’s SQLSTATE', () => {
    const wrapped = new Error('query failed', { cause: pgError('23505') });
    expect(scrubError(wrapped)).toEqual({ errorClass: 'Error', code: '23505' });
  });

  it('keeps a Node system code and drops a code that could be data', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(scrubError(refused).code).toBe('ECONNREFUSED');
    expect(scrubError(Object.assign(new Error('x'), { code: NIN })).code).toBeNull();
    expect(scrubError(Object.assign(new Error('x'), { code: EMAIL })).code).toBeNull();
  });

  it('survives a throwing getter', () => {
    const hostile = new Error('x');
    Object.defineProperty(hostile, 'code', {
      get(): string {
        throw new Error(EMAIL);
      },
    });
    expect(scrubError(hostile)).toEqual({ errorClass: 'Error', code: null });
  });
});

describe('scrubbedFields', () => {
  it('prints class and code only', () => {
    expect(scrubbedFields({ errorClass: 'DatabaseError', code: '23505' })).toBe(
      'class=DatabaseError code=23505',
    );
    expect(scrubbedFields({ errorClass: 'TypeError', code: null })).toBe('class=TypeError');
  });
});
