import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, HttpStatus } from '@nestjs/common';
import { InvalidCursorError } from '@kasuwa/domain-core';
import type { Response } from 'express';
import { ZodError } from 'zod';

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
        message: 'Invalid cursor',
      });
      return;
    }

    response.status(HttpStatus.BAD_REQUEST).json({
      statusCode: HttpStatus.BAD_REQUEST,
      error: 'Bad Request',
      message: 'Validation failed',
      details: exception.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
      })),
    });
  }
}
