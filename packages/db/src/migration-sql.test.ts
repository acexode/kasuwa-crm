import { describe, expect, it } from 'vitest';
import {
  checkNoTransactionFile,
  hasNoTransactionMarker,
  NO_TRANSACTION_MARKER,
  splitStatements,
} from './migration-sql';

function texts(sql: string): string[] {
  return splitStatements(sql).map((statement) => statement.text);
}

describe('splitStatements', () => {
  it('splits on semicolons and trims', () => {
    expect(texts('SELECT 1;\n  SELECT 2 ;\nSELECT 3')).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3']);
  });

  it('drops empty statements and statements that are only comments', () => {
    expect(texts(';;\n-- just a comment\n;/* block */;  \n')).toEqual([]);
  });

  it('runs from the first token to the last, keeping comments inside but not around it', () => {
    expect(texts('-- header\n/* more */\nSELECT /* inline */ 1 -- trailing\n;')).toEqual([
      'SELECT /* inline */ 1',
    ]);
  });

  it('does not split on a semicolon inside a single-quoted string, including doubled quotes', () => {
    expect(texts("SELECT 'a;b', 'it''s; fine';SELECT 2;")).toEqual([
      "SELECT 'a;b', 'it''s; fine'",
      'SELECT 2',
    ]);
  });

  it('honours backslash escapes in E-strings only', () => {
    expect(texts("SELECT E'a\\';b';SELECT 2;")).toEqual(["SELECT E'a\\';b'", 'SELECT 2']);
    // In a standard string a backslash is just a character.
    expect(texts("SELECT 'a\\';SELECT 2;")).toEqual(["SELECT 'a\\'", 'SELECT 2']);
    // An identifier ending in e is not an E-string prefix.
    expect(texts("SELECT name'x\\';SELECT 2;")).toEqual(["SELECT name'x\\'", 'SELECT 2']);
  });

  it('does not split inside a double-quoted identifier', () => {
    expect(texts('SELECT 1 AS "a;""b";SELECT 2')).toEqual(['SELECT 1 AS "a;""b"', 'SELECT 2']);
  });

  it('does not split inside dollar quotes, tagged or not', () => {
    const body = 'DO $$ BEGIN PERFORM 1; PERFORM 2; END $$';
    const tagged = 'CREATE FUNCTION f() RETURNS int AS $fn$ SELECT 1; $$ nested $$ $fn$ LANGUAGE sql';
    expect(texts(`${body};\n${tagged};SELECT 3;`)).toEqual([body, tagged, 'SELECT 3']);
  });

  it('treats $1 as a parameter and a $ inside an identifier as part of it', () => {
    expect(texts('SELECT $1; SELECT a$b$ FROM t; SELECT 3')).toEqual([
      'SELECT $1',
      'SELECT a$b$ FROM t',
      'SELECT 3',
    ]);
  });

  it('does not split inside comments, and nests block comments', () => {
    expect(texts('SELECT 1 -- a; b\n, 2;SELECT /* x /* y; */ z; */ 2;')).toEqual([
      'SELECT 1 -- a; b\n, 2',
      'SELECT /* x /* y; */ z; */ 2',
    ]);
  });

  it('refuses unterminated strings, identifiers, dollar quotes and comments', () => {
    expect(() => splitStatements("SELECT 'open")).toThrow(/unterminated/i);
    expect(() => splitStatements('SELECT "open')).toThrow(/unterminated/i);
    expect(() => splitStatements('DO $x$ BEGIN END $y$')).toThrow(/unterminated/i);
    expect(() => splitStatements('SELECT /* /* */ 1')).toThrow(/unterminated/i);
  });

  it('lower-cases unquoted words in the tokens and keeps quoted identifiers as written', () => {
    const [statement] = splitStatements('Drop Index Concurrently "Mixed";');
    expect(statement?.tokens).toEqual([
      { kind: 'word', value: 'drop' },
      { kind: 'word', value: 'index' },
      { kind: 'word', value: 'concurrently' },
      { kind: 'quoted', value: 'Mixed' },
    ]);
  });
});

describe('hasNoTransactionMarker', () => {
  it('accepts the exact first line, with or without CRLF, and a marker-only file', () => {
    expect(hasNoTransactionMarker(`${NO_TRANSACTION_MARKER}\nSELECT 1;`)).toBe(true);
    expect(hasNoTransactionMarker(`${NO_TRANSACTION_MARKER}\r\nSELECT 1;`)).toBe(true);
    expect(hasNoTransactionMarker(NO_TRANSACTION_MARKER)).toBe(true);
  });

  it.each([
    ['on a later line', `\n${NO_TRANSACTION_MARKER}\n`],
    ['indented', `  ${NO_TRANSACTION_MARKER}\n`],
    ['with trailing text', `${NO_TRANSACTION_MARKER}al\n`],
    ['with trailing space', `${NO_TRANSACTION_MARKER} \n`],
    ['upper case', `${NO_TRANSACTION_MARKER.toUpperCase()}\n`],
    ['without the space', '--kasuwa:no-transaction\n'],
    ['as a block comment', '/* kasuwa:no-transaction */\n'],
    ['after a byte-order mark', `${String.fromCharCode(0xfeff)}${NO_TRANSACTION_MARKER}\n`],
  ])('rejects the marker %s', (_name, sql) => {
    expect(hasNoTransactionMarker(sql)).toBe(false);
  });
});

