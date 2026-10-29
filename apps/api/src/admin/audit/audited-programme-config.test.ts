import 'reflect-metadata';
import type { ChannelProvider } from '@kasuwa/channel-adapter';
import { ProviderUnavailableError } from '@kasuwa/channel-adapter';
import type { TenantTx } from '@kasuwa/db';
import {
  defaultSlaPolicy,
  StalePolicyVersionError,
  type Disposition,
  type RetentionPolicy,
} from '@kasuwa/domain-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DispositionsController } from '../dispositions/dispositions.controller';
import { movedCount } from '../dispositions/dispositions.audit';
import { PortalUsersController } from '../portal-users/portal-users.controller';
import { ProgrammeSlaRetentionController } from '../sla-retention/sla-retention.controller';
import { retentionChanges, slaChanges } from '../sla-retention/sla-retention.audit';

/**
 * T-0033: the audited writes that landed after T-0025 — SLA, retention, the
 * four disposition writes and the portal invite. The domain functions are
 * stubbed; what is under test is what reaches `audit_event`, and for the
 * invite, what must never reach it. Every identifier is invented.
 */

const TENANT = '99999999-0000-4000-8000-000000000001';
const USER = '99999999-0000-4000-8000-000000000002';
const PROGRAMME = '99999999-0000-4000-8000-000000000003';
const DISPOSITION = '99999999-0000-4000-8000-000000000004';
const OTHER_DISPOSITION = '99999999-0000-4000-8000-000000000005';
const PORTAL_USER = '99999999-0000-4000-8000-000000000006';
const INVITED_ADDRESS = 'invented.invitee@client.example';
const INVITED_NAME = 'Invented Invitee Name';

const inserts: unknown[][] = [];
const tx: TenantTx = {
  session: { tenantId: TENANT, userId: USER, programmeIds: [PROGRAMME] },
  query: <T>(text: string, values: readonly unknown[] = []) => {
    if (text.includes('INSERT INTO audit_event')) inserts.push([...values]);
    // The permissions engine's read (T-0032): this caller is a tenant admin,
    // so every write here is permitted and reaches the audit writer.
    if (text.includes('SELECT is_tenant_admin')) {
      return Promise.resolve([{ is_tenant_admin: true }] as T[]);
    }
    // Portal invite email body needs the tenant slug (T-0180).
    if (text.includes('SELECT slug FROM tenant')) {
      return Promise.resolve([{ slug: 'invented-tenant' }] as T[]);
    }
    return Promise.resolve([] as T[]);
  },
};

vi.mock('../../tenancy/tenant-context', () => ({ currentTx: () => tx }));

const domain = vi.hoisted(() => ({
  findProgrammeById: vi.fn(),
  // T-0032: the disposition 404 check before the permission check.
  dispositionExists: vi.fn(() => Promise.resolve(true)),
  replaceProgrammeSlaWithPrevious: vi.fn(),
  replaceProgrammeRetentionWithPrevious: vi.fn(),
  createDisposition: vi.fn(),
  updateDispositionWithPrevious: vi.fn(),
  deleteDispositionWithPrevious: vi.fn(),
  reorderDispositionsWithPrevious: vi.fn(),
  upsertPortalInvitation: vi.fn(),
}));
vi.mock('@kasuwa/domain-core', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...domain,
}));

/** Columns of the writer's INSERT, by position. */
const event = (values: unknown[]) => ({
  action: values[3],
  objectType: values[4],
  objectId: values[5],
  objectLabel: values[6],
  programmeId: values[7],
  changes: JSON.parse(String(values[8])) as { field: string; redacted: boolean }[],
});
const events = () => inserts.map(event);

const disposition = (overrides: Partial<Disposition> = {}): Disposition => ({
  id: DISPOSITION,
  code: 'INVENTED',
  label: 'Invented outcome',
  category: 'callback',
  noteRequired: false,
  followUpRequired: false,
  active: true,
  position: 1,
  ...overrides,
});

const retention = (overrides: Partial<RetentionPolicy> = {}): RetentionPolicy => ({
  version: 1,
  callRecordingsDays: 365,
  messageTranscriptsDays: 365,
  screenRecordingsDays: 90,
  qaEvaluationsDays: 365,
  onExpiry: 'delete',
  redactSensitiveNumbersInTranscripts: true,
  legalHold: false,
  ...overrides,
});

const SLA_WRITE = {
  version: 0,
  targets: [
    { channel: 'voice', firstResponseSeconds: 20, resolutionSeconds: null, clock: 'always' },
  ],
  pauseOutsideOperatingHours: true,
  pauseAwaitingCustomer: true,
  warnAtPercentOfTarget: 90,
  warnNotifyRole: 'team_lead',
  breachNotifyRole: 'programme_manager',
};

beforeEach(() => {
  inserts.length = 0;
  vi.clearAllMocks();
  domain.findProgrammeById.mockResolvedValue({ id: PROGRAMME, name: 'Invented Programme' });
});

