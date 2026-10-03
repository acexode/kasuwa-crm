/**
 * Deterministic seed data shared by `pnpm db:seed`, the Testcontainers harness
 * and every acceptance test.
 *
 * The ids are hand-written rather than generated so that a failing isolation
 * test names the offending row legibly. The scheme is:
 *
 *   <tenant prefix>-0000-4000-8000-<kind><index>
 *
 *   tenant prefix  11111111 = Tenant A ("Sahel BPO"), 22222222 = Tenant B
 *   kind           000000000  tenant
 *                  0000000b   business unit
 *                  0000000c   programme
 *                  0000000d   user
 *                  0000000e   contact
 *                  00000010   permission set
 *
 * Tenant A deliberately models the BPO shape: two client programmes, an agent
 * on each, a supervisor across both, and a user with no programme membership at
 * all (whose scope must resolve to the empty set and therefore see nothing).
 */

const A = '11111111-0000-4000-8000-';
const B = '22222222-0000-4000-8000-';

export const TENANT_A = `${A}000000000001`;
export const TENANT_B = `${B}000000000002`;

export const BU_A = `${A}0000000b0001`;
export const BU_B = `${B}0000000b0002`;

/** Tenant A, programme 1 — "Bank X Collections". */
export const PROGRAMME_A1 = `${A}0000000c0001`;
/** Tenant A, programme 2 — "Telco Y Care". */
export const PROGRAMME_A2 = `${A}0000000c0002`;
/** Tenant B, programme 1. */
export const PROGRAMME_B1 = `${B}0000000c0003`;
/** Tenant B, programme 2. */
export const PROGRAMME_B2 = `${B}0000000c0004`;

/** Tenant A agent, member of programme A1 only. */
export const USER_A_AGENT_1 = `${A}0000000d0001`;
/** Tenant A agent, member of programme A2 only. */
export const USER_A_AGENT_2 = `${A}0000000d0002`;
/** Tenant A supervisor, member of both A1 and A2. */
export const USER_A_SUPERVISOR = `${A}0000000d0003`;
/** Tenant A user with NO programme membership; must see nothing at all. */
export const USER_A_NO_PROGRAMME = `${A}0000000d0004`;
/** Tenant B agent, member of programme B1 only. */
export const USER_B_AGENT_1 = `${B}0000000d0005`;

/**
 * The password every seeded user shares.
 *
 * Obviously invented, and it is a fixture, not a credential: it exists only in
 * a database that `pnpm db:reset` throws away, and it is hashed with argon2id
 * at seed time so no hash of it is committed either. The same string appears in
 * the acceptance suite, which is where the requirement for a known value comes
 * from.
 *
 * Nothing that runs outside a test or a local container ever reads it — the
 * seed is run by kasuwa_migrator, which never serves traffic.
 */
export const SEED_PASSWORD = 'correct-horse-battery-staple';

/**
 * Fixed TOTP secrets, one per seeded user.
 *
 * Hand-written and obviously invented, exactly like the ids, so that a test can
 * compute the code the server expects without a round trip. Real secrets are
 * 160 random bits produced at enrolment; these are base32 padding spelling out
 * what they are. They must never be used anywhere but a throwaway database.
 */
const SEED_TOTP_SECRETS: Readonly<Record<string, string>> = {
  [`${A}0000000d0001`]: 'KASUWATESTSECRETAAAAAAAAAAAAAAAA',
  [`${A}0000000d0002`]: 'KASUWATESTSECRETBBBBBBBBBBBBBBBB',
  [`${A}0000000d0003`]: 'KASUWATESTSECRETCCCCCCCCCCCCCCCC',
  [`${A}0000000d0004`]: 'KASUWATESTSECRETDDDDDDDDDDDDDDDD',
  [`${B}0000000d0005`]: 'KASUWATESTSECRETEEEEEEEEEEEEEEEE',
};

/** The seeded TOTP secret for a user, or undefined if they are not seeded. */
export function seedTotpSecret(userId: string): string | undefined {
  return SEED_TOTP_SECRETS[userId];
}

