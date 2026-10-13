import { Inject, Injectable } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';

/**
 * The JSON body limit (T-0113, D-L96).
 *
 * Express's default JSON limit is 100 KB, and a body over it is a `413`
 * before any route runs. A script draft may be up to 256 KiB serialised
 * (D-L93, counted in UTF-8 bytes), and over that cap the contract answers
 * `400` with `details[].code: too_big`, never `413`. So the API parses JSON
 * up to 512 KiB, twice the cap: a draft at the cap parses, a body somewhat
 * over it reaches the scripting schemas and is refused there with the
 * contract's answer, and nothing much larger is ever buffered. A body over
 * 512 KiB is still body-parser's `413`.
 *
 * WHY HERE, AND HOW. The limit has to hold wherever `AppModule` is booted,
 * `main.ts` and the acceptance harness's `createApi` alike, so it cannot be
 * a `NestFactory` option. Nest registers its own JSON parser at `init()`,
 * unless a middleware named `jsonParser` is already on the router
 * (`ExpressAdapter.registerParserMiddleware`). `HttpAdapterHost.init$` fires
 * when the adapter is attached, which is before `init()` on both paths
 * (`NestFactory.create` and `TestingModule.createNestApplication`), so this
 * provider installs body-parser's own parser, with the higher limit, first,
 * through the adapter's `useBodyParser`, and Nest then skips its default.
 * Every other parser option is Nest's default. Only Express is configured;
 * another adapter keeps its own default. URL-encoded bodies: see below.
 */
export const JSON_BODY_LIMIT_BYTES = 512 * 1024;

/** Whether the Express app's router already holds a middleware named `name`. */
export function hasMiddleware(app: unknown, name: string): boolean {
  const router: unknown = (app as { router?: unknown } | null)?.router;
  const stack: unknown = (router as { stack?: unknown } | undefined)?.stack;
  if (!Array.isArray(stack)) return false;
  return stack.some(
    (layer: unknown) =>
      typeof layer === 'object' &&
      layer !== null &&
      typeof (layer as { handle?: unknown }).handle === 'function' &&
      ((layer as { handle: { name?: unknown } }).handle.name ?? '') === name,
  );
}

/**
 * URL-ENCODED BODIES ARE NOT PARSED (T-0113 security review). Every route in
 * the API takes JSON (auth included: the web app posts JSON from script, and
 * no route is an HTML form or a provider's form_post callback), so Nest's
 * default `urlencoded` parser is only attack surface: a second body format
 * nothing validates against. Nest adds it unless a middleware named
 * `urlencodedParser` is already on the router, so this installs one that
 * parses nothing and passes the request on. A form body then reaches a
 * handler as no body at all, which every write answers `400`.
 */
function urlencodedParser(_request: unknown, _response: unknown, next: () => void): void {
  next();
}

/**
 * A BODY THAT IS NOT JSON IS THE ENVELOPE'S 400 (T-0108, R15). Body-parser
 * refuses malformed JSON, and in strict mode a top-level value that is not an
 * object or an array (`"x"`, `null`, `42`), with a `SyntaxError` whose
 * message quotes the start of the body. Left to Nest, that became a
 * `BadRequestException(err.message)`: a body with no `code` (outside the
 * shared `Error` schema) that echoes what the client sent. This error
 * middleware, installed right after the JSON parser and so before any route
 * or Nest's own handler, answers every body-parser parse failure with the
 * one fixed `validation_failed` body (`details[].code: invalid_json` at the
 * root), `no-store`, and nothing from the request. Any other error (a 413,
 * a route's own) is passed on untouched.
 */
export const INVALID_JSON_BODY = Object.freeze({
  statusCode: 400,
  error: 'Bad Request',
  code: 'validation_failed',
  message: 'Validation failed',
  details: [{ path: '', code: 'invalid_json' }],
});

interface MinimalResponse {
  status(code: number): MinimalResponse;
  setHeader(name: string, value: string): unknown;
  json(body: unknown): unknown;
}

export function jsonParseErrorHandler(
  error: unknown,
  _request: unknown,
  response: MinimalResponse,
  next: (error?: unknown) => void,
): void {
  const type: unknown = (error as { type?: unknown } | null)?.type;
  if (type !== 'entity.parse.failed') {
    next(error);
    return;
  }
  response.setHeader('Cache-Control', 'no-store');
  response.status(400).json(INVALID_JSON_BODY);
}

@Injectable()
export class JsonBodyLimit {
  constructor(@Inject(HttpAdapterHost) host: HttpAdapterHost) {
    host.init$.subscribe(() => {
      const adapter: unknown = host.httpAdapter;
      if (!(adapter instanceof ExpressAdapter)) return;
      // Once per app: a second AppModule on the same adapter adds nothing.
      if (!hasMiddleware(adapter.getInstance(), 'jsonParser')) {
        adapter.useBodyParser('json', false, { limit: JSON_BODY_LIMIT_BYTES });
      }
      if (!hasMiddleware(adapter.getInstance(), 'jsonParseErrorHandler')) {
        adapter.use(jsonParseErrorHandler);
      }
      if (!hasMiddleware(adapter.getInstance(), 'urlencodedParser')) {
        adapter.use(urlencodedParser);
      }
    });
  }
}
