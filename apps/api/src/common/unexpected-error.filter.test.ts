import type { ArgumentsHost } from '@nestjs/common';
import { ConflictException, HttpException, Logger, NotFoundException } from '@nestjs/common';
import { InvalidCursorError } from '@kasuwa/domain-core';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  INTERNAL_ERROR_BODY,
  UnexpectedErrorFilter,
  routeTemplate,
  scrubError,
} from './unexpected-error.filter';

/** Invented probe values (CLAUDE.md 6): none can occur in a log by chance. */
const EMAIL = 'ngozi.okafor.unit-probe@example.test';
const NIN = '00000000099';

/** Shaped like pg's DatabaseError: `name` is the protocol message type. */
class DatabaseError extends Error {
  override name = 'error';
  constructor(
    message: string,
    readonly code: string,
    readonly detail: string,
  ) {
    super(message);
  }
}

function uniqueViolation(): DatabaseError {
  return new DatabaseError(
    'duplicate key value violates unique constraint "portal_user_email_key"',
    '23505',
    `Key (programme_id, email)=(x, ${EMAIL}) already exists.`,
  );
}

interface Sent {
  status?: number;
  body?: unknown;
  ended?: boolean;
}

function httpHost(
  request: Record<string, unknown> = {},
  headersSent = false,
): { host: ArgumentsHost; sent: Sent } {
  const sent: Sent = {};
  const response = {
    headersSent,
    status(code: number) {
      sent.status = code;
      return response;
    },
    json(body: unknown) {
      sent.body = body;
      return response;
    },
    end() {
      sent.ended = true;
    },
  };
  const host = {
    getType: () => 'http',
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
  } as unknown as ArgumentsHost;
  return { host, sent };
}

function recordLogs(): string[] {
  const lines: string[] = [];
  const record = (...args: unknown[]): void => {
    lines.push(args.map((arg) => (typeof arg === 'string' ? arg : inspect(arg))).join(' '));
  };
  for (const method of ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const) {
    vi.spyOn(Logger.prototype, method).mockImplementation(record);
  }
  return lines;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('scrubError', () => {
  it('names a pg error by its class and SQLSTATE, not by pg’s `name` of "error"', () => {
    expect(scrubError(uniqueViolation())).toEqual({ errorClass: 'DatabaseError', code: '23505' });
  });

  it('keeps a Node system code and drops a code that could be data', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(scrubError(refused).code).toBe('ECONNREFUSED');
    expect(scrubError(Object.assign(new Error('x'), { code: NIN })).code).toBeNull();
    expect(scrubError(Object.assign(new Error('x'), { code: EMAIL })).code).toBeNull();
  });

  it('never takes a class name that is not an identifier', () => {
    const odd = Object.assign(Object.create(null) as object, { name: EMAIL });
    expect(scrubError(odd).errorClass).toBe('UnknownError');
    expect(scrubError({ name: EMAIL }).errorClass).toBe('UnknownError');
    expect(scrubError('a string thrown').errorClass).toBe('UnknownError');
    expect(scrubError(null)).toEqual({ errorClass: 'UnknownError', code: null });
  });

  it('survives a throwing getter', () => {
    const hostile = {
      get code(): string {
        throw new Error(EMAIL);
      },
    };
    expect(scrubError(hostile)).toEqual({ errorClass: 'UnknownError', code: null });
  });
});

describe('routeTemplate', () => {
  it('reads the matched template, never the URL', () => {
    expect(
      routeTemplate({ route: { path: '/api/v1/x/:id' }, originalUrl: `/api/v1/x/${EMAIL}` }),
    ).toBe('/api/v1/x/:id');
    expect(routeTemplate({ originalUrl: `/nowhere/${EMAIL}` })).toBe('(unmatched)');
  });
});

describe('UnexpectedErrorFilter', () => {
  const filter = new UnexpectedErrorFilter();

  it('answers an unexpected error with the fixed 500 body and logs one scrubbed line', () => {
    const lines = recordLogs();
    const { host, sent } = httpHost({
      method: 'post',
      route: { path: '/api/v1/admin/portal-users' },
      originalUrl: `/api/v1/admin/portal-users?email=${EMAIL}`,
      body: { email: EMAIL },
    });

    filter.catch(uniqueViolation(), host);

    expect(sent.status).toBe(500);
    expect(sent.body).toEqual(INTERNAL_ERROR_BODY);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      'unexpected error class=DatabaseError code=23505 method=POST route=/api/v1/admin/portal-users',
    );
    expect(lines.join('\n')).not.toContain(EMAIL);
    expect(lines.join('\n')).not.toContain('duplicate key');
  });

  it('gives every unexpected error the identical body', () => {
    recordLogs();
    const a = httpHost();
    const b = httpHost();
    filter.catch(uniqueViolation(), a.host);
    filter.catch(new TypeError(`cannot read ${EMAIL}`), b.host);
    expect(a.sent.body).toEqual(b.sent.body);
    expect(JSON.stringify(b.sent.body)).not.toContain('TypeError');
  });

  it('leaves HttpException bodies exactly as Nest’s base filter answers them, unlogged', () => {
    const lines = recordLogs();
    const object = httpHost();
    filter.catch(new ConflictException({ code: 'duplicate_name', message: 'taken' }), object.host);
    expect(object.sent).toEqual({
      status: 409,
      body: { code: 'duplicate_name', message: 'taken' },
    });

    const plain = httpHost();
    filter.catch(new HttpException('Gone fishing', 410), plain.host);
    expect(plain.sent).toEqual({ status: 410, body: { statusCode: 410, message: 'Gone fishing' } });

    const notFound = httpHost();
    filter.catch(new NotFoundException(), notFound.host);
    expect(notFound.sent.body).toEqual(new NotFoundException().getResponse());
    expect(lines).toEqual([]);
  });

  it('delegates Zod and cursor failures to the validation filter’s body', () => {
    const parsed = z.object({ email: z.string().max(3) }).safeParse({ email: EMAIL });
    if (parsed.success) throw new Error('expected a parse failure');
    const zod = httpHost();
    filter.catch(parsed.error, zod.host);
    expect(zod.sent.status).toBe(400);
    expect(zod.sent.body).toMatchObject({ code: 'validation_failed' });
    expect(JSON.stringify(zod.sent.body)).not.toContain(EMAIL);

    const cursor = httpHost();
    filter.catch(new InvalidCursorError(), cursor.host);
    expect(cursor.sent.body).toMatchObject({ code: 'invalid_cursor' });
  });

  it('keeps an http-errors 4xx status and body, and still logs only the scrubbed line', () => {
    const lines = recordLogs();
    const tooLarge = Object.assign(new Error('request entity too large'), {
      statusCode: 413,
      expose: true,
    });
    const { host, sent } = httpHost({ method: 'POST' });
    filter.catch(tooLarge, host);
    expect(sent).toEqual({
      status: 413,
      body: { statusCode: 413, message: 'request entity too large' },
    });
    expect(lines).toEqual(['unexpected error class=Error method=POST route=(unmatched)']);
  });

  it('ends a response whose headers are already sent instead of writing twice', () => {
    recordLogs();
    const { host, sent } = httpHost({}, true);
    filter.catch(new Error(EMAIL), host);
    expect(sent).toEqual({ ended: true });
  });
});