export interface SeedSignIn {
  tenantId: string;
  tenantSlug: string;
  email: string;
  password: string;
  totpSecret: string;
}

/**
 * Everything needed to sign a seeded user in, by user id.
 *
 * Exists so that a test can say "sign in as this user" without restating the
 * slug, the address and the secret in three places and getting one of them
 * wrong.
 */
export function seedSignIn(userId: string): SeedSignIn | undefined {
  for (const tenant of SEED_TENANTS) {
    const user = tenant.users.find((candidate) => candidate.id === userId);
    const totpSecret = SEED_TOTP_SECRETS[userId];
    if (user !== undefined && totpSecret !== undefined) {
      return {
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        email: user.email,
        password: SEED_PASSWORD,
        totpSecret,
      };
    }
  }
  return undefined;
}

/** The first seeded user of a tenant — the one a test means by "sign in as tenant A". */
export function seedPrimaryUser(tenantId: string): string | undefined {
  return SEED_TENANTS.find((tenant) => tenant.id === tenantId)?.users[0]?.id;
}

export interface SeedTenant {
  id: string;
  name: string;
  slug: string;
  businessUnit: { id: string; name: string };
  programmes: { id: string; name: string; clientName: string | null; isDefault: boolean }[];
  users: SeedUser[];
}

export interface SeedUser {
  id: string;
  email: string;
  displayName: string;
  programmeIds: string[];
  /** D-L53: the tenant-level flag `"user".is_tenant_admin`. */
  isTenantAdmin: boolean;
  /**
   * The permission-set key this user holds in every programme of
   * `programmeIds` (`user_programme.permission_set_id`, D-P9).
   */
  permissionSetKey: string;
}

export const SEED_TENANTS: readonly SeedTenant[] = [
  {
    id: TENANT_A,
    name: 'Sahel BPO',
    slug: 'sahel-bpo',
    businessUnit: { id: BU_A, name: 'Lagos Operations' },
    programmes: [
      { id: PROGRAMME_A1, name: 'Bank X Collections', clientName: 'Bank X', isDefault: true },
      { id: PROGRAMME_A2, name: 'Telco Y Care', clientName: 'Telco Y', isDefault: false },
    ],
    users: [
      {
        id: USER_A_AGENT_1,
        email: 'tunde.agent@tenant-a.test',
        displayName: 'Tunde Adeyemi',
        programmeIds: [PROGRAMME_A1],
        isTenantAdmin: false,
        permissionSetKey: 'agent',
      },
      {
        id: USER_A_AGENT_2,
        email: 'ngozi.agent@tenant-a.test',
        displayName: 'Ngozi Okeke',
        programmeIds: [PROGRAMME_A2],
        isTenantAdmin: false,
        permissionSetKey: 'agent',
      },
      {
        id: USER_A_SUPERVISOR,
        email: 'musa.supervisor@tenant-a.test',
        displayName: 'Musa Bello',
        programmeIds: [PROGRAMME_A1, PROGRAMME_A2],
        isTenantAdmin: true,
        permissionSetKey: 'admin',
      },
      {
        id: USER_A_NO_PROGRAMME,
        email: 'emeka.unassigned@tenant-a.test',
        displayName: 'Emeka Nwosu',
        programmeIds: [],
        isTenantAdmin: false,
        permissionSetKey: 'agent',
      },
    ],
  },
  {
    id: TENANT_B,
    name: 'Rift Valley Contact',
    slug: 'rift-valley-contact',
    businessUnit: { id: BU_B, name: 'Nairobi Operations' },
    programmes: [
      { id: PROGRAMME_B1, name: 'Insurer Z Service', clientName: 'Insurer Z', isDefault: true },
      { id: PROGRAMME_B2, name: 'Retail W Sales', clientName: 'Retail W', isDefault: false },
    ],
    users: [
      {
        id: USER_B_AGENT_1,
        email: 'wanjiru.agent@tenant-b.test',
        displayName: 'Wanjiru Kamau',
        programmeIds: [PROGRAMME_B1],
        // Tenant B's only user administers it (D-L53).
        isTenantAdmin: true,
        permissionSetKey: 'admin',
      },
    ],
  },
];

