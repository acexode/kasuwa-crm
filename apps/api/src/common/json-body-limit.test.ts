import type { HttpAdapterHost } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import {
  bodyParserErrorHandler,
  hasMiddleware,
  noStoreEverywhere,
  safePathEncoding,
  INVALID_JSON_BODY,
  JsonBodyLimit,
  jsonParseErrorHandler,
} from './json-body-limit';

function hostFor(adapter: unknown): HttpAdapterHost {
  return { init$: of(undefined), httpAdapter: adapter } as unknown as HttpAdapterHost;
}

function jsonParsers(adapter: ExpressAdapter): number {
  const app = adapter.getInstance() as { router: { stack: { handle: { name: string } }[] } };
  return app.router.stack.filter((layer) => layer.handle.name === 'jsonParser').length;
}

describe('JsonBodyLimit (T-0113)', () => {
  it('installs one JSON parser before Nest would, so Nest skips its 100 KB default', () => {
    const adapter = new ExpressAdapter();
    expect(hasMiddleware(adapter.getInstance(), 'jsonParser')).toBe(false);
    new JsonBodyLimit(hostFor(adapter));
    expect(hasMiddleware(adapter.getInstance(), 'jsonParser')).toBe(true);
    // A second module on the same adapter adds nothing.
    new JsonBodyLimit(hostFor(adapter));
    expect(jsonParsers(adapter)).toBe(1);
  });

  it('installs a urlencoded stand-in that parses nothing, so Nest adds no form parser', () => {
    const adapter = new ExpressAdapter();
    new JsonBodyLimit(hostFor(adapter));
    expect(hasMiddleware(adapter.getInstance(), 'urlencodedParser')).toBe(true);
    const app = adapter.getInstance() as {
      router: { stack: { handle: { name: string } & ((...args: unknown[]) => void) }[] };
    };
    const layer = app.router.stack.find((entry) => entry.handle.name === 'urlencodedParser');
    const request: { body?: unknown } = {};
    let called = false;
    layer?.handle(request, {}, () => {
      called = true;
    });
    expect(called).toBe(true);
    expect(request.body).toBeUndefined();
  });

  it('leaves an adapter that is not Express alone', () => {
    expect(() => new JsonBodyLimit(hostFor(undefined))).not.toThrow();
    expect(() => new JsonBodyLimit(hostFor({ getType: () => 'fastify' }))).not.toThrow();
  });

  it('reads nothing but a router stack', () => {
    expect(hasMiddleware(null, 'jsonParser')).toBe(false);
    expect(hasMiddleware({ router: { stack: [{ handle: 'x' }] } }, 'jsonParser')).toBe(false);
  });
});

describe('a body that is not JSON (T-0108, R15)', () => {
  function recorder() {
    const seen: { status?: number; body?: unknown; headers: Record<string, string> } = {
      headers: {},
    };
    const response = {
      status(code: number) {
        seen.status = code;
        return response;
      },
      setHeader(name: string, value: string) {
        seen.headers[name] = value;
      },
      json(body: unknown) {
        seen.body = body;
      },
    };
    return { seen, response };
  }

  it('is installed once, right after the JSON parser', () => {
    const adapter = new ExpressAdapter();
    new JsonBodyLimit(hostFor(adapter));
    new JsonBodyLimit(hostFor(adapter));
    const app = adapter.getInstance() as { router: { stack: { handle: { name: string } }[] } };
    const names = app.router.stack.map((layer) => layer.handle.name);
    expect(names.filter((name) => name === 'jsonParseErrorHandler')).toHaveLength(1);
    expect(names.indexOf('jsonParseErrorHandler')).toBe(names.indexOf('jsonParser') + 1);
  });

  it('answers a parse failure with the fixed validation_failed body, no-store, echoing nothing', () => {
    const { seen, response } = recorder();
    const error = Object.assign(new SyntaxError('Unexpected token "T-0108 secret"'), {
      type: 'entity.parse.failed',
      body: '"T-0108 secret"',
    });
    let passed = false;
    jsonParseErrorHandler(error, {}, response, () => {
      passed = true;
    });
    expect(passed).toBe(false);
    expect(seen.status).toBe(400);
    expect(seen.body).toEqual(INVALID_JSON_BODY);
    expect(seen.headers['Cache-Control']).toBe('no-store');
    expect(JSON.stringify(seen.body)).not.toContain('secret');
  });

  it('passes every other error on untouched', () => {
    const { seen, response } = recorder();
    const tooLarge = Object.assign(new Error('too large'), { type: 'entity.too.large' });
    let forwarded: unknown;
    jsonParseErrorHandler(tooLarge, {}, response, (error) => {
      forwarded = error;
    });
    expect(forwarded).toBe(tooLarge);
    expect(seen.status).toBeUndefined();
  });
});

