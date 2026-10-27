import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, HttpStatus } from '@nestjs/common';
import { InvalidCursorError } from '@kasuwa/domain-core';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { MAX_ERROR_DETAILS } from '../admin/common/admin-errors';
import { wireIssueCode, wireIssues } from './zod-issue-code';

/**
 * Turns boundary-validation failures into 400s with a stable shape.
 *
 * It reports which fields failed but never echoes the submitted values back.
 * Request payloads in this system routinely contain personal data (PRD 2.12,
 * CLAUDE.md security guardrails), and an error body is just another place it
 * can end up in a log aggregator.
 */
@Catch(ZodError, InvalidCursorError)
export class ValidationExceptionFilter implements ExceptionFilter {
  catch(exception: ZodError | InvalidCursorError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof InvalidCursorError) {
      response.status(HttpStatus.BAD_REQUEST).json({
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'Bad Request',
        code: 'invalid_cursor',
        message: 'Invalid cursor',
      });
      return;
    }

    response.status(HttpStatus.BAD_REQUEST).json({
      statusCode: HttpStatus.BAD_REQUEST,
      error: 'Bad Request',
      // Stable machine-readable reason, matching the envelope every auth error
      // uses (docs/api/auth.openapi.yaml). Clients switch on `code`; `message`
      // is an English fallback and is not an interface.
      code: 'validation_failed',
      message: 'Validation failed',
      // At most 50, in issue order (MAX_ERROR_DETAILS, T-0113 security review).
      details: wireIssues(exception.issues)
        .slice(0, MAX_ERROR_DETAILS)
        .map((issue) => ({
          path: issue.path.join('.'),
          code: wireIssueCode(issue),
        })),
    });
  }
}
