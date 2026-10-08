import type { HttpAdapterHost } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { hasMiddleware, JsonBodyLimit } from './json-body-limit';

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
