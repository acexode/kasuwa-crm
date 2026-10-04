import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { isPoolConnectionTimeout } from '@kasuwa/db';
import { InvalidCursorError } from '@kasuwa/domain-core';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { normaliseMethod } from '../telemetry/attributes';
import { recordRequestFailure } from '../telemetry/request-telemetry';
import { scrubError, scrubbedFields, type ScrubbedError } from './scrub-error';
import { ValidationExceptionFilter } from './zod-exception.filter';

/**
 * The last filter every request reaches (T-0036, D-L42).
 *
 * Nest's built-in handler answers an unexpected error with a generic 500, and
 * then LOGS IT: `exception.message` and the stack, to stdout, outside
 * OpenTelemetry. A pg error's message can carry a row value (`invalid input
 * syntax for type uuid: "<value>"`), its `detail` always can (`Key (email)=(...)
 * already exists.`), and so can any Error a developer builds from its inputs.
 * This filter replaces that path. Registered globally through `APP_FILTER`, so
 * it covers every controller, including feature modules' and admin areas'
 * (whose `AdminErrorFilter` handles HTTP errors only).
 *
 * What it does with an error that is NOT an `HttpException`:
 *
 *   - answers ONE body, identical for every failure: no database text, no
 *     SQLSTATE, no class name, no id. A body that varies tells the caller which
 *     constraint or code path it hit;
 *   - logs ONE line that still makes the incident diagnosable without naming
 *     anybody: the error's class, its SQLSTATE (or Node system code) when it has
 *     one, the method and the route TEMPLATE Express matched. Never `message`,
 *     `detail`, `where`, the stack, the raw URL or the request. Every value in
 *     the line is checked against a shape that personal data cannot take;
 *   - adds a scrubbed `exception` event (class and code only) to the request
 *     span, so traces show the failure too. Never `span.recordException(error)`:
 *     that copies the message and stack into the trace store.
 *
 * Everything else keeps the behaviour it had before this filter existed:
 * `HttpException` bodies are answered exactly as Nest's base filter answers
 * them (and, as there, not logged), and Zod / cursor failures are delegated to
 * `ValidationExceptionFilter`, so the result does not depend on which of the
 * two global filters Nest happens to try first.
 */

/** The fixed 500 body. `code` is in both specs' `Error.code` enums. */
export const INTERNAL_ERROR_BODY = Object.freeze({
  statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
  error: 'Internal Server Error',
  code: 'internal_error',
  message: 'Something went wrong on our side. Please try again.',
});

/**
 * The fixed 503 body for an exhausted connection pool (T-0045, D-L56).
 *
 * ONE body and ONE `Retry-After` for every route. In particular a bearer read
 * must not answer 401 (that signs a real user out because the database was
 * busy), and the two sign-in branches - a workspace that exists and one that
 * does not - must not differ (the ADR-0009 enumeration oracle). Nothing in it
 * comes from the request or the error.
 */
export const SERVICE_UNAVAILABLE_BODY = Object.freeze({
  statusCode: HttpStatus.SERVICE_UNAVAILABLE,
  error: 'Service Unavailable',
  code: 'service_unavailable',
  message: 'The service is busy right now. Please try again in a moment.',
});

/**
 * Seconds a client should wait before retrying after a pool timeout. A
 * constant, never derived from load: a value that moved with pool pressure
 * would be a side channel on other tenants' traffic.
 */
export const SERVICE_UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/** The route TEMPLATE Express matched (`/api/v1/contacts/:id`), never the URL. */
export function routeTemplate(request: unknown): string {
  const route: unknown = (request as { route?: unknown } | undefined)?.route;
  if (typeof route === 'object' && route !== null) {
    const path: unknown = (route as { path?: unknown }).path;
    if (typeof path === 'string') return path;
  }
  return '(unmatched)';
}

/** The one log line. Built only from values that passed the shapes above. */
export function unexpectedErrorLine(
  scrubbed: ScrubbedError,
  method: string,
  route: string,
): string {
  return `unexpected error ${scrubbedFields(scrubbed)} method=${method} route=${route}`;
}

/** What an unexposed client error says instead of its own message. */
export const CLIENT_ERROR_MESSAGE = 'The request could not be processed.';

/**
 * Errors from the `http-errors` package with a 4xx status (body-parser's 413,
 * for one), answered as Nest's base filter answers them - except that the
 * message is echoed only when the error says it is safe to (`expose === true`,
 * which `http-errors` sets on its own 4xx messages). Anything else gets a
 * fixed text.
 */
function httpClientError(exception: unknown): { statusCode: number; message: string } | null {
  if (!(exception instanceof Error)) return null;
  const status: unknown = (exception as { statusCode?: unknown }).statusCode;
  if (typeof status !== 'number' || status < 400 || status >= 500) return null;
  const exposed = (exception as { expose?: unknown }).expose === true;
  return { statusCode: status, message: exposed ? exception.message : CLIENT_ERROR_MESSAGE };
}

@Catch()
export class UnexpectedErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('UnexpectedError');
  private readonly validation = new ValidationExceptionFilter();

  catch(exception: unknown, host: ArgumentsHost): void {
    if (exception instanceof ZodError || exception instanceof InvalidCursorError) {
      this.validation.catch(exception, host);
      return;
    }

    if (host.getType() !== 'http') {
      // No other transport exists yet. Log the scrubbed line and nothing else.
      this.logger.error(unexpectedErrorLine(scrubError(exception), '_OTHER', '(no route)'));
      return;
    }

    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();

    if (exception instanceof HttpException) {
      // Nest's BaseExceptionFilter, verbatim: an object response is the body,
      // a string becomes `{ statusCode, message }`. Not logged, as there.
      const body = exception.getResponse();
      const status = exception.getStatus();
      this.reply(
        response,
        status,
        typeof body === 'object' ? body : { statusCode: status, message: body },
      );
      return;
    }

    const scrubbed = scrubError(exception);
    const method = normaliseMethod(request.method);
    const route = routeTemplate(request);
    this.logger.error(unexpectedErrorLine(scrubbed, method, route));
    recordRequestFailure(request, scrubbed);

    if (isPoolConnectionTimeout(exception)) {
      // Load, not a fault in the request: 503 with a Retry-After. Logged above
      // like any other unexpected error (class only - pg's message is not).
      this.reply(
        response,
        HttpStatus.SERVICE_UNAVAILABLE,
        { ...SERVICE_UNAVAILABLE_BODY },
        { 'Retry-After': String(SERVICE_UNAVAILABLE_RETRY_AFTER_SECONDS) },
      );
      return;
    }

    const client = httpClientError(exception);
    if (client !== null) {
      // An `http-errors` 4xx keeps its status (see `httpClientError` for the
      // message). It is never logged - the line above is the only log.
      this.reply(response, client.statusCode, client);
      return;
    }

    this.reply(response, HttpStatus.INTERNAL_SERVER_ERROR, { ...INTERNAL_ERROR_BODY });
  }

  /**
   * Writes the answer. If writing itself throws (a body that will not
   * serialise, a socket already gone), the fallback is a bare 500 - and the
   * second error is deliberately NOT logged: it can carry the same values.
   */
  private reply(
    response: Response,
    status: number,
    body: object,
    headers: Readonly<Record<string, string>> = {},
  ): void {
    try {
      if (response.headersSent) {
        response.end();
        return;
      }
      for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
      response.status(status).json(body);
    } catch {
      try {
        if (!response.headersSent) response.status(HttpStatus.INTERNAL_SERVER_ERROR);
        response.end();
      } catch {
        // Nothing left to write to.
      }
    }
  }
}
