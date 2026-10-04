/**
 * SQL handling for the migration runner's non-transactional mode (T-0044, D-L65).
 *
 * A migration whose FIRST line is exactly `-- kasuwa:no-transaction` runs
 * without the runner's wrapping transaction, so that it can build or drop an
 * index CONCURRENTLY. The mode is deliberately narrow:
 *
 *   - Postgres runs a multi-statement simple query as ONE implicit transaction,
 *     so the file has to be split and sent a statement at a time. Hence the
 *     splitter below, which understands strings, E-strings, quoted
 *     identifiers, dollar quotes and (nested) comments.
 *   - Without a transaction, a partly applied file stays partly applied, and
 *     session state persists for the rest of the run. So a marked file may
 *     contain ONLY these statements, each matched as a whole statement:
 *
 *       CREATE [UNIQUE] INDEX CONCURRENTLY ...
 *       DROP INDEX CONCURRENTLY [IF EXISTS] name [RESTRICT]
 *       ALTER TABLE [IF EXISTS] [ONLY] name [*] VALIDATE CONSTRAINT name
 *
 *     Everything else — BEGIN/COMMIT, SET, DO, VACUUM, REINDEX, a plain CREATE
 *     INDEX, a VALIDATE CONSTRAINT with a second action riding along — is
 *     refused, and the whole file is checked before any of it runs.
 *
 * Nothing here talks to a database; migrate.ts does that.
 */

export const NO_TRANSACTION_MARKER = '-- kasuwa:no-transaction';

/** True only when the first line is exactly the marker (a trailing CR is tolerated). */
export function hasNoTransactionMarker(sql: string): boolean {
  const newline = sql.indexOf('\n');
  const firstLine = newline === -1 ? sql : sql.slice(0, newline);
  return firstLine.replace(/\r$/, '') === NO_TRANSACTION_MARKER;
}

export type Token =
  | { kind: 'word'; value: string } // unquoted identifier or keyword, lower-cased
  | { kind: 'quoted'; value: string } // "quoted identifier", as written
  | { kind: 'string' } // any string or dollar-quoted literal; contents deliberately dropped
  | { kind: 'number'; value: string }
  | { kind: 'param'; value: string }
  | { kind: 'punct'; value: string };

export interface Statement {
  /** The statement as written, from its first token to just before its `;`. */
  text: string;
  /** Its tokens, comments and whitespace removed. */
  tokens: Token[];
}

export class SqlSplitError extends Error {
  override name = 'SqlSplitError';
}

const IDENT_START = /[A-Za-z_\u0080-￿]/;
const IDENT_PART = /[A-Za-z0-9_$\u0080-￿]/;
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;

/**
 * Split a SQL script into statements on top-level semicolons.
 *
 * Follows the Postgres lexer closely enough for migrations: a `;` inside a
 * string, quoted identifier, dollar quote or comment does not end a statement.
 * Standard strings treat backslash as an ordinary character
 * (standard_conforming_strings, the default); E'...' strings honour backslash
 * escapes. Anything unterminated is an error rather than a guess.
 */
export function splitStatements(sql: string): Statement[] {
  const statements: Statement[] = [];
  const n = sql.length;
  let i = 0;
  let start = -1;
  let lastEnd = -1;
  let tokens: Token[] = [];

  const finish = (): void => {
    if (start !== -1) {
      statements.push({ text: sql.slice(start, lastEnd), tokens });
    }
    start = -1;
    lastEnd = -1;
    tokens = [];
  };

  const begin = (at: number): void => {
    if (start === -1) {
      start = at;
    }
  };

  while (i < n) {
    const c = sql.charAt(i);
    const next = sql.charAt(i + 1);

    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? n : end;
      continue;
    }

    if (c === '/' && next === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql.startsWith('/*', j)) {
          depth += 1;
          j += 2;
        } else if (sql.startsWith('*/', j)) {
          depth -= 1;
          j += 2;
        } else {
          j += 1;
        }
      }
      if (depth > 0) {
        throw new SqlSplitError('unterminated block comment');
      }
      i = j;
      continue;
    }

    if (/\s/.test(c)) {
      i += 1;
      continue;
    }

    if (c === ';') {
      finish();
      i += 1;
      continue;
    }

    begin(i);

    if (c === "'") {
      const previous = tokens[tokens.length - 1];
      const escapes =
        previous?.kind === 'word' && previous.value === 'e' && lastEnd === i;
      if (escapes) {
        // `E'...'`: the E and the string are one literal.
        tokens.pop();
      }
      i = endOfQuoted(sql, i, "'", escapes, 'string literal');
      tokens.push({ kind: 'string' });
    } else if (c === '"') {
      const end = endOfQuoted(sql, i, '"', false, 'quoted identifier');
      tokens.push({ kind: 'quoted', value: sql.slice(i + 1, end - 1).replace(/""/g, '"') });
      i = end;
    } else if (c === '$' && DOLLAR_TAG.test(sql.slice(i, i + 256))) {
      const tag = DOLLAR_TAG.exec(sql.slice(i, i + 256))?.[0] ?? '$$';
      const close = sql.indexOf(tag, i + tag.length);
      if (close === -1) {
        throw new SqlSplitError(`unterminated dollar-quoted literal ${tag}`);
      }
      tokens.push({ kind: 'string' });
      i = close + tag.length;
    } else if (c === '$') {
      let j = i + 1;
      while (j < n && /[0-9]/.test(sql.charAt(j))) {
        j += 1;
      }
      tokens.push({ kind: 'param', value: sql.slice(i, j) });
      i = j;
    } else if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < n && IDENT_PART.test(sql.charAt(j))) {
        j += 1;
      }
      tokens.push({ kind: 'word', value: sql.slice(i, j).toLowerCase() });
      i = j;
    } else if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(sql.charAt(j))) {
        j += 1;
      }
      tokens.push({ kind: 'number', value: sql.slice(i, j) });
      i = j;
    } else {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
    }
    lastEnd = i;
  }

  finish();
  return statements;
}

