import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { InvalidCursorError } from '@kasuwa/domain-core';
import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { normaliseMethod } from '../telemetry/attributes';
import { recordRequestFailure } from '../telemetry/request-telemetry';
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

/** A JavaScript identifier of sane length: what a class name looks like. */
const IDENTIFIER = /^[A-Za-z_$][\w$]{0,63}$/;
/** A PostgreSQL SQLSTATE: five digits or upper-case letters. */
const SQLSTATE = /^[0-9A-Z]{5}$/;
/** A Node system error code (`ECONNREFUSED`): letters and underscores only. */
const NODE_CODE = /^E[A-Z_]{2,31}$/;

export interface ScrubbedError {
  /** The class (`DatabaseError`, `TypeError`, ...), or `UnknownError`. */
  errorClass: string;
  /** SQLSTATE or Node system code, when the error carries one. */
  code: string | null;
}

/**
 * Reduces an unknown thrown value to two things that cannot carry personal
 * data. The constructor name comes first because pg's `DatabaseError` sets
 * `name` to the protocol message type (`'error'`), which says nothing.
 */
export function scrubError(exception: unknown): ScrubbedError {
  if (typeof exception !== 'object' || exception === null) {
    return { errorClass: 'UnknownError', code: null };
  }
  const constructorName = safeString(
    () => (exception as { constructor?: { name?: unknown } }).constructor?.name,
  );
  const name = safeString(() => (exception as { name?: unknown }).name);
  const errorClass =
    [constructorName, name].find(
      (candidate): candidate is string =>
        candidate !== null && candidate !== 'Object' && IDENTIFIER.test(candidate),
    ) ?? 'UnknownError';

  const rawCode = safeString(() => (exception as { code?: unknown }).code);
  const code =
    rawCode !== null && (SQLSTATE.test(rawCode) || NODE_CODE.test(rawCode)) ? rawCode : null;
  return { errorClass, code };
}

/** Reads a property that might be a throwing getter; only strings survive. */
function safeString(read: () => unknown): string | null {
  try {
    const value = read();
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

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
  const code = scrubbed.code === null ? '' : ` code=${scrubbed.code}`;
  return `unexpected error class=${scrubbed.errorClass}${code} method=${method} route=${route}`;
}

/** Errors from the `http-errors` package with a 4xx status, as Nest answers them. */
function httpClientError(exception: unknown): { statusCode: number; message: string } | null {
  if (!(exception instanceof Error)) return null;
  const status: unknown = (exception as { statusCode?: unknown }).statusCode;
  if (typeof status !== 'number' || status < 400 || status >= 500) return null;
  return { statusCode: status, message: exception.message };
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

    const client = httpClientError(exception);
    if (client !== null) {
      // An `http-errors` 4xx (body-parser's 413, for one) keeps the body Nest's
      // base filter gave it. That text goes back to the caller who caused it;
      // it is never logged - the line above is the only log.
      this.reply(response, client.statusCode, client);
      return;
    }

    this.reply(response, HttpStatus.INTERNAL_SERVER_ERROR, { ...INTERNAL_ERROR_BODY });
  }

  private reply(response: Response, status: number, body: object): void {
    if (response.headersSent) {
      response.end();
      return;
    }
    response.status(status).json(body);
  }
}
