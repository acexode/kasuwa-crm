import { scrubError, scrubbedFields } from './scrub-error';

/**
 * Process-level last resorts (T-0036, D-L42).
 *
 * Without these, Node prints an uncaught exception's or unhandled rejection's
 * message and full stack to stderr before exiting, and a pg error's message
 * can carry a row value. These handlers print only the scrubbed class and code
 * (the same fields the global exception filter logs), never the message, the
 * stack or the value itself.
 *
 * Crash semantics are preserved: Node's default for both is to exit with code
 * 1 (unhandled rejections have thrown by default since Node 15), so both
 * handlers exit with 1 after the line is written. A process in an unknown state
 * is not kept running.
 */

export interface ProcessLike {
  on(
    event: 'uncaughtException' | 'unhandledRejection',
    listener: (error: unknown) => void,
  ): unknown;
  exit(code: number): never;
}

export function processErrorLine(
  kind: 'uncaughtException' | 'unhandledRejection',
  error: unknown,
): string {
  return `${kind} ${scrubbedFields(scrubError(error))}`;
}

export function installProcessErrorHandlers(
  target: ProcessLike,
  writeLine: (line: string) => void,
): void {
  for (const kind of ['uncaughtException', 'unhandledRejection'] as const) {
    target.on(kind, (error: unknown) => {
      try {
        writeLine(processErrorLine(kind, error));
      } finally {
        target.exit(1);
      }
    });
  }
}
