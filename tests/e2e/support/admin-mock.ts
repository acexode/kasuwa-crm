import type { Page, Route } from '@playwright/test';
import {
  ADMIN_CONTRACT_SOURCE,
  contractExample,
  findOperation,
  type AdminOperationId,
} from './admin-mock.generated';

/**
 * The admin API, as `docs/api/admin.openapi.yaml` describes it, served into the
 * browser by Playwright.
 *
 * Every body comes from `admin-mock.generated.ts`, which is generated from that
 * spec. Nothing here invents a payload. What lives here is only the STATE the
 * contract describes in prose and cannot put in an example:
 *
 *   - which alerts THIS USER has dismissed (dismissal is per user, not per
 *     workspace — one admin clearing an alert must not hide it from another)
 *   - which disposition has been deleted or deactivated in this session
 *   - `q` and `status` filtering, which is a server behaviour the screens
 *     depend on and an example cannot show
 *
 * ---------------------------------------------------------------------------
 * THE NULLS ARE A SCENARIO, NOT AN ACCIDENT
 *
 * Three fields in this contract are nullable because the system genuinely does
 * not know the answer: `presence` (telephony adapter down), `needed` (WFM
 * forecast missing) and `usageCount90d` (interaction aggregate unavailable).
 * The spec's examples show them populated, because an example shows the normal
 * case. `unknownSources` makes the mock return null for all three, so the
 * screens can be tested for the thing that matters — that null renders "not
 * known" and never "Offline", "0%" or "0 times".
 * ---------------------------------------------------------------------------
 */

export interface AdminMockOptions {
  /** Hold every admin response this long. Used to reach the slow state. */
  readonly delayMs?: number;
  /** `P02/B1`: the caller can reach no programmes. */
  readonly noProgrammes?: boolean;
  /** Every out-of-scope id is `404`, never `403`. */
  readonly programmeNotFound?: boolean;
  /** Telephony, WFM and the interaction aggregate are all unavailable. */
  readonly unknownSources?: boolean;
  /**
   * `PUT /field-security/matrix` answers `200` instead of its published `501`.
   * The contract documents the success body for exactly this reason — "request
   * it with `Prefer: code=200`" — so `P02/D` can be driven through its saved
   * state before the endpoint exists.
   */
  readonly fieldSecurityWritable?: boolean;
  /** `409 stale_write`: somebody else saved while this admin was editing. */
  readonly fieldSecurityStale?: boolean;
  /** `PUT /roles/hierarchy` and `DELETE /roles/{id}` answer as if built. */
  readonly rolesWritable?: boolean;
  /** `409 role_hierarchy_cycle`, which applies NOTHING — not even valid moves. */
  readonly roleCycle?: boolean;
  /** `P02/E1`: no audit events the caller can reach. */
  readonly noAuditEvents?: boolean;
  /** `POST /audit/exports` answers its published `202`. */
  readonly auditExportAccepted?: boolean;
  /** `P02/B6`: the programme has no scripts at all. */
  readonly noScripts?: boolean;
  /**
   * `PUT /retention` answers `200` instead of its published `501`, so `P02/B7`
   * can be driven through its saved state before the endpoint exists.
   */
  readonly retentionWritable?: boolean;
  /**
   * `409 legal_hold_active`: the API refuses to turn a hold off and shorten a
   * period in one request. Two deliberate steps, two audit rows.
   */
  readonly retentionLegalHold?: boolean;
  /** `P02/B8`: one invited portal user, so the non-empty row renders. */
  readonly portalUsers?: boolean;
  /**
   * `P02/B9`: `GET /archive-preview` answers without a `retentionSummary`.
   * Null is "we do not know which rule applies" and the dialog must omit the
   * line rather than invent one — D-T4 is why that matters here.
   */
  readonly archiveRetentionUnknown?: boolean;
}

interface MockState {
  readonly dismissed: Set<string>;
  readonly removed: Set<string>;
  readonly deactivated: Set<string>;
  /** Cell levels saved through `PUT /field-security/matrix`, keyed by field. */
  readonly fieldSecurity: Map<string, string>;
  /** Role moves applied through `PUT /roles/hierarchy`. */
  readonly roleParents: Map<string, string | null>;
  /** Retention fields saved through `PUT /retention`. */
  readonly retention: Map<string, number | string | boolean>;
  readonly deletedRoles: Set<string>;
  /** Every body the screens sent, so a test can assert on the REQUEST. */
  readonly requests: { operationId: string; body: unknown }[];
}

