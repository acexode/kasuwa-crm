import { describe, it } from 'vitest';

/**
 * ACCEPTANCE STUB — T-0005, observability baseline (Agent 13, DevOps).
 *
 * `todo` rather than failing, for the reason explained in
 * `tests/acceptance/auth/authentication.acceptance.test.ts`.
 *
 * The second group matters more than it looks. Telemetry is the classic way
 * personal data escapes a system that is otherwise careful with it: a request
 * body gets attached to a span "for debugging", and six months later a Nigerian
 * customer's phone number and BVN are sitting in a US-hosted trace store, which
 * is an NDPA cross-border transfer nobody assessed.
 */
describe('acceptance (stub): observability', () => {
  it.todo('every API span carries tenant_id');

  it.todo('every span on a programme-scoped route carries programme_id');

  it.todo('every span carries the cell identifier');

  it.todo('a trace can be correlated to a request without a client-supplied id');

  it.todo(
    'no span attribute contains an email address, phone number, NIN or BVN, ' +
      'asserted against a deliberately PII-heavy request',
  );

  it.todo('no log field contains an email address, phone number, NIN or BVN');

  it.todo('error telemetry records the error type and route but not the request body');
});
