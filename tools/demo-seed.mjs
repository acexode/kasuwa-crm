#!/usr/bin/env node
/**
 * DEMO ONLY: fills the seeded tenants with enough synthetic CRM data to demo.
 *
 * `pnpm db:seed` is deliberately thin (twelve contacts, four accounts, one
 * deal), which is right for tests and too empty for a product demo: an empty
 * pipeline, an empty calendar and a one-line timeline. This adds accounts,
 * contacts and leads, activities (notes, calls, tasks and meetings dated
 * around today), deals spread across the pipeline stages through the real
 * gated move, dispositions, and a published collections script.
 *
 * Everything goes THROUGH THE REAL API as a seeded user (the stub identity
 * headers, ADR-0007), never into the database directly. So every row is
 * written by the same repositories, RLS policies, field security, audit and
 * validation as a user's click, and nothing here can produce a row the
 * product could not.
 *
 * Synthetic data only: invented trading names, name pairs used as placeholders,
 * `+234803123xxxx` / `+2547123xxxxx` padded numbers in the fixtures' style,
 * and `@customer.example` addresses (a reserved domain). No BVN, no NIN.
 *
 * Idempotent: every account, contact, deal, script and disposition is looked
 * up by name (or code) first and reused when it exists; activities and stage
 * moves are only written alongside a record this run created. Re-running it
 * adds nothing. `pnpm dev` truncates and re-seeds on every start, so the demo
 * script (tools/demo.mjs) runs this after each start and dates stay fresh.
 *
 * Refuses any API that is not on loopback. No dependencies.
 *
 *   node tools/demo-seed.mjs                    # against http://127.0.0.1:3001
 *   DEMO_API_URL=http://127.0.0.1:3001 node tools/demo-seed.mjs
 */

const api = new URL(process.env.DEMO_API_URL ?? 'http://127.0.0.1:3001');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(api.hostname)) {
  console.error('demo-seed: refusing a non-loopback API. This writes demo data and is local only.');
  process.exit(1);
}

// Seeded identities (packages/db/src/fixtures.ts). Ids, not credentials.
const TENANT_A = '11111111-0000-4000-8000-000000000001';
const TENANT_B = '22222222-0000-4000-8000-000000000002';
const A1 = '11111111-0000-4000-8000-0000000c0001'; // Bank X Collections
const A2 = '11111111-0000-4000-8000-0000000c0002'; // Telco Y Care
const B1 = '22222222-0000-4000-8000-0000000c0003'; // Insurer Z Service
const TUNDE = '11111111-0000-4000-8000-0000000d0001'; // agent, A1
const NGOZI = '11111111-0000-4000-8000-0000000d0002'; // agent, A2
const MUSA = '11111111-0000-4000-8000-0000000d0003'; // tenant admin, A1 + A2
const WANJIRU = '22222222-0000-4000-8000-0000000d0005'; // tenant admin, tenant B

const AS_MUSA = { tenantId: TENANT_A, userId: MUSA };
const AS_WANJIRU = { tenantId: TENANT_B, userId: WANJIRU };

/** Activities are logged by the user who owns them, so timelines name the agent. */
const AS_OWNER = {
  [TUNDE]: { tenantId: TENANT_A, userId: TUNDE },
  [NGOZI]: { tenantId: TENANT_A, userId: NGOZI },
  [MUSA]: AS_MUSA,
  [WANJIRU]: AS_WANJIRU,
};

const counts = { created: 0, reused: 0 };