function json(route: Route, status: number, body: unknown): Promise<void> {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function example<T>(operationId: AdminOperationId, status: number, name = 'default'): T {
  return clone(contractExample(operationId, status, name) as T);
}

interface ProgrammeRow {
  id: string;
  name: string;
  clientName?: string | null;
  status: string;
  [key: string]: unknown;
}

interface RoleRow {
  id: string;
  name: string;
  parentRoleId: string | null;
  userCount: number;
  [key: string]: unknown;
}

interface MatrixBody {
  objectApiName: string;
  version: number;
  totalFieldCount?: number;
  rows: {
    fieldApiName: string;
    label: string;
    classification: string;
    cells: { permissionSetId: string; level: string; locked: boolean }[];
  }[];
}

interface AuditRow {
  action: string;
  objectType: string;
  sourceIp?: string | null;
  [key: string]: unknown;
}

export async function installAdminMock(
  page: Page,
  options: AdminMockOptions = {},
): Promise<MockState> {
  const state: MockState = {
    dismissed: new Set<string>(),
    removed: new Set<string>(),
    deactivated: new Set<string>(),
    fieldSecurity: new Map<string, string>(),
    roleParents: new Map<string, string | null>(),
    retention: new Map<string, number | string | boolean>(),
    deletedRoles: new Set<string>(),
    requests: [],
  };

  await page.route('**/api/v1/admin/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const operation = findOperation(request.method(), url.pathname);

    if (operation === undefined) {
      throw new Error(
        `${request.method()} ${url.pathname} is not in ${ADMIN_CONTRACT_SOURCE}. ` +
          'The screen is calling an endpoint the contract does not publish.',
      );
    }

    if (options.delayMs !== undefined) {
      await new Promise((done) => setTimeout(done, options.delayMs));
    }

    switch (operation.operationId) {
      case 'getAdminHomeSummary':
        return json(route, 200, example('getAdminHomeSummary', 200));

      case 'listAdminAlerts': {
        const body = example<{ items: { id: string; dismissed: boolean }[] }>(
          'listAdminAlerts',
          200,
        );
        const includeDismissed = url.searchParams.get('includeDismissed') === 'true';
        for (const alert of body.items) {
          alert.dismissed = state.dismissed.has(alert.id);
        }
        if (!includeDismissed) {
          body.items = body.items.filter((alert) => !alert.dismissed);
        }
        return json(route, 200, body);
      }

      case 'dismissAdminAlert': {
        const id = url.pathname.split('/').at(-2) ?? '';
        state.dismissed.add(id);
        return route.fulfill({ status: 204, body: '' });
      }

      case 'restoreAdminAlert': {
        const id = url.pathname.split('/').at(-2) ?? '';
        state.dismissed.delete(id);
        return route.fulfill({ status: 204, body: '' });
      }

      case 'getAdminUsage':
        return json(route, 200, example('getAdminUsage', 200));

      case 'getSettingsMenuBadges':
        return json(route, 200, example('getSettingsMenuBadges', 200));

      case 'listAuditEvents': {
        const body = example<{ items: AuditRow[]; page: Record<string, unknown> }>(
          'listAuditEvents',
          200,
        );
        if (options.noAuditEvents === true) {
          return json(route, 200, {
            items: [],
            page: { nextCursor: null, hasMore: false, totalCount: 0 },
          });
        }
        // Filters NARROW. They never widen: an actor the caller cannot see
        // returns the same empty page as an actor who did nothing, which is
        // `P02/E1` and is deliberately indistinguishable.
        const action = url.searchParams.get('action');
        const objectType = url.searchParams.get('objectType');
        const ipPrefix = url.searchParams.get('sourceIpPrefix');
        body.items = body.items.filter(
          (entry) =>
            (action === null || entry.action === action) &&
            (objectType === null || entry.objectType === objectType) &&
            (ipPrefix === null || (entry.sourceIp ?? '').startsWith(ipPrefix)),
        );
        return json(route, 200, body);
      }

      case 'listProgrammes': {
        const body = example<{
          items: ProgrammeRow[];
          statusCounts: Record<string, number>;
          page: Record<string, unknown>;
        }>('listProgrammes', 200);

        if (options.noProgrammes === true) {
          return json(route, 200, {
            items: [],
            statusCounts: { active: 0, paused: 0, draft: 0, archived: 0 },
            page: { nextCursor: null, hasMore: false, totalCount: 0 },
          });
        }

        const q = (url.searchParams.get('q') ?? '').toLowerCase();
        const status = url.searchParams.get('status');

        // `q` narrows the counts, `status` does not — the chips must keep
        // showing what is behind them while one of them is selected.
        const matchesQuery = body.items.filter(
          (row) =>
            q === '' ||
            row.name.toLowerCase().includes(q) ||
            (row.clientName ?? '').toLowerCase().includes(q),
        );
        const counts: Record<string, number> = { active: 0, paused: 0, draft: 0, archived: 0 };
        for (const row of matchesQuery) {
          counts[row.status] = (counts[row.status] ?? 0) + 1;
        }

        const items = matchesQuery.filter((row) => status === null || row.status === status);
        return json(route, 200, {
          items,
          statusCounts: counts,
          page: { nextCursor: null, hasMore: false, totalCount: items.length },
        });
      }

      case 'getProgramme': {
        if (options.programmeNotFound === true) {
          return json(route, 404, contractExample('getProgramme', 404));
        }
        const base = example<Record<string, unknown>>('listProgrammes', 200);
        const first = (base.items as ProgrammeRow[])[0];
        // `ProgrammeDetail` is `Programme` plus the cards. The contract gives
        // no standalone example for it, so the row is extended here with the
        // schema's own nullable card objects — every one of which is `null`
        // today because nothing owns those models yet.
        return json(route, 200, {
          ...first,
          version: 7,
          contract: null,
          operating: null,
          people: null,
        });
      }

      case 'getProgrammeKpis':
        return json(route, 200, example('getProgrammeKpis', 200));

      case 'listProgrammeAgents': {
        const body = example<{ items: { presence: string | null; displayName: string }[] }>(
          'listProgrammeAgents',
          200,
        );
        if (options.unknownSources === true) {
          for (const agent of body.items) agent.presence = null;
        }
        const q = (url.searchParams.get('q') ?? '').toLowerCase();
        if (q !== '') {
          body.items = body.items.filter((agent) =>
            agent.displayName.toLowerCase().includes(q),
          );
        }
        return json(route, 200, body);
      }

      case 'getProgrammeSkillCover': {
        const body = example<{ items: { needed: number | null }[] }>(
          'getProgrammeSkillCover',
          200,
        );
        if (options.unknownSources === true) {
          for (const item of body.items) item.needed = null;
        }
        return json(route, 200, body);
      }

      case 'getProgrammeSla':
        return json(route, 200, example('getProgrammeSla', 200));

      case 'updateProgrammeSla':
        // The contract publishes a `501` for this and every other write that is
        // not built. The screen must render it as a message, not swallow it.
        return json(route, 501, contractExample('updateProgrammeSla', 501));

      case 'listDispositions': {
        const body = example<{
          items: { id: string; active: boolean; usageCount90d: number | null }[];
        }>('listDispositions', 200);
        body.items = body.items.filter((item) => !state.removed.has(item.id));
        for (const item of body.items) {
          if (state.deactivated.has(item.id)) item.active = false;
          if (options.unknownSources === true) item.usageCount90d = null;
        }
        return json(route, 200, body);
      }

      case 'deleteDisposition': {
        const id = url.pathname.split('/').at(-1) ?? '';
        state.removed.add(id);
        return route.fulfill({ status: 204, body: '' });
      }

      case 'updateDisposition': {
        const id = url.pathname.split('/').at(-1) ?? '';
        state.deactivated.add(id);
        const body = example<{ items: Record<string, unknown>[] }>('listDispositions', 200);
        return json(route, 200, { ...body.items[0], active: false });
      }

      // ---------------------------------------------------------------------
      // Scripts, retention, portal users and archive — P02/B6..B9
      // ---------------------------------------------------------------------

      case 'listProgrammeScripts':
        return json(
          route,
          200,
          example('listProgrammeScripts', 200, options.noScripts === true ? 'empty' : 'default'),
        );

      case 'getProgrammeRetention': {
        const body = example<Record<string, number | string | boolean>>(
          'getProgrammeRetention',
          200,
        );
        for (const [field, value] of state.retention) {
          body[field] = value;
        }
        return json(route, 200, body);
      }

      case 'updateProgrammeRetention': {
        const body = request.postDataJSON() as Record<string, number | string | boolean>;
        state.requests.push({ operationId: 'updateProgrammeRetention', body });
        if (options.retentionLegalHold === true) {
          return json(route, 409, contractExample('updateProgrammeRetention', 409, 'legalHold'));
        }
        if (options.retentionWritable !== true) {
          // The published answer today. M21 owns the retention model and it is
          // unassigned; the screen has to render the 501 rather than pretend.
          return json(route, 501, contractExample('updateProgrammeRetention', 501));
        }
        const saved = example<Record<string, number | string | boolean>>(
          'getProgrammeRetention',
          200,
        );
        for (const [field, value] of Object.entries(body)) {
          if (field === 'version') continue;
          state.retention.set(field, value);
          saved[field] = value;
        }
        saved['version'] = Number(body['version']) + 1;
        state.retention.set('version', saved['version']);
        return json(route, 200, saved);
      }

      case 'listPortalUsers':
        // `default` (`items: []`) is the DESIGNED state; `invited` is the
        // contract's one-row example, so the non-empty row renders.
        return json(
          route,
          200,
          example('listPortalUsers', 200, options.portalUsers === true ? 'invited' : 'default'),
        );

      case 'getProgrammeArchivePreview': {
        const body = example<{ retentionSummary: string | null }>(
          'getProgrammeArchivePreview',
          200,
        );
        if (options.archiveRetentionUnknown === true) body.retentionSummary = null;
        return json(route, 200, body);
      }

      case 'archiveProgramme': {
        state.requests.push({
          operationId: 'archiveProgramme',
          body: request.postDataJSON() as unknown,
        });
        // The `programme` table has no status column, so there is nothing to
        // archive yet. The published answer is `501` and the dialog shows it.
        return json(route, 501, contractExample('archiveProgramme', 501));
      }

      // ---------------------------------------------------------------------
      // Roles — P02/C, C1, C2, C3
      // ---------------------------------------------------------------------

      case 'listRoles': {
        const body = example<{ version: number; items: RoleRow[] }>('listRoles', 200);
        body.items = body.items.filter((role) => !state.deletedRoles.has(role.id));
        for (const role of body.items) {
          const moved = state.roleParents.get(role.id);
          if (moved !== undefined) role.parentRoleId = moved;
        }
        return json(route, 200, body);
      }

      case 'getRole': {
        // `RoleDetail` is `Role` plus `seesRecordsOwnedBy`, and the contract
        // publishes no standalone example for it — the same situation as
        // `ProgrammeDetail`. The descendants are DERIVED from the list example
        // rather than invented, because the one thing this panel must not do
        // is show a visibility claim the hierarchy does not support.
        const roleId = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
        const body = example<{ items: RoleRow[] }>('listRoles', 200);
        const roles = body.items.filter((role) => !state.deletedRoles.has(role.id));
        for (const role of roles) {
          const moved = state.roleParents.get(role.id);
          if (moved !== undefined) role.parentRoleId = moved;
        }
        const role = roles.find((candidate) => candidate.id === roleId);
        if (role === undefined) return json(route, 404, contractExample('getRole', 404));

        const descendants: RoleRow[] = [];
        const walk = (parentId: string): void => {
          for (const child of roles.filter((candidate) => candidate.parentRoleId === parentId)) {
            descendants.push(child);
            walk(child.id);
          }
        };
        walk(role.id);

        return json(route, 200, {
          ...role,
          seesRecordsOwnedBy: {
            roleCount: descendants.length,
            userCount: descendants.reduce((total, child) => total + child.userCount, 0),
            sample: descendants.slice(0, 3).map((child) => ({ id: child.id, name: child.name })),
          },
        });
      }

      case 'updateRoleHierarchy': {
        const body = request.postDataJSON() as { moves?: { roleId: string; parentRoleId: string | null }[] };
        state.requests.push({ operationId: 'updateRoleHierarchy', body });
        if (options.roleCycle === true) {
          // Nothing is applied — not the valid moves either.
          return json(route, 409, contractExample('updateRoleHierarchy', 409, 'cycle'));
        }
        if (options.rolesWritable !== true) {
          return json(route, 501, contractExample('updateRoleHierarchy', 501));
        }
        for (const move of body.moves ?? []) state.roleParents.set(move.roleId, move.parentRoleId);
        const list = example<{ version: number; items: RoleRow[] }>('listRoles', 200);
        list.version += 1;
        for (const role of list.items) {
          const moved = state.roleParents.get(role.id);
          if (moved !== undefined) role.parentRoleId = moved;
        }
        return json(route, 200, list);
      }

      case 'deleteRole': {
        const roleId = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
        state.requests.push({ operationId: 'deleteRole', body: url.search });
        if (options.rolesWritable !== true) {
          return json(route, 501, contractExample('deleteRole', 501));
        }
        state.deletedRoles.add(roleId);
        return route.fulfill({ status: 204, body: '' });
      }

      // ---------------------------------------------------------------------
      // Field-level security — P02/D, D1, D2
      // ---------------------------------------------------------------------

      case 'listFieldSecurityObjects':
        return json(route, 200, example('listFieldSecurityObjects', 200));

      case 'listPermissionSets':
        return json(route, 200, example('listPermissionSets', 200));

      case 'getFieldSecurityMatrix': {
        const body = example<MatrixBody>('getFieldSecurityMatrix', 200);
        // `q` and `sensitiveOnly` are SERVER filters per the contract, so the
        // mock applies them here rather than letting the screen filter and
        // quietly disagree with the footer's "N of M fields".
        const q = (url.searchParams.get('q') ?? '').toLowerCase();
        const sensitiveOnly = url.searchParams.get('sensitiveOnly') === 'true';
        for (const row of body.rows) {
          for (const cell of row.cells) {
            const saved = state.fieldSecurity.get(`${row.fieldApiName}\u0000${cell.permissionSetId}`);
            if (saved !== undefined) cell.level = saved;
          }
        }
        body.version += state.fieldSecurity.size === 0 ? 0 : 1;
        body.rows = body.rows.filter(
          (row) =>
            (q === '' ||
              row.label.toLowerCase().includes(q) ||
              row.fieldApiName.toLowerCase().includes(q)) &&
            (!sensitiveOnly || row.classification !== 'none'),
        );
        return json(route, 200, body);
      }

      case 'updateFieldSecurityMatrix': {
        const body = request.postDataJSON() as {
          version: number;
          changes: { fieldApiName: string; permissionSetId: string; level: string }[];
        };
        state.requests.push({ operationId: 'updateFieldSecurityMatrix', body });
        if (options.fieldSecurityStale === true) {
          return json(route, 409, contractExample('updateFieldSecurityMatrix', 409, 'stale'));
        }
        if (options.fieldSecurityWritable !== true) {
          // The published answer today. D-P9 settled what a triple MEANS; the
          // endpoint is still not built, and the screen must render that.
          return json(route, 501, contractExample('updateFieldSecurityMatrix', 501));
        }
        for (const change of body.changes) {
          state.fieldSecurity.set(
            `${change.fieldApiName}\u0000${change.permissionSetId}`,
            change.level,
          );
        }
        const applied = example<MatrixBody>('getFieldSecurityMatrix', 200);
        applied.version = body.version + 1;
        for (const row of applied.rows) {
          for (const cell of row.cells) {
            const saved = state.fieldSecurity.get(`${row.fieldApiName}\u0000${cell.permissionSetId}`);
            if (saved !== undefined) cell.level = saved;
          }
        }
        return json(route, 200, applied);
      }

      // ---------------------------------------------------------------------
      // Audit log — P02/E, E1, E2
      // ---------------------------------------------------------------------

      case 'getAuditFilterOptions':
        return json(route, 200, example('getAuditFilterOptions', 200));

      case 'createAuditExport': {
        state.requests.push({
          operationId: 'createAuditExport',
          body: request.postDataJSON() as unknown,
        });
        return options.auditExportAccepted === true
          ? json(route, 202, contractExample('createAuditExport', 202))
          : json(route, 501, contractExample('createAuditExport', 501));
      }

      default: {
        // Anything else in the contract that a screen in this build reaches for
        // gets its published `501`. Loudly, so a screen calling something it
        // was not designed to call is visible rather than silently empty.
        const bodies = operation.responses['501'];
        if (bodies !== undefined) {
          return json(route, 501, contractExample(operation.operationId as AdminOperationId, 501));
        }
        throw new Error(
          `${operation.operationId} has no handler in the admin mock and publishes no 501.`,
        );
      }
    }
  });

  return state;
}