describe('updateProgrammeSla audit', () => {
  it('records one sla_policy event inside the programme, naming only what moved', async () => {
    const previous = defaultSlaPolicy();
    const updated = { ...SLA_WRITE, version: 1, targets: SLA_WRITE.targets } as typeof previous;
    domain.replaceProgrammeSlaWithPrevious.mockResolvedValue({ previous, updated });
    await new ProgrammeSlaRetentionController().updateSla({ programmeId: PROGRAMME }, SLA_WRITE);

    const [written, ...rest] = events();
    expect(rest).toEqual([]);
    expect(written).toMatchObject({
      action: 'updated',
      objectType: 'sla_policy',
      objectId: PROGRAMME,
      programmeId: PROGRAMME,
    });
    const fields = written?.changes.map((change) => change.field);
    // The default has a WhatsApp target this write drops; voice and the pauses are as before.
    expect(fields).toEqual([
      'version',
      'targets.whatsapp.firstResponseSeconds',
      'targets.whatsapp.resolutionSeconds',
      'targets.whatsapp.clock',
      'warnAtPercentOfTarget',
    ]);
    expect(written?.changes[1]).toEqual({
      field: 'targets.whatsapp.firstResponseSeconds',
      before: '900',
      after: null,
      redacted: false,
    });
  });

  it('records nothing for a stale write', async () => {
    domain.replaceProgrammeSlaWithPrevious.mockRejectedValue(new StalePolicyVersionError());
    await expect(
      new ProgrammeSlaRetentionController().updateSla({ programmeId: PROGRAMME }, SLA_WRITE),
    ).rejects.toBeDefined();
    expect(inserts).toEqual([]);
  });

  it('records nothing for a body the boundary refuses', async () => {
    await expect(
      new ProgrammeSlaRetentionController().updateSla(
        { programmeId: PROGRAMME },
        { ...SLA_WRITE, warnAtPercentOfTarget: 'lots' },
      ),
    ).rejects.toBeDefined();
    expect(domain.replaceProgrammeSlaWithPrevious).not.toHaveBeenCalled();
    expect(inserts).toEqual([]);
  });

  it('still records one event for a save that only moves the version', () => {
    const policy = defaultSlaPolicy();
    expect(slaChanges(policy, { ...policy, version: 1 })).toEqual([
      { field: 'version', before: '0', after: '1', redacted: false },
    ]);
  });
});

describe('updateProgrammeRetention audit', () => {
  it('records the first policy with null befores, as strings', async () => {
    const updated = retention();
    domain.replaceProgrammeRetentionWithPrevious.mockResolvedValue({ previous: null, updated });
    const { version: _version, ...fields } = updated;
    await new ProgrammeSlaRetentionController().updateRetention(
      { programmeId: PROGRAMME },
      { ...fields, version: 0 },
    );
    const [written, ...rest] = events();
    expect(rest).toEqual([]);
    expect(written).toMatchObject({
      action: 'updated',
      objectType: 'retention_policy',
      objectId: PROGRAMME,
      programmeId: PROGRAMME,
    });
    expect(written?.changes).toContainEqual({
      field: 'legalHold',
      before: null,
      after: 'false',
      redacted: false,
    });
  });

  it('names only the field that moved', () => {
    expect(
      retentionChanges(retention(), retention({ version: 2, screenRecordingsDays: 30 })),
    ).toEqual([
      { field: 'version', before: '1', after: '2', redacted: false },
      { field: 'screenRecordingsDays', before: '90', after: '30', redacted: false },
    ]);
  });
});

