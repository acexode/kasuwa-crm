import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { TenantTx } from '@kasuwa/db';
import { from, lastValueFrom, of, type Observable } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { runWithTx } from '../tenancy/tenant-context';
import { SendAfterCommit, SendAfterCommitInterceptor, SendBeforeCommitError } from './send-after-commit';

/**
 * startScriptRun's 200/201 is sent by SendAfterCommitInterceptor once the
 * tenant transaction has committed (T-0114 review). Without a database: the
 * tenant interceptor is stood in for by `runWithTx` (what it wraps the handler
 * in) and by a promise that resolves on COMMIT or rejects on a failure.
 */

function fakeResponse(headersSent = false) {
  const response = {
    headersSent,
    status: vi.fn(),
    json: vi.fn(),
  };
  response.status.mockReturnValue(response);
  return response;
}

function contextFor(response: ReturnType<typeof fakeResponse>): ExecutionContext {
  return {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ExecutionContext;
}

const handlerOf = (source: Observable<unknown>): CallHandler => ({ handle: () => source });

const FAKE_TX = { session: {}, query: async () => [] } as unknown as TenantTx;

/** What TenantTransactionInterceptor returns: the handler's value once COMMIT resolved. */
const committed = (value: unknown) =>
  from(runWithTx(FAKE_TX, async () => value).then((result) => result));

describe('SendAfterCommitInterceptor', () => {
  it('sends the status and body after the inner (tenant) interceptor resolved', async () => {
    const response = fakeResponse();
    const run = { id: 'r1' };
    await lastValueFrom(
      new SendAfterCommitInterceptor().intercept(
        contextFor(response),
        handlerOf(committed(new SendAfterCommit(201, run))),
      ),
    );
    expect(response.status).toHaveBeenCalledWith(201);
    expect(response.json).toHaveBeenCalledWith(run);
  });

  it('sends nothing when the inner interceptor rejects after the handler (a failed COMMIT)', async () => {
    const response = fakeResponse();
    const failedCommit = from(
      runWithTx(FAKE_TX, async () => new SendAfterCommit(201, { id: 'r1' })).then(() => {
        throw new Error('commit failed');
      }),
    );
    await expect(
      lastValueFrom(
        new SendAfterCommitInterceptor().intercept(contextFor(response), handlerOf(failedCommit)),
      ),
    ).rejects.toThrow('commit failed');
    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();
  });

  it('fails loudly, sending nothing, when listed inside the tenant transaction (the order swapped)', async () => {
    const response = fakeResponse();
    const swapped = runWithTx(FAKE_TX, () =>
      lastValueFrom(
        new SendAfterCommitInterceptor().intercept(
          contextFor(response),
          handlerOf(of(new SendAfterCommit(201, { id: 'r1' }))),
        ),
      ),
    );
    await expect(swapped).rejects.toBeInstanceOf(SendBeforeCommitError);
    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();
  });

  it('never sends twice', async () => {
    const response = fakeResponse(true);
    await lastValueFrom(
      new SendAfterCommitInterceptor().intercept(
        contextFor(response),
        handlerOf(committed(new SendAfterCommit(200, { id: 'r1' }))),
      ),
    );
    expect(response.json).not.toHaveBeenCalled();
  });

  it('passes every other handler result through untouched', async () => {
    const response = fakeResponse();
    const value = { id: 'r1' };
    await expect(
      lastValueFrom(
        new SendAfterCommitInterceptor().intercept(contextFor(response), handlerOf(committed(value))),
      ),
    ).resolves.toBe(value);
    expect(response.json).not.toHaveBeenCalled();
  });
});
