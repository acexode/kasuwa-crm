import type { HttpAdapterHost } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import {
  hasMiddleware,
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