export interface SeedContact {
  id: string;
  tenantId: string;
  programmeId: string;
  displayName: string;
  givenNames: string;
  familyName: string;
  phoneE164: string;
  /** Fixed, spaced timestamps so keyset pagination is deterministic in tests. */
  createdAt: string;
}

function contactsFor(
  tenantId: string,
  programmeId: string,
  prefix: string,
  startIndex: number,
  names: readonly (readonly [string, string, string])[],
): SeedContact[] {
  return names.map(([givenNames, familyName, phoneE164], offset) => {
    const index = startIndex + offset;
    const id = `${prefix}0000000e${String(index).padStart(4, '0')}`;
    // 2026-01-01T00:00:00Z + index minutes — strictly increasing, so
    // ORDER BY created_at DESC, id DESC has a single unambiguous order.
    const createdAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    return {
      id,
      tenantId,
      programmeId,
      displayName: `${givenNames} ${familyName}`,
      givenNames,
      familyName,
      phoneE164,
      createdAt,
    };
  });
}

export const SEED_CONTACTS: readonly SeedContact[] = [
  ...contactsFor(TENANT_A, PROGRAMME_A1, A, 1, [
    ['Amaka', 'Obi', '+2348031234001'],
    ['Bashir', 'Lawal', '+2348031234002'],
    ['Chioma', 'Eze', '+2348031234003'],
  ]),
  ...contactsFor(TENANT_A, PROGRAMME_A2, A, 11, [
    ['Damilola', 'Sanni', '+2348031234011'],
    ['Efe', 'Ogbemudia', '+2348031234012'],
    ['Fatima', 'Yusuf', '+2348031234013'],
  ]),
  ...contactsFor(TENANT_B, PROGRAMME_B1, B, 21, [
    ['Grace', 'Mwangi', '+254712345021'],
    ['Hassan', 'Abdi', '+254712345022'],
    ['Irene', 'Chebet', '+254712345023'],
  ]),
  ...contactsFor(TENANT_B, PROGRAMME_B2, B, 31, [
    ['James', 'Otieno', '+254712345031'],
    ['Kaweria', 'Mutua', '+254712345032'],
    ['Lilian', 'Njeri', '+254712345033'],
  ]),
];

export interface SeedPermissionSet {
  id: string;
  tenantId: string;
  /** The spec's `permissionSetId`. */
  key: string;
  label: string;
  locked: boolean;
  sortOrder: number;
}

/**
 * The default permission sets every tenant starts with — the field-security
 * matrix's columns, in the design's order (P02/D). Admin is `locked`: "Admins
 * always have full access", so its column cannot be edited.
 *
 * Kind `00000010` in the id scheme above. A set is granted per user per
 * programme on `user_programme.permission_set_id` (D-P9, T-0032); what each
 * set permits is `@kasuwa/permissions`.
 */
const DEFAULT_PERMISSION_SETS: readonly (readonly [string, string, boolean])[] = [
  ['agent', 'Agent', false],
  ['team_lead', 'Team lead', false],
  ['qa_analyst', 'QA analyst', false],
  ['programme_manager', 'Programme manager', false],
  ['client_portal', 'Client portal', false],
  ['admin', 'Admin', true],
];

function permissionSetsFor(tenantId: string, prefix: string): SeedPermissionSet[] {
  return DEFAULT_PERMISSION_SETS.map(([key, label, locked], index) => ({
    id: `${prefix}00000010${String(index + 1).padStart(4, '0')}`,
    tenantId,
    key,
    label,
    locked,
    sortOrder: (index + 1) * 10,
  }));
}

export const SEED_PERMISSION_SETS: readonly SeedPermissionSet[] = [
  ...permissionSetsFor(TENANT_A, A),
  ...permissionSetsFor(TENANT_B, B),
];
