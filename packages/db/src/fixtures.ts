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
 *                  00000013   account
 *                  00000014   activity
 *                  00000015   script
 *                  00000016   script version
 *                  00000017   deal
 *                  00000018   tax profile
 *                  00000019   price book
 *                  0000001a   product
 *                  0000001b   product variant
 *                  0000001c   price book entry
 *                  0000001d   quote
 *                  0000001e   quote line
 *                  0000001f   approval rule
 *
 * Tenant A deliberately models the BPO shape: two client programmes, an agent
 * on each, a supervisor across both, and a user with no programme membership at
 * all (whose scope must resolve to the empty set and therefore see nothing).
 */

import { DEFAULT_PERMISSION_SET_CATALOGUE } from './permission-set-catalogue';

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

/** Tenant A external portal identity (T-0179), home programme A1, also member of A2. */
export const PORTAL_IDENTITY_A = `${A}0000001100d0`;
export const PORTAL_CLIENT_EMAIL = 'portal.client@tenant-a.test';

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

export interface SeedAccount {
  id: string;
  tenantId: string;
  programmeId: string;
  name: string;
}

/**
 * One account per programme (T-0040), kind `00000013`. No seeded contact links
 * to one: `contact.account_id` stays NULL on every seeded contact, which the
 * T-0040 suite relies on. The rows exist so every table carrying updated_at has
 * something for the T-0011 updated_at probe to update.
 */
export const SEED_ACCOUNTS: readonly SeedAccount[] = [
  { id: `${A}000000130001`, tenantId: TENANT_A, programmeId: PROGRAMME_A1, name: 'Ikoyi Traders' },
  {
    id: `${A}000000130002`,
    tenantId: TENANT_A,
    programmeId: PROGRAMME_A2,
    name: 'Sabon Gari Mart',
  },
  {
    id: `${B}000000130003`,
    tenantId: TENANT_B,
    programmeId: PROGRAMME_B1,
    name: 'Westlands Supplies',
  },
  {
    id: `${B}000000130004`,
    tenantId: TENANT_B,
    programmeId: PROGRAMME_B2,
    name: 'Mombasa Road Hardware',
  },
];

export interface SeedActivity {
  id: string;
  tenantId: string;
  programmeId: string;
  type: 'note' | 'task' | 'call';
  subject: string;
  body: string;
  ownerUserId: string;
  accountId: string;
}

/**
 * One activity per tenant (T-0060, D-L77), kind `00000014`, each on its
 * programme's seeded ACCOUNT and owned by a member of that programme. They
 * exist so the T-0011 updated_at probe has an activity row to update. They sit
 * on accounts, never contacts, so no contact suite's view of a seeded contact
 * changes. Subjects and bodies are invented and name no one.
 */
export const SEED_ACTIVITIES: readonly SeedActivity[] = [
  {
    id: `${A}000000140001`,
    tenantId: TENANT_A,
    programmeId: PROGRAMME_A1,
    type: 'note',
    subject: 'Seeded note',
    body: 'Seed fixture: invented text that names no one.',
    ownerUserId: USER_A_AGENT_1,
    accountId: `${A}000000130001`,
  },
  {
    id: `${B}000000140002`,
    tenantId: TENANT_B,
    programmeId: PROGRAMME_B1,
    type: 'task',
    subject: 'Seeded task',
    body: 'Seed fixture: invented text that names no one.',
    ownerUserId: USER_B_AGENT_1,
    accountId: `${B}000000130003`,
  },
];

export interface SeedDeal {
  id: string;
  tenantId: string;
  programmeId: string;
  name: string;
  amountMinor: string;
  currency: 'NGN' | 'GHS' | 'KES' | 'ZAR';
  ownerUserId: string;
}

