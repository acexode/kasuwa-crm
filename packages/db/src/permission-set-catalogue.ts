/**
 * The default permission sets every tenant starts with — the field-security
 * matrix's columns, in the design's order (P02/D). Admin is `locked`: "Admins
 * always have full access", so its column cannot be edited.
 *
 * ONE list, read by two writers: the seed (`fixtures.ts`, with fixed ids) and
 * tenant provisioning (`provisionTenant` in `@kasuwa/domain-core/provisioning`,
 * T-0015, with fresh ids). Two copies of "what a new tenant starts with" drift apart, and
 * the drift is found on a customer's tenant.
 *
 * These name sets and grant nothing; there is no assignment model yet (D-P9
 * puts it on `user_programme`).
 */
export interface DefaultPermissionSet {
  readonly key: string;
  readonly label: string;
  readonly locked: boolean;
  readonly sortOrder: number;
}

const ENTRIES: readonly (readonly [string, string, boolean])[] = [
  ['agent', 'Agent', false],
  ['team_lead', 'Team lead', false],
  ['qa_analyst', 'QA analyst', false],
  ['programme_manager', 'Programme manager', false],
  ['client_portal', 'Client portal', false],
  ['admin', 'Admin', true],
];

export const DEFAULT_PERMISSION_SET_CATALOGUE: readonly DefaultPermissionSet[] = ENTRIES.map(
  ([key, label, locked], index) => ({ key, label, locked, sortOrder: (index + 1) * 10 }),
);