describe('disposition audit', () => {
  const controller = () => new DispositionsController();

  it('records a created event with the disposition id and its configuration', async () => {
    domain.createDisposition.mockResolvedValue(disposition());
    await controller().create(
      { programmeId: PROGRAMME },
      { code: 'INVENTED', label: 'Invented outcome', category: 'callback' },
    );
    expect(events()).toEqual([
      expect.objectContaining({
        action: 'created',
        objectType: 'disposition',
        objectId: DISPOSITION,
        objectLabel: 'Invented outcome',
        programmeId: PROGRAMME,
      }),
    ]);
    expect(events()[0]?.changes).toContainEqual({
      field: 'code',
      before: null,
      after: 'INVENTED',
      redacted: false,
    });
  });

  it('records an update with only the moved field, and nothing for a no-op patch', async () => {
    domain.updateDispositionWithPrevious.mockResolvedValueOnce({
      previous: disposition(),
      updated: disposition({ active: false }),
    });
    const ids = { programmeId: PROGRAMME, dispositionId: DISPOSITION };
    await controller().update(ids, { active: false });
    expect(events()).toEqual([
      expect.objectContaining({
        action: 'updated',
        objectId: DISPOSITION,
        programmeId: PROGRAMME,
        changes: [{ field: 'active', before: 'true', after: 'false', redacted: false }],
      }),
    ]);

    inserts.length = 0;
    domain.updateDispositionWithPrevious.mockResolvedValueOnce({
      previous: disposition(),
      updated: disposition(),
    });
    await controller().update(ids, { label: 'Invented outcome' });
    expect(inserts).toEqual([]);
  });

  it('records a delete once, and nothing for the idempotent repeat', async () => {
    const ids = { programmeId: PROGRAMME, dispositionId: DISPOSITION };
    domain.deleteDispositionWithPrevious.mockResolvedValueOnce({ previous: disposition() });
    await controller().remove(ids);
    expect(events()).toEqual([
      expect.objectContaining({ action: 'deleted', objectId: DISPOSITION, programmeId: PROGRAMME }),
    ]);

    inserts.length = 0;
    domain.deleteDispositionWithPrevious.mockResolvedValueOnce({ previous: null });
    await controller().remove(ids);
    expect(inserts).toEqual([]);
  });

  it('records nothing when the disposition is not reachable', async () => {
    domain.deleteDispositionWithPrevious.mockResolvedValue(null);
    await expect(
      controller().remove({ programmeId: PROGRAMME, dispositionId: DISPOSITION }),
    ).rejects.toBeDefined();
    expect(inserts).toEqual([]);
  });

  it('records ONE event for a reorder, not one per row', async () => {
    const first = disposition();
    const second = disposition({ id: OTHER_DISPOSITION, code: 'OTHER', position: 2 });
    domain.reorderDispositionsWithPrevious.mockResolvedValue({
      previous: [first, second],
      updated: [
        { ...second, position: 1 },
        { ...first, position: 2 },
      ],
    });
    await controller().reorder(
      { programmeId: PROGRAMME },
      { dispositionIds: [OTHER_DISPOSITION, DISPOSITION] },
    );
    expect(events()).toEqual([
      {
        action: 'updated',
        objectType: 'disposition',
        objectId: null,
        objectLabel: 'Disposition order',
        programmeId: PROGRAMME,
        changes: [
          { field: 'dispositionCount', before: null, after: '2', redacted: false },
          { field: 'movedCount', before: null, after: '2', redacted: false },
        ],
      },
    ]);
  });

  it('counts only the dispositions whose position changed', () => {
    const a = disposition();
    const b = disposition({ id: OTHER_DISPOSITION, position: 2 });
    expect(movedCount([a, b], [a, b])).toBe(0);
  });
});

describe('invitePortalUser audit (D-L52, D-L54)', () => {
  const send = vi.fn();
  const channel = { send } as unknown as ChannelProvider;
  const invited = (outcome: 'created' | 'resent') => ({
    user: {
      id: PORTAL_USER,
      displayName: INVITED_NAME,
      emailMasked: 'i***@client.example',
      access: 'viewer',
      status: 'invited',
      invitedAt: new Date('2026-01-01T00:00:00Z'),
    },
    deliverTo: INVITED_ADDRESS,
    outcome,
  });
  const body = { email: INVITED_ADDRESS, displayName: INVITED_NAME, access: 'viewer' };

  it('records the address only as a redacted change, and never the name', async () => {
    send.mockResolvedValue(undefined);
    domain.upsertPortalInvitation.mockResolvedValue(invited('created'));
    await new PortalUsersController(channel).invite({ programmeId: PROGRAMME }, body);

    expect(events()).toEqual([
      {
        action: 'invited',
        objectType: 'portal_user',
        objectId: PORTAL_USER,
        objectLabel: 'Client-portal user',
        programmeId: PROGRAMME,
        changes: [
          { field: 'access', before: null, after: 'viewer', redacted: false },
          { field: 'email', before: null, after: null, redacted: true },
        ],
      },
    ]);
    const raw = JSON.stringify(inserts).toLowerCase();
    expect(raw).not.toContain('invented.invitee');
    expect(raw).not.toContain('client.example');
    expect(raw).not.toContain(INVITED_NAME.toLowerCase());
  });

  it('records a resend as one more invited event for the same portal user', async () => {
    send.mockResolvedValue(undefined);
    domain.upsertPortalInvitation.mockResolvedValue(invited('resent'));
    await new PortalUsersController(channel).invite({ programmeId: PROGRAMME }, body);
    expect(events()).toEqual([
      expect.objectContaining({
        action: 'invited',
        objectId: PORTAL_USER,
        programmeId: PROGRAMME,
        changes: [{ field: 'inviteToken', before: null, after: null, redacted: true }],
      }),
    ]);
  });

  it('is written before the send, so a failed send throws and the transaction drops both', async () => {
    send.mockRejectedValue(new ProviderUnavailableError());
    domain.upsertPortalInvitation.mockResolvedValue(invited('created'));
    await expect(
      new PortalUsersController(channel).invite({ programmeId: PROGRAMME }, body),
    ).rejects.toBeDefined();
    // The insert ran in the request's transaction; the throw is what rolls it back.
    expect(inserts).toHaveLength(1);
  });

  it('records nothing for a malformed address', async () => {
    await expect(
      new PortalUsersController(channel).invite(
        { programmeId: PROGRAMME },
        { email: 'nobody', access: 'viewer' },
      ),
    ).rejects.toBeDefined();
    expect(domain.upsertPortalInvitation).not.toHaveBeenCalled();
    expect(inserts).toEqual([]);
  });
});
