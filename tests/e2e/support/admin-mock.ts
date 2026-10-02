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
}

interface MockState {
  readonly dismissed: Set<string>;
  readonly removed: Set<string>;
  readonly deactivated: Set<string>;
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

function example<T>(operationId: AdminOperationId, status: number): T {
  return clone(contractExample(operationId, status) as T);
}

interface ProgrammeRow {
  id: string;
  name: string;
  clientName?: string | null;
  status: string;
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

      case 'listAuditEvents':
        return json(route, 200, example('listAuditEvents', 200));

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