describe('body-parser failures are the envelope (T-0121)', () => {
  function run(error: unknown): { status?: number; body?: unknown; headers: string[]; passed: boolean } {
    const out: { status?: number; body?: unknown; headers: string[]; passed: boolean } = {
      headers: [],
      passed: false,
    };
    const response = {
      status(code: number) {
        out.status = code;
        return response;
      },
      setHeader(name: string, value: string) {
        out.headers.push(`${name}: ${value}`);
      },
      json(body: unknown) {
        out.body = body;
      },
    };
    bodyParserErrorHandler(error, {}, response, () => {
      out.passed = true;
    });
    return out;
  }

  it.each([
    [413, 'entity.too.large', 'Payload Too Large'],
    [415, 'charset.unsupported', 'Unsupported Media Type'],
    [415, 'encoding.unsupported', 'Unsupported Media Type'],
    [400, 'encoding.failed', 'Bad Request'],
  ])('%s %s is validation_failed, no-store, and quotes nothing', (statusCode, type, reason) => {
    const out = run({ statusCode, type, message: 'unsupported charset "SECRET"' });
    expect(out.status).toBe(statusCode);
    expect(out.headers).toEqual(['Cache-Control: no-store']);
    expect(out.body).toEqual({
      statusCode,
      error: reason,
      code: 'validation_failed',
      message: 'The request body could not be read.',
    });
  });

  it('passes on an error that is not a body-parser 4xx', () => {
    expect(run(new Error('x')).passed).toBe(true);
    expect(run({ statusCode: 500, type: 'x' }).passed).toBe(true);
    expect(run({ message: 'no status' }).passed).toBe(true);
  });

  it('sets no-store and passes on', () => {
    const headers: string[] = [];
    let passed = false;
    noStoreEverywhere({}, { setHeader: (n: string, v: string) => headers.push(`${n}: ${v}`) } as never, () => {
      passed = true;
    });
    expect(headers).toEqual(['Cache-Control: no-store']);
    expect(passed).toBe(true);
  });
});

describe('a stray % in a path is re-encoded before routing (T-0121)', () => {
  const fix = (url: string): string => {
    const request = { url };
    safePathEncoding(request, {}, () => undefined);
    return request.url;
  };

  it('leaves a path that decodes, and its query, alone', () => {
    expect(fix('/api/v1/contacts/a%20b?q=%E0%A4%A')).toBe('/api/v1/contacts/a%20b?q=%E0%A4%A');
    expect(fix('/api/v1/contacts/zzz')).toBe('/api/v1/contacts/zzz');
  });

  it.each(['%E0%A4%A', '%', '%ZZ', '%C0%AF'])('re-encodes the segment %s only', (value) => {
    const fixed = fix(`/api/v1/ok%20/${value}/x?a=1`);
    expect(fixed).toBe(`/api/v1/ok%20/${value.replace(/%/gu, '%25')}/x?a=1`);
    expect(() => decodeURIComponent(fixed.split('?')[0] ?? '')).not.toThrow();
  });
});