/**
 * One deal (T-0106, D-L117), kind `00000017`, in PROGRAMME_A1's default
 * pipeline, in its first open stage (the seed looks the stage up: pipeline and
 * stage ids are generated by ensureStandardObjectDefs). It exists so the
 * T-0011 schema-hygiene probe has a deal row whose updated_at it can move. It
 * names no contact and no account, so no contact or account suite's view of a
 * seeded record changes, and no seeded contact or account gains a RESTRICT
 * reference. The name is invented and names no one.
 */
export const SEED_DEALS: readonly SeedDeal[] = [
  {
    id: `${A}000000170001`,
    tenantId: TENANT_A,
    programmeId: PROGRAMME_A1,
    name: 'Seeded fleet renewal',
    amountMinor: '250000000',
    currency: 'NGN',
    ownerUserId: USER_A_AGENT_1,
  },
];

export interface SeedScript {
  id: string;
  tenantId: string;
  programmeId: string;
  name: string;
  sourceLocale: 'en';
  /** A complete ScriptGraph (docs/api/scripting.openapi.yaml); the draft and v1 alike. */
  graph: Readonly<Record<string, unknown>>;
  /** The id of its one published version, number 1. */
  versionId: string;
  /** Who published it: a holder of `script.write` in the programme. */
  publishedByUserId: string;
}

/**
 * One published script in tenant A (T-0113, D-L96), kind `00000015`, with its
 * version 1 (kind `00000016`) and a draft identical to it. It exists so the
 * T-0011 schema-hygiene probe has a script row whose updated_at it can move,
 * and a published version it must be refused on. The wording is invented and
 * names no one; its one variable is the contact's display name.
 *
 * In PROGRAMME_A2 ("Telco Y Care"), not A1: P02's live journey opens A1's
 * scripts tab as the designed empty state (tests/e2e/p02-live.spec.ts,
 * P02/B6), so A1 must seed no script. The publisher, the supervisor, holds
 * the admin set in A2 as in A1.
 */
export const SEED_SCRIPTS: readonly SeedScript[] = [
  {
    id: `${A}000000150001`,
    tenantId: TENANT_A,
    programmeId: PROGRAMME_A2,
    name: 'Seeded care call',
    sourceLocale: 'en',
    graph: {
      startNodeId: 'greet',
      nodes: [
        {
          id: 'greet',
          type: 'say',
          title: 'Greeting',
          text: 'Good afternoon, {contact.displayName}. This is a seeded script.',
          next: 'rec',
        },
        {
          id: 'rec',
          type: 'compliance',
          title: 'Recording notice',
          text: 'This call is recorded for quality and training.',
          next: 'close',
        },
        { id: 'close', type: 'end', title: 'Close', text: 'Thank you for your time.' },
      ],
    },
    versionId: `${A}000000160001`,
    publishedByUserId: USER_A_SUPERVISOR,
  },
];

export interface SeedTaxProfile {
  id: string;
  tenantId: string;
  programmeId: string;
  name: string;
  rateBps: number;
}

export interface SeedPriceBook {
  id: string;
  tenantId: string;
  programmeId: string;
  name: string;
  currency: 'NGN' | 'GHS' | 'KES' | 'ZAR';
}

/** One VAT profile per programme (T-0164), kind `00000018`. */
export const SEED_TAX_PROFILES: readonly SeedTaxProfile[] = [
  {
    id: `${A}000000180001`,
    tenantId: TENANT_A,
    programmeId: PROGRAMME_A1,
    name: 'Nigeria VAT 7.5%',
    rateBps: 750,
  },
  {
    id: `${A}000000180002`,
    tenantId: TENANT_A,
    programmeId: PROGRAMME_A2,
    name: 'Nigeria VAT 7.5%',
    rateBps: 750,
  },
  {
    id: `${B}000000180001`,
    tenantId: TENANT_B,
    programmeId: PROGRAMME_B1,
    name: 'Nigeria VAT 7.5%',
    rateBps: 750,
  },
  {
    id: `${B}000000180002`,
    tenantId: TENANT_B,
    programmeId: PROGRAMME_B2,
    name: 'Nigeria VAT 7.5%',
    rateBps: 750,
  },
];

