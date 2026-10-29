import { describe, expect, it } from 'vitest';
import { PortalSignInBody } from './portal.schemas';

describe('portal schemas (T-0179)', () => {
  it('parses a sign-in body', () => {
    expect(
      PortalSignInBody.parse({
        tenantSlug: 'sahel-bpo',
        email: 'portal.client@tenant-a.test',
        password: 'x',
      }),
    ).toEqual({
      tenantSlug: 'sahel-bpo',
      email: 'portal.client@tenant-a.test',
      password: 'x',
    });
  });
});