/** Index just past the closing quote of a quoted run starting at `open`. */
function endOfQuoted(
  sql: string,
  open: number,
  quote: string,
  backslashEscapes: boolean,
  what: string,
): number {
  let j = open + 1;
  while (j < sql.length) {
    const c = sql.charAt(j);
    if (backslashEscapes && c === '\\') {
      j += 2;
      continue;
    }
    if (c === quote) {
      if (sql.charAt(j + 1) === quote) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j += 1;
  }
  throw new SqlSplitError(`unterminated ${what}`);
}

// ---------------------------------------------------------------------------
// The allowlist.
// ---------------------------------------------------------------------------

class Cursor {
  private position = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  /** Consume the given lower-case keywords in order, or consume nothing. */
  words(...values: string[]): boolean {
    for (const [offset, value] of values.entries()) {
      const token = this.tokens[this.position + offset];
      if (token?.kind !== 'word' || token.value !== value) {
        return false;
      }
    }
    this.position += values.length;
    return true;
  }

  punct(value: string): boolean {
    const token = this.tokens[this.position];
    if (token?.kind === 'punct' && token.value === value) {
      this.position += 1;
      return true;
    }
    return false;
  }

  identifier(): boolean {
    const token = this.tokens[this.position];
    if (token?.kind === 'word' || token?.kind === 'quoted') {
      this.position += 1;
      return true;
    }
    return false;
  }

  /** identifier [. identifier [. identifier]] */
  qualifiedName(): boolean {
    if (!this.identifier()) {
      return false;
    }
    for (let parts = 1; parts < 3 && this.punct('.'); parts += 1) {
      if (!this.identifier()) {
        return false;
      }
    }
    return true;
  }

  atEnd(): boolean {
    return this.position === this.tokens.length;
  }
}

/** CREATE [UNIQUE] INDEX CONCURRENTLY <definition> */
function isCreateIndexConcurrently(tokens: readonly Token[]): boolean {
  const cursor = new Cursor(tokens);
  if (!cursor.words('create')) {
    return false;
  }
  cursor.words('unique');
  // The rest is the index definition. There are no sub-commands to smuggle in,
  // and the splitter guarantees this is one statement.
  return cursor.words('index', 'concurrently') && !cursor.atEnd();
}

/** DROP INDEX CONCURRENTLY [IF EXISTS] name [RESTRICT] — Postgres allows one name and no CASCADE here. */
function isDropIndexConcurrently(tokens: readonly Token[]): boolean {
  const cursor = new Cursor(tokens);
  if (!cursor.words('drop', 'index', 'concurrently')) {
    return false;
  }
  cursor.words('if', 'exists');
  if (!cursor.qualifiedName()) {
    return false;
  }
  cursor.words('restrict');
  return cursor.atEnd();
}

/** ALTER TABLE [IF EXISTS] [ONLY] name [*] VALIDATE CONSTRAINT name, and nothing else. */
function isValidateConstraint(tokens: readonly Token[]): boolean {
  const cursor = new Cursor(tokens);
  if (!cursor.words('alter', 'table')) {
    return false;
  }
  cursor.words('if', 'exists');
  cursor.words('only');
  if (!cursor.qualifiedName()) {
    return false;
  }
  cursor.punct('*');
  return cursor.words('validate', 'constraint') && cursor.identifier() && cursor.atEnd();
}

export function isAllowedWithoutTransaction(statement: Statement): boolean {
  return (
    isCreateIndexConcurrently(statement.tokens) ||
    isDropIndexConcurrently(statement.tokens) ||
    isValidateConstraint(statement.tokens)
  );
}

/** The first few tokens of a statement, for an error message. Never echoes a literal. */
function describeStart(tokens: readonly Token[]): string {
  const shown: string[] = [];
  for (const token of tokens.slice(0, 4)) {
    if (token.kind === 'string' || token.kind === 'number' || token.kind === 'param') {
      break;
    }
    shown.push(token.kind === 'quoted' ? `"${token.value}"` : token.value.toUpperCase());
  }
  return shown.join(' ');
}

export interface NoTransactionCheck {
  /** The statements to send, one per query, in order. Empty if there are violations. */
  statements: string[];
  /** Human-readable reasons the file is refused. Empty when it may run. */
  violations: string[];
}

/**
 * Check a marked migration in full, before any of it runs. Every statement
 * must be on the allowlist; a file that cannot be split, or that contains no
 * statements at all, is refused too.
 */
export function checkNoTransactionFile(sql: string): NoTransactionCheck {
  let statements: Statement[];
  try {
    statements = splitStatements(sql);
  } catch (error) {
    if (error instanceof SqlSplitError) {
      return { statements: [], violations: [`the file cannot be split: ${error.message}`] };
    }
    throw error;
  }

  if (statements.length === 0) {
    return { statements: [], violations: ['the file contains no statements'] };
  }

  const violations = statements.flatMap((statement, index) =>
    isAllowedWithoutTransaction(statement)
      ? []
      : [`statement ${index + 1} (${describeStart(statement.tokens)} ...) is not allowed`],
  );

  return {
    statements: violations.length === 0 ? statements.map((statement) => statement.text) : [],
    violations,
  };
}
