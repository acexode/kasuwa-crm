import type { TenantTx } from '@kasuwa/db';
import { InvalidCursorError } from '@kasuwa/domain-core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { CreateAuditExportBody, ListAuditEventsQuery } from './audit.schemas';
import { exportChanges, listAuditEvents, storedExportFilters, toEntry } from './audit.service';

const TENANT = '99999999-0000-4000-8000-000000000001';
const USER = '99999999-0000-4000-8000-000000000002';

function fakeTx(rows: unknown[] = []): { tx: TenantTx; queries: string[] } {
  const queries: string[] = [];
  const tx: TenantTx = {
    session: { tenantId: TENANT, userId: USER, programmeIds: [] },
    query: <T>(text: string) => {
      queries.push(text);
      return Promise.resolve(rows as T[]);
    },
  };
  return { tx, queries };
}

const row = {
  id: '99999999-0000-4000-8000-0000000000aa',
  occurred_at: '2026-10-03T10:00:00.123Z',
  occurred_at_cursor: '2026-10-03T10:00:00.123456Z',
  actor_kind: 'user' as const,
  actor_user_id: USER,
  actor_display_name: 'Invented Person',
  actor_role_name: null,
  action: 'updated',
  object_type: 'role',
  object_label: 'Shift Lead',
  object_id: null,
  programme_id: null,
  changes: [{ field: 'name', before: 'A', after: 'B', redacted: false, extra: 'dropped' }],
};

describe('toEntry', () => {
  it('emits only the AuditEntry keys, with sourceIp and sourceLocation null', () => {
    const entry = toEntry(row);
    expect(Object.keys(entry).sort()).toEqual(
      [
        'action',
        'actor',
        'changes',
        'id',
        'objectId',
        'objectLabel',
        'objectType',
        'occurredAt',
        'programmeId',
        'sourceIp',
        'sourceLocation',
      ].sort(),
    );
    expect(entry.sourceIp).toBeNull();
    expect(entry.sourceLocation).toBeNull();
    expect(Object.keys(entry.actor).sort()).toEqual(['displayName', 'id', 'kind', 'roleName']);
    expect(entry.changes).toEqual([{ field: 'name', before: 'A', after: 'B', redacted: false }]);
  });

  it('gives a system actor a null id and no person', () => {
    const entry = toEntry({ ...row, actor_kind: 'system', actor_user_id: null });
    expect(entry.actor).toEqual({
      kind: 'system',
      id: null,
      displayName: 'System',
      roleName: null,
    });
  });

  it('never shows a stored value on a redacted change', () => {
    const entry = toEntry({
      ...row,
      changes: [{ field: 'x', before: 'leak', after: 'leak', redacted: true }],
    });
    expect(entry.changes).toEqual([{ field: 'x', before: null, after: null, redacted: true }]);
  });
});

describe('listAuditEvents', () => {
  it('answers any sourceIpPrefix with the empty page and runs no query', async () => {
    const { tx, queries } = fakeTx([row]);
    const page = await listAuditEvents(tx, ListAuditEventsQuery.parse({ sourceIpPrefix: '10.' }));
    expect(page.items).toEqual([]);
    expect(page.page).toEqual({ nextCursor: null, hasMore: false, totalCount: null });
    expect(queries).toEqual([]);
  });

  it('refuses a cursor the server never issued', async () => {
    const { tx } = fakeTx();
    await expect(
      listAuditEvents(tx, ListAuditEventsQuery.parse({ cursor: 'not-a-cursor' })),
    ).rejects.toBeInstanceOf(InvalidCursorError);
  });

  it('fetches one extra row to decide hasMore, and cursors from the microsecond position', async () => {
    const second = { ...row, id: '99999999-0000-4000-8000-0000000000ab' };
    const { tx, queries } = fakeTx([row, second]);
    const page = await listAuditEvents(tx, ListAuditEventsQuery.parse({ pageSize: '1' }));
    expect(page.items).toHaveLength(1);
    expect(page.page.hasMore).toBe(true);
    const decoded = JSON.parse(
      Buffer.from(page.page.nextCursor ?? '', 'base64url').toString('utf8'),
    ) as { c: string; i: string };
    expect(decoded).toEqual({ c: row.occurred_at_cursor, i: row.id });
    // The visibility rule is in the SQL as well as in RLS.
    expect(queries[0]).toContain('e.programme_id IS NULL OR e.programme_id = ANY($2::uuid[])');
    expect(queries[0]).toContain('e.tenant_id = $1');
  });
});

describe('exportChanges', () => {
  it('records includeIpAddresses either way, and a sourceIpPrefix only as redacted', () => {
    const changes = exportChanges(
      CreateAuditExportBody.parse({
        format: 'csv',
        scope: 'filtered',
        includeIpAddresses: true,
        filters: { action: 'deleted', sourceIpPrefix: '10.1' },
      }),
    );
    expect(changes).toContainEqual({
      field: 'includeIpAddresses',
      before: null,
      after: 'true',
      redacted: false,
    });
    expect(changes).toContainEqual({
      field: 'filters.action',
      before: null,
      after: 'deleted',
      redacted: false,
    });
    expect(changes).toContainEqual({
      field: 'filters.sourceIpPrefix',
      before: null,
      after: null,
      redacted: true,
    });
    expect(JSON.stringify(changes)).not.toContain('10.1');

    const plain = exportChanges(
      CreateAuditExportBody.parse({ format: 'json', scope: 'last_90_days' }),
    );
    expect(plain).toContainEqual({
      field: 'includeIpAddresses',
      before: null,
      after: 'false',
      redacted: false,
    });
  });
});

