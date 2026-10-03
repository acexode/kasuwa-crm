import { Inject, Injectable, type NestMiddleware, type Type } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context,
  trace,
  type Span,
} from '@opentelemetry/api';
import { SeverityNumber, logs } from '@opentelemetry/api-logs';
import type { NextFunction, Request, Response } from 'express';
import {
  allowListed,
  normaliseMethod,
  routeVocabulary,
  templatePath,
  type RequestAttributes,
} from './attributes';

export const TELEMETRY_OPTIONS = Symbol('TELEMETRY_OPTIONS');

export interface TelemetryOptions {
  /** The `cell` attribute on every span (`@kasuwa/config` KASUWA_CELL). */
  cell: string;
  /** Static path segments of every declared route; see `templatePath`. */
  vocabulary: ReadonlySet<string>;
}

const INSTRUMENTATION = '@kasuwa/api';

/**
 * The inbound request span of each request, keyed by the request object so
 * the tenancy interceptor can annotate it without threading anything through.
 * A WeakMap rather than a request property: nothing else can read or replace it.
 */
const requestSpans = new WeakMap<object, RequestRecord>();

/** The span, and the attributes written to it — kept, so the log can repeat them. */
interface RequestRecord {
  span: Span;
  attributes: RequestAttributes;
}

function record(entry: RequestRecord, attributes: Record<string, unknown>): void {
  const allowed = allowListed(attributes);
  entry.span.setAttributes(allowed);
  Object.assign(entry.attributes, allowed);
}

/**
 * One SERVER span and one log record per inbound request.
 *
 * Two properties the acceptance suite holds this to:
 *
 *   - The trace id is minted HERE, always. Incoming `traceparent`,
 *     `x-request-id` and the like are not extracted: a client-chosen id would
 *     let a caller merge its spans into someone else's trace or poison a
 *     trace store with a chosen value. The span starts as a root, full stop.
 *   - Every attribute goes through `allowListed`, and every value is built from
 *     what the server decided (see ./attributes.ts). Nothing is read from the
 *     query string, a header or the body.
 *
 * The tracer and logger are looked up per request rather than cached, so a
 * provider swapped in later (the test harness does exactly that) is honoured.
 */
@Injectable()
export class RequestTelemetryMiddleware implements NestMiddleware {
  constructor(@Inject(TELEMETRY_OPTIONS) private readonly options: TelemetryOptions) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const method = normaliseMethod(request.method);
    const span = trace
      .getTracer(INSTRUMENTATION)
      .startSpan(method, { kind: SpanKind.SERVER, root: true }, ROOT_CONTEXT);
    const entry: RequestRecord = { span, attributes: {} };
    record(entry, { 'http.request.method': method, cell: this.options.cell });
    requestSpans.set(request, entry);

    let ended = false;
    const end = (): void => {
      if (ended) return;
      ended = true;
      this.finish(request, response, entry, method);
    };
    response.once('finish', end);
    response.once('close', end);

    context.with(trace.setSpan(ROOT_CONTEXT, span), next);
  }

  private finish(request: Request, response: Response, entry: RequestRecord, method: string): void {
    const { span } = entry;
    const status = response.statusCode;
    const route = matchedRoute(request);
    record(entry, {
      'http.response.status_code': status,
      ...(route === null
        ? // `originalUrl`, not `path`: Nest's middleware mount may have
          // stripped a prefix from `path`. The query string is cut off before
          // anything else looks at it.
          { 'url.template': templatePath(request.originalUrl, this.options.vocabulary) }
        : { 'http.route': route }),
      // Semantic conventions: a server span is an error on 5xx only. A 4xx is
      // the caller's mistake and is still diagnosable from the status code.
      ...(status >= 500 ? { 'error.type': String(status) } : {}),
    });

    span.updateName(route === null ? method : `${method} ${route}`);
    if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });

    // A fixed message plus the span's own allow-listed attributes. The record
    // is correlated to the trace through `context`, not by copying ids around.
    logs.getLogger(INSTRUMENTATION).emit({
      severityNumber: status >= 500 ? SeverityNumber.ERROR : SeverityNumber.INFO,
      severityText: status >= 500 ? 'ERROR' : 'INFO',
      body: 'http request completed',
      attributes: { ...entry.attributes },
      context: trace.setSpan(ROOT_CONTEXT, span),
    });

    span.end();
    requestSpans.delete(request);
  }
}

/**
 * Records the scope the DATABASE resolved for this request. Called from inside
 * `withTenantTransaction`, never from the guard: until the session has been
 * resolved, the tenant id on a request is only what the caller claimed.
 */
export function annotateRequestScope(
  request: object,
  session: { tenantId: string; programmeIds: readonly string[] },
): void {
  const entry = requestSpans.get(request);
  if (entry === undefined) return;
  record(entry, { tenant_id: session.tenantId, programme_id: [...session.programmeIds] });
}

/** The route TEMPLATE Express matched (`/api/v1/contacts/:id`), or null. */
function matchedRoute(request: Request): string | null {
  const route: unknown = (request as { route?: unknown }).route;
  if (typeof route !== 'object' || route === null) return null;
  const path: unknown = (route as { path?: unknown }).path;
  return typeof path === 'string' ? path : null;
}

/** Every path a controller declares, for `routeVocabulary`. */
export function declaredRoutePaths(controllers: readonly Type[]): string[] {
  const paths: string[] = [];
  for (const controller of controllers) {
    const base: unknown = Reflect.getMetadata(PATH_METADATA, controller);
    if (typeof base === 'string') paths.push(base);
    const prototype = controller.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(prototype)) {
      const handler = Object.getOwnPropertyDescriptor(prototype, name)?.value;
      if (typeof handler !== 'function') continue;
      const own: unknown = Reflect.getMetadata(PATH_METADATA, handler);
      if (typeof own === 'string') paths.push(own);
    }
  }
  return paths;
}

export function telemetryOptions(cell: string, controllers: readonly Type[]): TelemetryOptions {
  return { cell, vocabulary: routeVocabulary(declaredRoutePaths(controllers)) };
}
