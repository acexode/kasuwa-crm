import { describe, it } from 'vitest';

/**
 * ACCEPTANCE STUB — T-0002, metadata engine foundations (Agent 2, M15).
 *
 * `todo` rather than failing, for the reason explained in
 * `tests/acceptance/auth/authentication.acceptance.test.ts`. The lead converts
 * these into real failing tests in a `lead-approved` PR before T-0002 is
 * assigned.
 */
describe('acceptance (stub): metadata definition isolation', () => {
  it.todo('tenant A cannot read tenant B object definitions');

  it.todo('tenant A cannot read tenant B field definitions');

  it.todo('tenant A cannot update or delete a tenant B definition, even knowing its id');

  it.todo('a field definition cannot reference an object definition in another tenant');

  it.todo('api_name uniqueness is scoped per tenant and per object, not globally');

  it.todo(
    'object_def and field_def appear in TENANT_SCOPED_TABLES with RLS enabled, ' +
      'forced, and at least one policy each',
  );

  it.todo(
    'metadata is tenant-scoped but not programme-scoped: a user in one programme ' +
      'sees every definition in their tenant',
  );
});