/** Four standard price books per programme (T-0164), kind `00000019`. */
export const SEED_PRICE_BOOKS: readonly SeedPriceBook[] = [
  {
    id: `${A}000000190001`,
    tenantId: TENANT_A,
    programmeId: PROGRAMME_A1,
    name: 'Standard NGN',
    currency: 'NGN',
  },
  {
    id: `${A}000000190002`,
    tenantId: TENANT_A,
    programmeId: PROGRAMME_A1,
    name: 'Standard GHS',
    currency: 'GHS',
  },
  {
    id: `${A}000000190003`,
    tenantId: TENANT_A,
    programmeId: PROGRAMME_A1,
    name: 'Standard KES',
    currency: 'KES',
  },
  {
    id: `${A}000000190004`,
    tenantId: TENANT_A,
    programmeId: PROGRAMME_A1,
    name: 'Standard ZAR',
    currency: 'ZAR',
  },
  {
    id: `${A}000000190005`,
    tenantId: TENANT_A,
    programmeId: PROGRAMME_A2,
    name: 'Standard NGN',
    currency: 'NGN',
  },
  {
    id: `${A}000000190006`,
    tenantId: TENANT_A,
    programmeId: PROGRAMME_A2,
    name: 'Standard GHS',
    currency: 'GHS',
  },
  {
    id: `${A}000000190007`,
    tenantId: TENANT_A,
    programmeId: PROGRAMME_A2,
    name: 'Standard KES',
    currency: 'KES',
  },
  {
    id: `${A}000000190008`,
    tenantId: TENANT_A,
    programmeId: PROGRAMME_A2,
    name: 'Standard ZAR',
    currency: 'ZAR',
  },
  {
    id: `${B}000000190001`,
    tenantId: TENANT_B,
    programmeId: PROGRAMME_B1,
    name: 'Standard NGN',
    currency: 'NGN',
  },
  {
    id: `${B}000000190002`,
    tenantId: TENANT_B,
    programmeId: PROGRAMME_B1,
    name: 'Standard GHS',
    currency: 'GHS',
  },
  {
    id: `${B}000000190003`,
    tenantId: TENANT_B,
    programmeId: PROGRAMME_B1,
    name: 'Standard KES',
    currency: 'KES',
  },
  {
    id: `${B}000000190004`,
    tenantId: TENANT_B,
    programmeId: PROGRAMME_B1,
    name: 'Standard ZAR',
    currency: 'ZAR',
  },
  {
    id: `${B}000000190005`,
    tenantId: TENANT_B,
    programmeId: PROGRAMME_B2,
    name: 'Standard NGN',
    currency: 'NGN',
  },
  {
    id: `${B}000000190006`,
    tenantId: TENANT_B,
    programmeId: PROGRAMME_B2,
    name: 'Standard GHS',
    currency: 'GHS',
  },
  {
    id: `${B}000000190007`,
    tenantId: TENANT_B,
    programmeId: PROGRAMME_B2,
    name: 'Standard KES',
    currency: 'KES',
  },
  {
    id: `${B}000000190008`,
    tenantId: TENANT_B,
    programmeId: PROGRAMME_B2,
    name: 'Standard ZAR',
    currency: 'ZAR',
  },
];

export interface SeedProduct {
  id: string;
  tenantId: string;
  programmeId: string;
  name: string;
  sku: string;
  taxProfileId: string;
}

export interface SeedProductVariant {
  id: string;
  tenantId: string;
  programmeId: string;
  productId: string;
  name: string;
  sku: string;
}

export interface SeedPriceBookEntry {
  id: string;
  tenantId: string;
  programmeId: string;
  priceBookId: string;
  productId: string;
  variantId: string;
  amountMinor: string;
  currency: 'NGN' | 'GHS' | 'KES' | 'ZAR';
}

