import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { of, throwError, type Observable } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { mfaCodeInvalid } from './auth.errors';
import { CommitThenFailInterceptor } from './commit-then-fail.interceptor';

const context = {} as ExecutionContext;
const handler = (source: Observable<unknown>): CallHandler => ({ handle: () => source });

function settle(source: Observable<unknown>): Promise<{ value?: unknown; error?: unknown }> {
  return new Promise((resolve) => {
    let value: unknown;
    source.subscribe({
      next: (next) => {
        value = next;
      },
      error: (error: unknown) => resolve({ error }),
      complete: () => resolve({ value }),
    });
  });
}

describe('CommitThenFailInterceptor', () => {
  const interceptor = new CommitThenFailInterceptor();

  it('raises a RETURNED AuthError as an error, after the inner observable has emitted it', async () => {
    const refusal = mfaCodeInvalid(3);
    const result = await settle(interceptor.intercept(context, handler(of(refusal))));
    expect(result.error).toBe(refusal);
    expect(result.value).toBeUndefined();
  });

  it('passes any other value through untouched', async () => {
    const body = { backupCodesRemaining: 9 };
    const result = await settle(interceptor.intercept(context, handler(of(body))));
    expect(result.value).toBe(body);
    expect(result.error).toBeUndefined();
  });

  it('still propagates a thrown error (which rolled the transaction back)', async () => {
    const boom = new Error('boom');
    const result = await settle(interceptor.intercept(context, handler(throwError(() => boom))));
    expect(result.error).toBe(boom);
  });
});