function check(body: string): string[] {
  return checkNoTransactionFile(`${NO_TRANSACTION_MARKER}\n${body}`).violations;
}

describe('checkNoTransactionFile', () => {
  it.each([
    'CREATE INDEX CONCURRENTLY i ON t (a)',
    'create unique index concurrently if not exists i on s.t using btree (lower(a)) where a <> \'x\'',
    'CREATE INDEX CONCURRENTLY ON t (a)',
    'DROP INDEX CONCURRENTLY i',
    'DROP INDEX CONCURRENTLY IF EXISTS s.i',
    'DROP INDEX CONCURRENTLY "Odd Name" RESTRICT',
    'ALTER TABLE t VALIDATE CONSTRAINT c',
    'ALTER TABLE IF EXISTS ONLY s.t VALIDATE CONSTRAINT "c c"',
    'ALTER TABLE t * VALIDATE CONSTRAINT c',
  ])('allows %s', (statement) => {
    expect(check(`${statement};`)).toEqual([]);
  });

  it.each([
    ['a non-concurrent CREATE INDEX', 'CREATE INDEX i ON t (a)'],
    ['a non-concurrent DROP INDEX', 'DROP INDEX i'],
    ['DROP INDEX CONCURRENTLY of two indexes', 'DROP INDEX CONCURRENTLY a, b'],
    ['DROP INDEX CONCURRENTLY CASCADE', 'DROP INDEX CONCURRENTLY a CASCADE'],
    ['VALIDATE CONSTRAINT with another action', 'ALTER TABLE t VALIDATE CONSTRAINT c, DROP COLUMN x'],
    ['VALIDATE CONSTRAINT with trailing tokens', 'ALTER TABLE t VALIDATE CONSTRAINT c CASCADE'],
    ['ALTER TABLE ADD CONSTRAINT', 'ALTER TABLE t ADD CONSTRAINT c CHECK (a > 0) NOT VALID'],
    ['ALTER INDEX', 'ALTER INDEX i RENAME TO j'],
    ['BEGIN', 'BEGIN'],
    ['COMMIT', 'COMMIT'],
    ['START TRANSACTION', 'START TRANSACTION'],
    ['SET', 'SET search_path TO public'],
    ['SET LOCAL', 'SET LOCAL lock_timeout = 1000'],
    ['RESET', 'RESET ALL'],
    ['DO', 'DO $$ BEGIN END $$'],
    ['VACUUM', 'VACUUM t'],
    ['REINDEX', 'REINDEX TABLE CONCURRENTLY t'],
    ['CREATE TABLE', 'CREATE TABLE t (a int)'],
    ['UPDATE', "UPDATE t SET a = 'x'"],
    ['SELECT', 'SELECT pg_sleep(1)'],
    ['a parenthesised SELECT', '(SELECT 1)'],
  ])('refuses %s', (_name, statement) => {
    const violations = check(`CREATE INDEX CONCURRENTLY ok ON t (a);\n${statement};`);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/^statement 2 /);
  });

  it('refuses a forbidden statement sharing a line with an allowed one', () => {
    expect(check('CREATE INDEX CONCURRENTLY i ON t (a); DELETE FROM t;')).toEqual([
      expect.stringMatching(/^statement 2 .*DELETE FROM t/i),
    ]);
  });

  it('reports every violation, not just the first', () => {
    expect(check('SET a = 1; CREATE INDEX CONCURRENTLY i ON t (a); VACUUM;')).toHaveLength(2);
  });

  it('refuses a marked file with no statements', () => {
    expect(check('-- nothing here\n')).toEqual([expect.stringMatching(/no statements/)]);
  });

  it('does not echo string literals into the violation', () => {
    const [violation] = check("UPDATE t SET name = 'a secret value';");
    expect(violation).toBeDefined();
    expect(violation).not.toMatch(/secret/);
  });

  it('turns an unterminated string into a violation rather than a crash', () => {
    expect(check("CREATE INDEX CONCURRENTLY i ON t (a) WHERE b = 'open")).toEqual([
      expect.stringMatching(/unterminated/i),
    ]);
  });

  it('returns the statements to run, original text and all', () => {
    const result = checkNoTransactionFile(
      `${NO_TRANSACTION_MARKER}\n-- why\nCREATE INDEX CONCURRENTLY i ON t (a); -- note\nDROP INDEX CONCURRENTLY j;\n`,
    );
    expect(result.violations).toEqual([]);
    expect(result.statements).toEqual([
      'CREATE INDEX CONCURRENTLY i ON t (a)',
      'DROP INDEX CONCURRENTLY j',
    ]);
  });
});