/** One seed product in PROGRAMME_A1 so schema-hygiene can exercise updated_at (T-0164). */
export const SEED_PRODUCTS: readonly SeedProduct[] = [
  {
    id: `${A}0000001a0001`,
    tenantId: TENANT_A,
    programmeId: PROGRAMME_A1,
    name: 'Collections retainer',
    sku: 'SEED-RET-001',
    taxProfileId: `${A}000000180001`,
  },
];

export const SEED_PRODUCT_VARIANTS: readonly SeedProductVariant[] = [
  {
    id: `${A}0000001b0001`,
    tenantId: TENANT_A,
    programmeId: PROGRAMME_A1,
    productId: `${A}0000001a0001`,
    name: 'Standard',
    sku: 'SEED-RET-001-STD',
  },
];

export const SEED_PRICE_BOOK_ENTRIES: readonly SeedPriceBookEntry[] = [
  {
    id: `${A}0000001c0001`,
    tenantId: TENANT_A,
    programmeId: PROGRAMME_A1,
    priceBookId: `${A}000000190001`,
    productId: `${A}0000001a0001`,
    variantId: `${A}0000001b0001`,
    amountMinor: '25000000',
    currency: 'NGN',
  },
];

export interface SeedQuote {
  id: string;
  tenantId: string;
  programmeId: string;
  priceBookId: string;
  currency: 'NGN' | 'GHS' | 'KES' | 'ZAR';
  dealId: string | null;
  contactId: string | null;
}

export interface SeedQuoteLine {
  id: string;
  tenantId: string;
  programmeId: string;
  quoteId: string;
  productId: string;
  variantId: string | null;
  quantity: number;
  unitAmountMinor: string;
}

/** One draft quote in PROGRAMME_A1 so schema-hygiene can exercise updated_at (T-0165). */
export const SEED_QUOTES: readonly SeedQuote[] = [
  {
    id: `${A}0000001d0001`,
    tenantId: TENANT_A,
    programmeId: PROGRAMME_A1,
    priceBookId: `${A}000000190001`,
    currency: 'NGN',
    dealId: `${A}000000170001`,
    contactId: `${A}0000000e0001`,
  },
];

export const SEED_QUOTE_LINES: readonly SeedQuoteLine[] = [
  {
    id: `${A}0000001e0001`,
    tenantId: TENANT_A,
    programmeId: PROGRAMME_A1,
    quoteId: `${A}0000001d0001`,
    productId: `${A}0000001a0001`,
    variantId: `${A}0000001b0001`,
    quantity: 1,
    unitAmountMinor: '25000000',
  },
];

export interface SeedApprovalRule {
  id: string;
  tenantId: string;
  programmeId: string;
  thresholdBps: number;
  approverPermissionSetKey: 'admin' | 'team_lead' | 'programme_manager';
}

/** 15% threshold; programme managers (or admin) approve (T-0166). */
export const SEED_APPROVAL_RULES: readonly SeedApprovalRule[] = [
  {
    id: `${A}0000001f0001`,
    tenantId: TENANT_A,
    programmeId: PROGRAMME_A1,
    thresholdBps: 1500,
    approverPermissionSetKey: 'programme_manager',
  },
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
 * The default permission sets (permission-set-catalogue.ts), with fixed ids.
 * Kind `00000010` in the id scheme above. A set is granted per user per
 * programme on `user_programme.permission_set_id` (D-P9, T-0032); what each
 * set permits is `@kasuwa/permissions`.
 */
function permissionSetsFor(tenantId: string, prefix: string): SeedPermissionSet[] {
  return DEFAULT_PERMISSION_SET_CATALOGUE.map((set, index) => ({
    id: `${prefix}00000010${String(index + 1).padStart(4, '0')}`,
    tenantId,
    key: set.key,
    label: set.label,
    locked: set.locked,
    sortOrder: set.sortOrder,
  }));
}

export const SEED_PERMISSION_SETS: readonly SeedPermissionSet[] = [
  ...permissionSetsFor(TENANT_A, A),
  ...permissionSetsFor(TENANT_B, B),
];