describe('export filters (D-L52 review fixes)', () => {
  const ACTOR = '99999999-0000-4000-8000-0000000000cc';

  it('records filters.actorId only as redacted: which person was looked into is not tenant-wide news', () => {
    const changes = exportChanges(
      CreateAuditExportBody.parse({
        format: 'csv',
        scope: 'filtered',
        filters: { actorId: ACTOR },
      }),
    );
    expect(changes).toContainEqual({
      field: 'filters.actorId',
      before: null,
      after: null,
      redacted: true,
    });
    expect(JSON.stringify(changes)).not.toContain(ACTOR);
  });

  it('stores a sourceIpPrefix as given-but-null, never the partial address', () => {
    const stored = storedExportFilters({ action: 'deleted', sourceIpPrefix: '102.89' });
    expect(stored).toEqual({ action: 'deleted', sourceIpPrefix: null });
    expect(JSON.stringify(stored)).not.toContain('102.89');
    expect(storedExportFilters(undefined)).toEqual({});
    expect(storedExportFilters({ objectType: 'role' })).toEqual({ objectType: 'role' });
  });
});

describe('listAuditEvents applies the reader’s field security (T-0078)', () => {
  const PROGRAMME = '99999999-0000-4000-8000-0000000000a1';
  const SET = '99999999-0000-4000-8000-0000000000b1';
  const contactRow = (id: string) => ({
    ...row,
    id,
    object_type: 'contact',
    object_label: id,
    object_id: id,
    programme_id: PROGRAMME,
    changes: [
      { field: 'lga', before: 'Invented Lga One', after: 'Invented Lga Two', redacted: false },
      { field: 'status', before: 'new', after: 'contacted', redacted: false },
    ],
  });
  const rows = [
    contactRow('99999999-0000-4000-8000-0000000000c1'),
    contactRow('99999999-0000-4000-8000-0000000000c2'),
    contactRow('99999999-0000-4000-8000-0000000000c3'),
  ];

  /**
   * Answers the session's own field-access query (the real `loadFieldAccess`
   * SQL) with `fields` as the catalogue and lga at `lgaLevel` for the held
   * set, and anything else with `rows`. There is no loader parameter to
   * inject: this is the only way to steer the matrix.
   */
  function dispatchingTx(
    fields: string[] = ['lga', 'status'],
    lgaLevel: 'none' | 'read' = 'none',
  ): { tx: TenantTx; accessQueries: () => number } {
    let accessQueries = 0;
    const tx: TenantTx = {
      session: { tenantId: TENANT, userId: USER, programmeIds: [PROGRAMME] },
      query: <T>(text: string) => {
        if (text.includes('FROM object_def o')) {
          accessQueries += 1;
          return Promise.resolve([
            {
              fields,
              grants: [{ field: 'lga', set: SET, locked: false, level: lgaLevel }],
              memberships: [{ programme: PROGRAMME, set: SET, locked: false }],
            },
          ] as T[]);
        }
        return Promise.resolve(rows as T[]);
      },
    };
    return { tx, accessQueries: () => accessQueries };
  }

  it('redacts a withheld field per change, reading the matrix once for the whole page', async () => {
    const fake = dispatchingTx();
    const page = await listAuditEvents(fake.tx, ListAuditEventsQuery.parse({ pageSize: '2' }));
    expect(fake.accessQueries()).toBe(1);
    expect(page.items).toHaveLength(2);
    for (const item of page.items) {
      expect(item.changes).toEqual([
        { field: 'lga', before: null, after: null, redacted: true },
        { field: 'status', before: 'new', after: 'contacted', redacted: false },
      ]);
    }
    expect(JSON.stringify(page)).not.toContain('Invented Lga');
    // Paging is untouched by redaction: the cursor is the last row's position.
    expect(page.page.hasMore).toBe(true);
    const decoded = JSON.parse(
      Buffer.from(page.page.nextCursor ?? '', 'base64url').toString('utf8'),
    ) as { i: string };
    expect(decoded.i).toBe(rows[1]?.id);
  });

  it('judges against the session’s own matrix, and fails closed on a field its catalogue lacks', async () => {
    const fake = dispatchingTx(['lga'], 'read');
    const page = await listAuditEvents(fake.tx, ListAuditEventsQuery.parse({}));
    expect(fake.accessQueries()).toBe(1);
    expect(page.items[0]?.changes).toEqual([
      { field: 'lga', before: 'Invented Lga One', after: 'Invented Lga Two', redacted: false },
      { field: 'status', before: null, after: null, redacted: true },
    ]);
  });

  it('takes no loader: the matrix cannot be supplied by a caller (asserted by tsc, `pnpm typecheck`)', () => {
    // A third parameter, optional or not, makes this a type error.
    expectTypeOf(listAuditEvents).parameters.toEqualTypeOf<[TenantTx, ListAuditEventsQuery]>();
  });
});