async function call(as, method, path, body) {
  const response = await fetch(new URL(path, api), {
    method,
    headers: {
      accept: 'application/json',
      'x-kasuwa-tenant-id': as.tenantId,
      'x-kasuwa-user-id': as.userId,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const payload = text === '' ? null : JSON.parse(text);
  if (!response.ok) {
    // The body is the API's error envelope: codes and paths, never values.
    throw new Error(`${method} ${path} answered ${response.status}: ${text.slice(0, 400)}`);
  }
  return payload;
}

const iso = (date) => date.toISOString().replace(/\.\d{3}Z$/, '.000Z');
function at(daysFromNow, hour, minute = 0) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + daysFromNow);
  date.setUTCHours(hour - 1, minute, 0, 0); // WAT is UTC+1
  return iso(date);
}
function dateOnly(daysFromNow) {
  return at(daysFromNow, 12).slice(0, 10);
}

/** Reads every page of a keyset list. */
async function listAll(as, path) {
  const rows = [];
  let cursor = null;
  do {
    const separator = path.includes('?') ? '&' : '?';
    const page = await call(
      as,
      'GET',
      cursor === null ? path : `${path}${separator}cursor=${encodeURIComponent(cursor)}`,
    );
    rows.push(...(page.data ?? page.items ?? []));
    cursor = page.nextCursor ?? null;
  } while (cursor !== null);
  return rows;
}

// ---------------------------------------------------------------------------
// The data. Invented trading names and placeholder people.
// ---------------------------------------------------------------------------

const ACCOUNTS = [
  {
    key: 'oshodi',
    programmeId: A1,
    name: 'Oshodi Spare Parts Co',
    industry: 'Automotive',
    tier: 'sme',
    state: 'Lagos',
    lga: 'Oshodi-Isolo',
    owner: TUNDE,
  },
  {
    key: 'kano',
    programmeId: A1,
    name: 'Kano Groundnut Traders',
    industry: 'Agriculture',
    tier: 'mid_market',
    state: 'Kano',
    lga: 'Fagge',
    owner: MUSA,
  },
  {
    key: 'aba',
    programmeId: A1,
    name: 'Aba Leatherworks Ltd',
    industry: 'Manufacturing',
    tier: 'sme',
    state: 'Abia',
    lga: 'Aba South',
    owner: TUNDE,
  },
  {
    key: 'onitsha',
    programmeId: A1,
    name: 'Onitsha Textiles Hub',
    industry: 'Retail',
    tier: 'mid_market',
    state: 'Anambra',
    lga: 'Onitsha North',
    owner: TUNDE,
  },
  {
    key: 'lekki',
    programmeId: A1,
    name: 'Lekki Fresh Foods',
    industry: 'Food and beverage',
    tier: 'enterprise',
    state: 'Lagos',
    lga: 'Eti-Osa',
    owner: MUSA,
  },
  {
    key: 'ibadan',
    programmeId: A1,
    name: 'Ibadan Agro Inputs',
    industry: 'Agriculture',
    tier: 'sme',
    state: 'Oyo',
    lga: 'Ibadan North',
    owner: TUNDE,
  },
  {
    key: 'wuse',
    programmeId: A2,
    name: 'Wuse Phone Accessories',
    industry: 'Telecoms retail',
    tier: 'sme',
    state: 'FCT',
    lga: 'Abuja Municipal',
    owner: NGOZI,
  },
  {
    key: 'ph',
    programmeId: A2,
    name: 'Port Harcourt Data Kiosk',
    industry: 'Telecoms retail',
    tier: 'sme',
    state: 'Rivers',
    lga: 'Port Harcourt',
    owner: NGOZI,
  },
];

// [given, family, status, source, account key | null, owner, tags, state, lga, consent]
const A1_PEOPLE = [
  [
    'Adaeze',
    'Okafor',
    'customer',
    'referral',
    'lekki',
    MUSA,
    ['vip', 'salary-account'],
    'Lagos',
    'Eti-Osa',
    'opted_in',
  ],
  [
    'Babatunde',
    'Alabi',
    'qualified',
    'whatsapp',
    'oshodi',
    TUNDE,
    ['sme-loan'],
    'Lagos',
    'Oshodi-Isolo',
    'opted_in',
  ],
  [
    'Halima',
    'Garba',
    'contacted',
    'ussd',
    'kano',
    TUNDE,
    ['agri-loan', 'hausa'],
    'Kano',
    'Fagge',
    'pending',
  ],
  [
    'Chukwuemeka',
    'Nnaji',
    'new',
    'missed_call',
    null,
    TUNDE,
    ['arrears-30'],
    'Enugu',
    'Enugu North',
    'unknown',
  ],
  [
    'Folake',
    'Adebayo',
    'qualified',
    'web_form',
    'ibadan',
    TUNDE,
    ['sme-loan'],
    'Oyo',
    'Ibadan North',
    'opted_in',
  ],
  [
    'Ibrahim',
    'Sule',
    'unqualified',
    'walk_in',
    null,
    TUNDE,
    ['arrears-90'],
    'Kaduna',
    'Kaduna North',
    'withdrawn',
  ],
  [
    'Ngozika',
    'Umeh',
    'customer',
    'referral',
    'onitsha',
    TUNDE,
    ['salary-account'],
    'Anambra',
    'Onitsha North',
    'opted_in',
  ],
  [
    'Oluwaseun',
    'Bakare',
    'new',
    'whatsapp',
    null,
    TUNDE,
    ['arrears-30'],
    'Ogun',
    'Abeokuta South',
    'unknown',
  ],
  [
    'Zainab',
    'Abubakar',
    'contacted',
    'ussd',
    'kano',
    MUSA,
    ['agri-loan'],
    'Kano',
    'Nassarawa',
    'pending',
  ],
  [
    'Kelechi',
    'Obiora',
    'qualified',
    'whatsapp',
    'aba',
    TUNDE,
    ['sme-loan', 'promise-to-pay'],
    'Abia',
    'Aba South',
    'opted_in',
  ],
  [
    'Yetunde',
    'Ogunleye',
    'customer',
    'manual',
    'lekki',
    MUSA,
    ['vip'],
    'Lagos',
    'Ikeja',
    'opted_in',
  ],
  [
    'Musa',
    'Danjuma',
    'new',
    'missed_call',
    null,
    TUNDE,
    ['arrears-60'],
    'Plateau',
    'Jos North',
    'unknown',
  ],
];

const A2_PEOPLE = [
  [
    'Aisha',
    'Mohammed',
    'customer',
    'whatsapp',
    'wuse',
    NGOZI,
    ['postpaid'],
    'FCT',
    'Abuja Municipal',
    'opted_in',
  ],
  [
    'Tamuno',
    'Briggs',
    'contacted',
    'ussd',
    'ph',
    NGOZI,
    ['data-bundle'],
    'Rivers',
    'Port Harcourt',
    'pending',
  ],
  [
    'Funmilayo',
    'Ojo',
    'new',
    'missed_call',
    null,
    NGOZI,
    ['sim-swap'],
    'Ekiti',
    'Ado-Ekiti',
    'unknown',
  ],
  [
    'Emmanuel',
    'Etim',
    'qualified',
    'web_form',
    'wuse',
    NGOZI,
    ['enterprise-lead'],
    'Akwa Ibom',
    'Uyo',
    'opted_in',
  ],
  [
    'Hauwa',
    'Lawan',
    'contacted',
    'whatsapp',
    null,
    NGOZI,
    ['dnd-registered'],
    'Borno',
    'Maiduguri',
    'withdrawn',
  ],
];

const B1_PEOPLE = [
  [
    'Achieng',
    'Odhiambo',
    'customer',
    'whatsapp',
    null,
    WANJIRU,
    ['motor-cover'],
    'Nairobi',
    'Westlands',
    'opted_in',
  ],
  [
    'Kipchoge',
    'Ruto',
    'new',
    'ussd',
    null,
    WANJIRU,
    ['health-cover'],
    'Uasin Gishu',
    'Eldoret',
    'unknown',
  ],
  [
    'Wambui',
    'Karanja',
    'contacted',
    'missed_call',
    null,
    WANJIRU,
    ['renewal'],
    'Kiambu',
    'Thika',
    'pending',
  ],
];

// ---------------------------------------------------------------------------

async function findOrCreateAccount(as, spec) {
  const existing = await listAll(as, `/api/v1/accounts?q=${encodeURIComponent(spec.name)}`);
  const hit = existing.find((row) => row.name === spec.name);
  if (hit !== undefined) {
    counts.reused += 1;
    return { record: hit, created: false };
  }
  const record = await call(as, 'POST', '/api/v1/accounts', {
    programmeId: spec.programmeId,
    name: spec.name,
    industry: spec.industry,
    tier: spec.tier,
    state: spec.state,
    lga: spec.lga,
    ownerUserId: spec.owner,
    tags: [spec.tier === 'enterprise' ? 'key-account' : 'growth'],
    phones: [
      { type: 'work', e164: `+23480312306${String(ACCOUNTS.indexOf(spec)).padStart(2, '0')}` },
    ],
  });
  counts.created += 1;
  return { record, created: true };
}

async function findOrCreateContact(as, programmeId, person, index, phonePrefix, accounts) {
  const [
    givenNames,
    familyName,
    status,
    source,
    accountKey,
    owner,
    tags,
    state,
    lga,
    consentState,
  ] = person;
  const displayName = `${givenNames} ${familyName}`;
  const existing = await listAll(as, `/api/v1/contacts?q=${encodeURIComponent(displayName)}`);
  const hit = existing.find(
    (row) => row.displayName === displayName && row.programmeId === programmeId,
  );
  if (hit !== undefined) {
    counts.reused += 1;
    return { record: hit, created: false };
  }
  const record = await call(as, 'POST', '/api/v1/contacts', {
    programmeId,
    displayName,
    givenNames,
    familyName,
    phones: [{ type: 'mobile', e164: `${phonePrefix}${String(500 + index).padStart(4, '0')}` }],
    emails: [
      `${givenNames}.${familyName}`.toLowerCase().replace(/[^a-z.]/g, '') + '@customer.example',
    ],
    status,
    source,
    tags,
    state,
    lga,
    consentState,
    whatsappOptIn: consentState === 'opted_in',
    preferredChannel: source === 'ussd' ? 'sms' : 'whatsapp',
    preferredLanguage: tags.includes('hausa') ? 'ha' : 'en',
    ownerUserId: owner,
    ...(accountKey === null ? {} : { accountId: accounts.get(accountKey).id }),
  });
  counts.created += 1;
  return { record, created: true };
}

async function activity(as, body) {
  await call(as, 'POST', '/api/v1/activities', body);
  counts.created += 1;
}

/** A note, a call and a task or meeting per new contact, dated around today. */
async function activitiesFor(contact, index, ownerUserId) {
  const as = AS_OWNER[ownerUserId];
  const n = index % 4;
  await activity(as, {
    type: 'call',
    contactId: contact.id,
    ownerUserId,
    subject: [
      'Outbound call: arrears reminder',
      'Inbound call from WhatsApp click-to-call',
      'Follow-up call on loan offer',
      'Courtesy call after payment',
    ][n],
    body: [
      'Customer asked for a breakdown of the outstanding balance. Sent it on WhatsApp.',
      'Customer called back after a missed call. Wants to restructure.',
      'Discussed the SME working-capital offer. Interested, needs a week.',
      'Thanked the customer for clearing the instalment on time.',
    ][n],
  });
  await activity(as, {
    type: 'note',
    contactId: contact.id,
    ownerUserId,
    subject: 'Account note',
    body: [
      'Prefers WhatsApp after 6pm WAT. Do not call during Jumat prayers on Fridays.',
      'Shop is closed on Sundays; best reached Monday morning.',
      'Speaks Hausa first; agent switched language mid-call.',
      'Asked that SMS reminders stop. Consent updated.',
    ][n],
  });
  if (n === 3) {
    await activity(as, {
      type: 'meeting',
      contactId: contact.id,
      ownerUserId,
      subject: 'Branch visit: restructuring options',
      startsAt: at(index % 5, 11),
      endsAt: at(index % 5, 12),
    });
  } else {
    // Overdue, due today and upcoming, so P07's buckets all have something.
    await activity(as, {
      type: 'task',
      contactId: contact.id,
      ownerUserId,
      subject: [
        'Call back about promise to pay',
        'Send restructuring letter',
        'Confirm payment received',
      ][n],
      dueAt: at([-2, 0, 3][n], [10, 15, 9][n]),
    });
  }
}

// [name, account key, contact index, amount NGN (naira), target stage name, owner, next step]
const A1_DEALS = [
  [
    'Lekki Fresh Foods: payroll accounts for 400 staff',
    'lekki',
    0,
    185_000_000,
    'Contract',
    MUSA,
    'Collect signed purchase order',
  ],
  [
    'Kano Groundnut Traders: harvest working capital',
    'kano',
    2,
    48_000_000,
    'Negotiation',
    TUNDE,
    'Agree the repayment window',
  ],
  [
    'Oshodi Spare Parts: POS terminals and settlement',
    'oshodi',
    1,
    6_500_000,
    'Proposal',
    TUNDE,
    'Send the tariff sheet',
  ],
  [
    'Aba Leatherworks: export invoice financing',
    'aba',
    9,
    22_000_000,
    'Discovery',
    TUNDE,
    'Visit the factory',
  ],
  [
    'Ibadan Agro Inputs: dealer credit line',
    'ibadan',
    4,
    15_000_000,
    'Qualified',
    TUNDE,
    'Book a discovery call',
  ],
  ['Onitsha Textiles Hub: trade finance renewal', 'onitsha', 6, 90_000_000, 'Won', TUNDE, null],
  ['Lekki Fresh Foods: cold-chain asset finance', 'lekki', 10, 120_000_000, 'Lost', MUSA, null],
  [
    'Kano Groundnut Traders: USSD collections pilot',
    'kano',
    8,
    3_500_000,
    'Qualified',
    MUSA,
    'Demo the USSD menu',
  ],
];

const A2_DEALS = [
  [
    'Wuse Phone Accessories: corporate data bundles',
    'wuse',
    3,
    12_000_000,
    'Proposal',
    NGOZI,
    'Price 50 SIMs',
  ],
  [
    'Port Harcourt Data Kiosk: reseller onboarding',
    'ph',
    1,
    4_000_000,
    'Discovery',
    NGOZI,
    'Confirm the CAC documents',
  ],
];

async function pipelineFor(as, programmeId) {
  const pipelines = await listAll(as, '/api/v1/pipelines');
  const summary = pipelines.find((row) => row.programmeId === programmeId);
  if (summary === undefined) throw new Error('demo-seed: a programme has no pipeline');
  return call(as, 'GET', `/api/v1/pipelines/${summary.id}`);
}

/** Moves a deal stage by stage to the target, filling each gate. */
async function moveTo(as, pipeline, deal, targetName, contactId) {
  const stages = pipeline.stages;
  const opens = stages.filter((stage) => stage.kind === 'open');
  const target = stages.find((stage) => stage.name === targetName);
  let current = await call(as, 'GET', `/api/v1/deals/${deal.id}`);
  const path =
    target.kind === 'open'
      ? opens.filter((stage) => stage.position > 0 && stage.position <= target.position)
      : target.kind === 'won'
        ? [...opens.slice(1), target]
        : [opens[1], target];
  for (const stage of path) {
    const fields = {};
    const checks = [];
    for (const requirement of stage.requirements) {
      if (requirement.kind === 'check') checks.push(requirement.id);
      // Only what is missing: re-sending a value it already has would log a
      // "changed" line on the deal timeline for nothing.
      if (requirement.field === 'expectedCloseDate' && current.expectedCloseDate == null)
        fields.expectedCloseDate = dateOnly(30);
      if (requirement.field === 'primaryContactId' && current.primaryContactId == null)
        fields.primaryContactId = contactId;
    }
    await call(as, 'POST', `/api/v1/deals/${deal.id}/move`, {
      version: current.version,
      toStageId: stage.id,
      ...(Object.keys(fields).length === 0 ? {} : { fields }),
      ...(checks.length === 0 ? {} : { checks }),
    });
    counts.created += 1;
    current = await call(as, 'GET', `/api/v1/deals/${deal.id}`);
  }
}

async function seedDeals(as, programmeId, specs, accounts, contacts) {
  const pipeline = await pipelineFor(as, programmeId);
  const existing = await listAll(as, `/api/v1/pipelines/${pipeline.id}/deals`);
  for (const [name, accountKey, contactIndex, naira, stageName, owner, nextStep] of specs) {
    if (existing.some((row) => row.name === name)) {
      counts.reused += 1;
      continue;
    }
    const contact = contacts[contactIndex];
    const deal = await call(as, 'POST', `/api/v1/pipelines/${pipeline.id}/deals`, {
      name,
      amount: { amountMinor: String(naira * 100), currency: 'NGN' },
      expectedCloseDate: dateOnly(
        stageName === 'Won' || stageName === 'Lost' ? -5 : 21 + (naira % 30),
      ),
      ownerUserId: owner,
      accountId: accounts.get(accountKey).id,
      primaryContactId: contact.id,
      ...(nextStep === null ? {} : { nextStep }),
    });
    counts.created += 1;
    await activity(AS_OWNER[owner], {
      type: 'note',
      accountId: accounts.get(accountKey).id,
      contactId: contact.id,
      dealId: deal.id,
      ownerUserId: owner,
      subject: 'Deal opened',
      body: 'Opportunity logged after the customer asked for a proposal on WhatsApp.',
    });
    await activity(AS_OWNER[owner], {
      type: 'call',
      contactId: contact.id,
      dealId: deal.id,
      ownerUserId: owner,
      subject: 'Discovery call',
      body: 'Walked through volumes, settlement times and the NGN pricing.',
    });
    await moveTo(as, pipeline, deal, stageName, contact.id);
  }
}

const DISPOSITIONS = [
  { code: 'PTP', label: 'Promise to pay', category: 'promise_to_pay', followUpRequired: true },
  { code: 'PAID', label: 'Paid in full', category: 'resolved' },
  { code: 'CALLBACK', label: 'Call back later', category: 'callback', followUpRequired: true },
  { code: 'DISPUTE', label: 'Disputes the balance', category: 'escalated', noteRequired: true },
  { code: 'NO_ANSWER', label: 'No answer', category: 'not_reached' },
];

async function seedDispositions(as, programmeId) {
  const path = `/api/v1/admin/programmes/${programmeId}/dispositions`;
  const existing = (await call(as, 'GET', path)).items;
  const byCode = new Map(existing.map((row) => [row.code, row]));
  for (const spec of DISPOSITIONS) {
    if (byCode.has(spec.code)) {
      counts.reused += 1;
      continue;
    }
    byCode.set(spec.code, await call(as, 'POST', path, spec));
    counts.created += 1;
  }
  return byCode;
}

const SCRIPT_NAME = 'Bank X: promise-to-pay call';

async function seedScript(as, programmeId, dispositions) {
  const scripts = (await listAll(as, '/api/v1/scripts')).filter(
    (row) => row.programmeId === programmeId,
  );
  if (scripts.some((row) => row.name === SCRIPT_NAME)) {
    counts.reused += 1;
    return;
  }
  const graph = {
    startNodeId: 'greet',
    nodes: [
      {
        id: 'greet',
        type: 'say',
        title: 'Greeting',
        text: 'Good day, am I speaking with {contact.givenNames}? My name is {agent.displayName}, calling from Bank X.',
        next: 'notice',
        position: { x: 40, y: 40 },
      },
      {
        id: 'notice',
        type: 'compliance',
        title: 'Recording and NDPA notice',
        text: 'This call is recorded for quality and training. Your data is processed under the Nigeria Data Protection Act. You can ask us to stop contacting you at any time.',
        next: 'identity',
        position: { x: 40, y: 200 },
      },
      {
        id: 'identity',
        type: 'question',
        title: 'Right party check',
        text: 'Can you confirm the last four digits of the phone number on your account?',
        choices: [
          { key: 'confirmed', label: 'Confirmed', next: 'balance' },
          { key: 'wrong_person', label: 'Wrong person', next: 'close_wrong' },
        ],
        position: { x: 40, y: 360 },
      },
      {
        id: 'balance',
        type: 'say',
        title: 'State the balance',
        text: 'Your account shows an overdue instalment. We would like to agree a payment date that works for you.',
        next: 'offer',
        position: { x: 40, y: 520 },
      },
      {
        id: 'offer',
        type: 'question',
        title: 'Can the customer pay?',
        text: 'Are you able to make a payment this week?',
        choices: [
          { key: 'yes', label: 'Yes, this week', next: 'ptp' },
          { key: 'later', label: 'Later', next: 'close_callback' },
          { key: 'dispute', label: 'Disputes the balance', next: 'close_dispute' },
        ],
        position: { x: 40, y: 680 },
      },
      {
        id: 'ptp',
        type: 'form',
        title: 'Record the promise',
        text: 'Agree the amount and the date, then read them back to the customer.',
        fields: [
          {
            key: 'amount',
            label: 'Amount promised',
            type: 'money',
            required: true,
            currency: 'NGN',
            minimumMinor: '100000',
            maximumMinor: '10000000000',
          },
          {
            key: 'pay_date',
            label: 'Payment date',
            type: 'date',
            required: true,
            minDaysAhead: 0,
            maxDaysAhead: 14,
          },
          {
            key: 'channel',
            label: 'How they will pay',
            type: 'choice',
            required: true,
            options: [
              { key: 'transfer', label: 'Bank transfer' },
              { key: 'ussd', label: 'USSD' },
              { key: 'pos', label: 'POS agent' },
            ],
          },
        ],
        next: 'close_ptp',
        position: { x: 40, y: 840 },
      },
      {
        id: 'close_ptp',
        type: 'end',
        title: 'Close: promise recorded',
        text: 'Thank you. You will get a WhatsApp confirmation shortly.',
        suggestedDispositionId: dispositions.get('PTP').id,
        position: { x: 40, y: 1000 },
      },
      {
        id: 'close_callback',
        type: 'end',
        title: 'Close: call back',
        text: 'No problem. When is a good time to call you back?',
        suggestedDispositionId: dispositions.get('CALLBACK').id,
        position: { x: 400, y: 840 },
      },
      {
        id: 'close_dispute',
        type: 'end',
        title: 'Close: escalate',
        text: 'I will pass this to a supervisor, who will call you within two working days.',
        suggestedDispositionId: dispositions.get('DISPUTE').id,
        position: { x: 760, y: 840 },
      },
      {
        id: 'close_wrong',
        type: 'end',
        title: 'Close: wrong person',
        text: 'Sorry for the trouble. Have a good day.',
        position: { x: 400, y: 520 },
      },
    ],
  };
  const script = await call(as, 'POST', '/api/v1/scripts', {
    programmeId,
    name: SCRIPT_NAME,
    sourceLocale: 'en',
    graph,
  });
  await call(as, 'POST', `/api/v1/scripts/${script.id}/versions`, {
    revision: script.revision,
    changes: ['First version for the demo'],
  });
  counts.created += 1;
}

async function seedTenantA() {
  const accounts = new Map();
  for (const [index, spec] of ACCOUNTS.entries()) {
    const { record, created } = await findOrCreateAccount(AS_MUSA, spec);
    accounts.set(spec.key, record);
    if (created) {
      // A meeting this week per account, so every user's calendar has some.
      await activity(AS_OWNER[spec.owner], {
        type: 'meeting',
        accountId: record.id,
        ownerUserId: spec.owner,
        subject: `Account review: ${spec.name}`,
        startsAt: at(index % 5, 10 + (index % 3) * 2),
        endsAt: at(index % 5, 11 + (index % 3) * 2),
      });
    }
  }

  const a1Contacts = [];
  for (const [index, person] of A1_PEOPLE.entries()) {
    const { record, created } = await findOrCreateContact(
      AS_MUSA,
      A1,
      person,
      index,
      '+234803123',
      accounts,
    );
    a1Contacts.push(record);
    if (created) await activitiesFor(record, index, person[5]);
  }
  const a2Contacts = [];
  for (const [index, person] of A2_PEOPLE.entries()) {
    const { record, created } = await findOrCreateContact(
      AS_MUSA,
      A2,
      person,
      50 + index,
      '+234803123',
      accounts,
    );
    a2Contacts.push(record);
    if (created) await activitiesFor(record, index, person[5]);
  }

  await seedDeals(AS_MUSA, A1, A1_DEALS, accounts, a1Contacts);
  await seedDeals(AS_MUSA, A2, A2_DEALS, accounts, a2Contacts);

  const dispositions = await seedDispositions(AS_MUSA, A1);
  await seedDispositions(AS_MUSA, A2);
  await seedScript(AS_MUSA, A1, dispositions);
}

async function seedTenantB() {
  for (const [index, person] of B1_PEOPLE.entries()) {
    const { record, created } = await findOrCreateContact(
      AS_WANJIRU,
      B1,
      person,
      index,
      '+25471234',
      new Map(),
    );
    if (created) await activitiesFor(record, index, WANJIRU);
  }
}

try {
  await seedTenantA();
  await seedTenantB();
  console.log(
    `demo-seed: done (${counts.created} writes, ${counts.reused} records already present)`,
  );
} catch (error) {
  console.error(`demo-seed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
