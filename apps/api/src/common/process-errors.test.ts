import { DatabaseError } from 'pg';
import { describe, expect, it } from 'vitest';
import { installProcessErrorHandlers, type ProcessLike } from './process-errors';

/** Invented probe value (CLAUDE.md 6). */
const EMAIL = 'ngozi.okafor.unit-probe@example.test';

class ExitCalled extends Error {}

function fakeProcess(): {
  target: ProcessLike;
  emit: (event: string, error: unknown) => void;
  exits: number[];
} {
  const listeners = new Map<string, (error: unknown) => void>();
  const exits: number[] = [];
  const target: ProcessLike = {
    on(event, listener) {
      listeners.set(event, listener);
      return target;
    },
    exit(code: number): never {
      exits.push(code);
      throw new ExitCalled();
    },
  };
  const emit = (event: string, error: unknown): void => {
    const listener = listeners.get(event);
    if (listener === undefined) throw new Error(`no ${event} listener`);
    try {
      listener(error);
    } catch (thrown) {
      if (!(thrown instanceof ExitCalled)) throw thrown;
    }
  };
  return { target, emit, exits };
}

describe('process-level error handlers', () => {
  it('logs an uncaught exception by class and code only, then exits 1', () => {
    const lines: string[] = [];
    const { target, emit, exits } = fakeProcess();
    installProcessErrorHandlers(target, (line) => lines.push(line));

    const error = Object.assign(new DatabaseError(`Key (email)=(${EMAIL})`, 0, 'error'), {
      code: '23505',
    });
    emit('uncaughtException', error);

    expect(lines).toEqual(['uncaughtException class=DatabaseError code=23505']);
    expect(exits).toEqual([1]);
  });

  it('logs an unhandled rejection the same way and keeps Node’s crash semantics', () => {
    const lines: string[] = [];
    const { target, emit, exits } = fakeProcess();
    installProcessErrorHandlers(target, (line) => lines.push(line));

    emit('unhandledRejection', new TypeError(`cannot read ${EMAIL}`));
    emit('unhandledRejection', { name: 'Chidinma', message: EMAIL });

    expect(lines).toEqual([
      'unhandledRejection class=TypeError',
      'unhandledRejection class=UnknownError',
    ]);
    expect(lines.join('\n')).not.toContain(EMAIL);
    expect(exits).toEqual([1, 1]);
  });

  it('still exits when writing the line fails', () => {
    const { target, emit, exits } = fakeProcess();
    installProcessErrorHandlers(target, () => {
      throw new Error('stderr closed');
    });
    expect(() => emit('uncaughtException', new Error('x'))).not.toThrow();
    expect(exits).toEqual([1]);
  });
});
