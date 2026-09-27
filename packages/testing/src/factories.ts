import { newId } from '@kasuwa/db';

/**
 * Test data factories.
 *
 * Every factory REQUIRES an explicit tenant and programme. There is no
 * convenience default, and there never should be: a factory that quietly picks
 * a tenant for you is a factory that writes tests which pass while proving
 * nothing about isolation.
 */

let sequence = 0;
function next(): number {
  sequence += 1;
  return sequence;
}

/** Resets the sequence so a suite produces stable values. */
export function resetFactorySequence(): void {
  sequence = 0;
}

export interface ContactInput {
  id: string;
  tenantId: string;
  programmeId: string;
  displayName: string;
  givenNames: string | null;
  familyName: string | null;
  phones: { type: string; e164: string }[];
  emails: string[];
  createdAt: Date;
}

export interface ContactOverrides extends Partial<Omit<ContactInput, 'tenantId' | 'programmeId'>> {
  tenantId: string;
  programmeId: string;
}

export function buildContact(overrides: ContactOverrides): ContactInput {
  const index = next();
  return {
    id: overrides.id ?? newId(),
    tenantId: overrides.tenantId,
    programmeId: overrides.programmeId,
    displayName: overrides.displayName ?? `Test Contact ${index}`,
    givenNames: overrides.givenNames ?? `Test`,
    familyName: overrides.familyName ?? `Contact${index}`,
    phones: overrides.phones ?? [
      { type: 'mobile', e164: `+23480000${String(index).padStart(5, '0')}` },
    ],
    emails: overrides.emails ?? [],
    createdAt: overrides.createdAt ?? new Date(Date.UTC(2026, 5, 1, 0, index, 0)),
  };
}

export const INSERT_CONTACT_SQL = `
  INSERT INTO contact
    (id, tenant_id, programme_id, display_name, given_names, family_name,
     phones, emails, created_at, updated_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $9)
`;

export function insertContactValues(contact: ContactInput): unknown[] {
  return [
    contact.id,
    contact.tenantId,
    contact.programmeId,
    contact.displayName,
    contact.givenNames,
    contact.familyName,
    JSON.stringify(contact.phones),
    JSON.stringify(contact.emails),
    contact.createdAt.toISOString(),
  ];
}
