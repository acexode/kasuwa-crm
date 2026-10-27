import { Delete, Get, HttpCode, HttpStatus, Param, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { currentTx } from '../../tenancy/tenant-context';
import { AdminController } from '../common/admin-controller.decorator';
import { foundOr404, parseIdOr404, parseOr400 } from '../common/admin-input';
import * as repo from './home.repository';
import {
  currentBillingPeriod,
  dataRegionForCell,
  deriveSetupHealth,
  localeCountry,
  rollUpBadges,
  type Badge,
  type SetupHealth,
  type Severity,
} from './home.rules';

const AlertIdParam = z.object({ alertId: z.uuid() });

/** `includeDismissed` arrives as text; anything but `true`/`false` is a 400. */
const ListAlertsQuery = z.strictObject({ includeDismissed: z.enum(['true', 'false']).optional() });

export interface AdminHomeSummaryResponse {
  tenant: {
    id: string;
    name: string;
    planName: string;
    countryCount: number;
    userCount: number;
  };
  dataRegion: { code: string; displayName: string };
  health: SetupHealth;
}

export interface AdminAlertResponse {
  id: string;
  severity: Severity;
  category: string;
  title: string;
  body: string;
  sourceLabel: string | null;
  raisedAt: string;
  actionLabel: string | null;
  settingId: string | null;
  dismissed: boolean;
}

interface Money {
  amountMinor: string;
  currency: string;
  estimatedTotalMinor?: string | null;
}

export interface UsageMeter {
  meterId: string;
  label: string;
  unit: string;
  used: number;
  limit: number | null;
  warnAtPercent: number | null;
  note: string | null;
  spend: Money | null;
}

/**
 * The admin home API — T-0031 (P02/A, P02/A1).
 *
 * Contract: docs/api/admin.openapi.yaml, tag `admin-home`. Six operations,
 * each named on its handler. No handler reads a tenant or programme id from
 * the request: scope is `currentTx().session`, resolved from `user_programme`.
 * The only identifier accepted is `{alertId}`, a record id looked up under
 * that scope, and anything it cannot reach — another tenant's alert, an
 * unassigned sibling programme's, nothing at all, or not a uuid — is the one
 * `404 not_found` body.
 *
 * Every number on this page is computed over rows the session reaches (see
 * home.repository.ts for the definition of "reachable users", D-L47).
 *
 * Not built, and said so in the completion report: plan, operating countries
 * and the three non-seat usage meters have no data behind them (M23 billing is
 * unowned); `planName` is `Trial` for a trial tenant and otherwise empty, and
 * `countryCount` is derived from the locales of reachable users and the tenant
 * default.
 */
// The badges endpoint sits under `settings-menu/` and so has its own class,
// `SettingsMenuBadgesController`, below; the spec tags all six `admin-home`.
@AdminController('api/v1/admin/home')
export class AdminHomeController {
  /** `GET /api/v1/admin/home/summary` — operationId `getAdminHomeSummary`. 200 · 401. */
  @Get('summary')
  async summary(): Promise<AdminHomeSummaryResponse> {
    const tx = currentTx();
    // The session resolved, so the tenant row exists under RLS; a miss means
    // it vanished mid-request. Same body as any other miss.
    const tenant = foundOr404(await repo.findTenantHeader(tx));
    const users = await repo.reachableUserStats(tx);
    const alerts = await repo.reachableAlertSeverityCounts(tx);

    const countries = new Set(
      [tenant.localeDefault, ...users.locales]
        .map(localeCountry)
        .filter((country): country is string => country !== null),
    );

    return {
      tenant: {
        id: tenant.id,
        name: tenant.name,
        // Empty, not English copy, while no plan is stored: the screen leaves it
        // out (T-0143). Null would be the better contract, but the committed
        // acceptance suite asserts a string; see the T-0143 report.
        planName: tenant.status === 'trial' ? 'Trial' : '',
        countryCount: countries.size,
        userCount: users.userCount,
      },
      dataRegion: dataRegionForCell(tenant.regionCell),
      health: deriveSetupHealth({ usersWithoutMfa: users.usersWithoutMfa, ...alerts }, new Date()),
    };
  }

  /** `GET /api/v1/admin/home/alerts` — operationId `listAdminAlerts`. 200 · 400 · 401. */
  @Get('alerts')
  async alerts(@Query() query: unknown): Promise<{ items: AdminAlertResponse[] }> {
    const parsed = parseOr400(ListAlertsQuery, query);
    const rows = await repo.listAlerts(currentTx(), parsed.includeDismissed === 'true');
    return {
      items: rows.map((row) => ({
        id: row.id,
        severity: row.severity,
        category: row.category,
        title: row.title,
        body: row.body,
        sourceLabel: row.sourceLabel,
        raisedAt: row.raisedAt.toISOString(),
        actionLabel: row.actionLabel,
        settingId: row.settingId,
        dismissed: row.dismissed,
      })),
    };
  }

  /**
   * `PUT /api/v1/admin/home/alerts/{alertId}/dismissal` — operationId
   * `dismissAdminAlert`. 204 · 401 · 404. Idempotent. Not audited
   * (`x-kasuwa-audited: false`): it changes nothing anyone else can see.
   */
  @Put('alerts/:alertId/dismissal')
  @HttpCode(HttpStatus.NO_CONTENT)
  async dismiss(@Param() params: unknown): Promise<void> {
    const tx = currentTx();
    const { alertId } = parseIdOr404(AlertIdParam, params);
    const alert = foundOr404(await repo.findReachableAlert(tx, alertId));
    await repo.insertDismissal(tx, alert);
  }

  /**
   * `DELETE /api/v1/admin/home/alerts/{alertId}/dismissal` — operationId
   * `restoreAdminAlert`. 204 · 401 · 404. Restoring a reachable alert this
   * user never dismissed is an idempotent 204 (D-L47).
   */
  @Delete('alerts/:alertId/dismissal')
  @HttpCode(HttpStatus.NO_CONTENT)
  async restore(@Param() params: unknown): Promise<void> {
    const tx = currentTx();
    const { alertId } = parseIdOr404(AlertIdParam, params);
    const alert = foundOr404(await repo.findReachableAlert(tx, alertId));
    await repo.deleteDismissal(tx, alert);
  }

  /**
   * `GET /api/v1/admin/home/usage` — operationId `getAdminUsage`. 200 · 401.
   * Seats only: the other meters (conversations, storage, AI credits) have no
   * data source until M23 exists, and a zero would be a fabricated number.
   */
  @Get('usage')
  async usage(): Promise<{ periodStart: string; periodEnd: string; meters: UsageMeter[] }> {
    const users = await repo.reachableUserStats(currentTx());
    return {
      ...currentBillingPeriod(new Date()),
      meters: [
        {
          meterId: 'seats',
          label: 'Seats',
          unit: 'seat',
          used: users.userCount,
          limit: null,
          warnAtPercent: null,
          note: null,
          spend: null,
        },
      ],
    };
  }
}

/**
 * The settings-menu badges — T-0031 (P02/A1). Only the numbers: the menu
 * structure is the client's. Counts open (not dismissed by this user)
 * reachable alerts that name a `settingId`, one badge per item, carrying the
 * most severe severity among them.
 */
@AdminController('api/v1/admin/settings-menu')
export class SettingsMenuBadgesController {
  /** `GET /api/v1/admin/settings-menu/badges` — operationId `getSettingsMenuBadges`. 200 · 401. */
  @Get('badges')
  async badges(): Promise<{ badges: Badge[] }> {
    return { badges: rollUpBadges(await repo.badgeGroups(currentTx())) };
  }
}
