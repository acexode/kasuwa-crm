import type { ArgumentsHost } from '@nestjs/common';
import { ConflictException, HttpException, Logger, NotFoundException } from '@nestjs/common';
import { InvalidCursorError } from '@kasuwa/domain-core';
import { inspect } from 'node:util';
import { DatabaseError } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  INTERNAL_ERROR_BODY,
  UnexpectedErrorFilter,
  CLIENT_ERROR_MESSAGE,
  routeTemplate,
} from './unexpected-error.filter';

/** Invented probe values (CLAUDE.md 6): none can occur in a log by chance. */
const EMAIL = 'ngozi.okafor.unit-probe@example.test';

/** A real pg DatabaseError, as the driver builds it: `name` is `'error'`. */
function uniqueViolation(): DatabaseError {
  return Object.assign(
    new DatabaseError(
      'duplicate key value violates unique constraint "portal_user_email_key"',
      0,
      'error',
    ),
    { code: '23505', detail: `Key (programme_id, email)=(x, ${EMAIL}) already exists.` },
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

  it('does not echo an http-errors message unless the error marks it exposed', () => {
    recordLogs();
    for (const expose of [false, undefined, 'true']) {
      const leaky = Object.assign(new Error(`unsupported charset "${EMAIL}"`), {
        statusCode: 415,
        ...(expose === undefined ? {} : { expose }),
      });
      const { host, sent } = httpHost({ method: 'POST' });
      filter.catch(leaky, host);
      expect(sent).toEqual({
        status: 415,
        body: { statusCode: 415, message: CLIENT_ERROR_MESSAGE },
      });
    }
  });

  it('falls back to a bare 500 when writing the body throws, and logs nothing about it', () => {
    const lines = recordLogs();
    const sent: Sent = {};
    const response = {
      headersSent: false,
      statusCode: 0,
      status(code: number) {
        sent.status = code;
        return response;
      },
      json(): never {
        throw new Error(`cannot serialise ${EMAIL}`);
      },
      end() {
        sent.ended = true;
      },
    };
    const host = {
      getType: () => 'http',
      switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({}) }),
    } as unknown as ArgumentsHost;

    expect(() => filter.catch(new Error('boom'), host)).not.toThrow();
    expect(sent).toEqual({ status: 500, ended: true });
    expect(lines).toEqual(['unexpected error class=Error method=_OTHER route=(unmatched)']);
  });

  it('logs a thrown plain object as UnknownError, never by the name it carries', () => {
    const lines = recordLogs();
    const { host, sent } = httpHost({ method: 'GET' });
    filter.catch({ name: 'Chidinma', code: '12345' }, host);
    expect(sent.body).toEqual(INTERNAL_ERROR_BODY);
    expect(lines).toEqual(['unexpected error class=UnknownError method=GET route=(unmatched)']);
  });
});
