import { newId } from '@kasuwa/db';
import { tenantSlugProblem } from '../tenant/tenant-slug';
import {
  provisionTenant,
  type ProvisionedTenant,
  type ProvisionTenantOptions,
} from '../tenant/provision-tenant';

export interface SelfServeProvisionInput {
  connectionString: string;
  slug: string;
  organisationName: string;
  adminEmail: string;
  adminDisplayName: string;
  passwordHash: string;
  allowNonLocalDatabase?: boolean;
}

export async function provisionSelfServeTenant(
  input: SelfServeProvisionInput,
): Promise<ProvisionedTenant> {
  const options: ProvisionTenantOptions = {
    connectionString: input.connectionString,
    slug: input.slug,
    name: input.organisationName,
    region: 'ZA',
    adminEmail: input.adminEmail,
    adminDisplayName: input.adminDisplayName,
    initialPasswordHash: input.passwordHash,
    ...(input.allowNonLocalDatabase !== undefined
      ? { allowNonLocalDatabase: input.allowNonLocalDatabase }
      : {}),
  };
  return provisionTenant(options);
}

export function organisationToSlug(organisationName: string): string {
  let base = organisationName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (base.length < 2) {
    base = 'team';
  }
  base = base.slice(0, 48);
  let candidate = `${base}-${newId().replace(/-/gu, '').slice(0, 8)}`;
  while (tenantSlugProblem(candidate) !== null) {
    candidate = `${base}-${newId().replace(/-/gu, '').slice(0, 8)}`;
  }
  return candidate;
}
