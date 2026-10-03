/**
 * The pure parts of the admin home (T-0031): the setup-health rules, the
 * badge roll-up, the billing period and the cell-to-region table.
 *
 * Kept free of I/O so each rule is unit-tested without a database, and so the
 * one implementation of the health score lives on the server (the spec: "the
 * client must not compute it").
 *
 * Every number fed into these functions has already been computed over rows
 * the caller's session can reach (home.repository.ts). Nothing here widens or
 * narrows scope; it only shapes.
 */

export type Severity = 'info' | 'success' | 'warning' | 'danger';
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'todo';

export interface HealthCheck {
  checkId: string;
  label: string;
  status: CheckStatus;
  points: number;
  settingId: string | null;
}

export interface SetupHealth {
  score: number;
  outOf: number;
  pointsAvailable: number;
  checkedAt: string;
  checks: HealthCheck[];
}

/** Inputs to the health rules, all counted over the caller's reachable rows. */
export interface HealthInputs {
  /** Reachable users with no confirmed MFA factor. */
  usersWithoutMfa: number;
  /** Reachable alerts at severity `danger`, regardless of who dismissed them. */
  dangerAlerts: number;
  /** Reachable alerts at severity `warning`, regardless of who dismissed them. */
  warningAlerts: number;
}

/**
 * The rule set and what each is worth. Weights sum to `HEALTH_OUT_OF`.
 *
 * No PRD module owns these (spec, getAdminHomeSummary: "Nobody owns the health
 * rules"). These three are the ones computable from data Kasuwa holds today;
 * they are named in the T-0031 completion report as a placeholder set for
 * whoever takes ownership.
 */
export const HEALTH_WEIGHTS = {
  users_without_mfa: 40,
  open_critical_alerts: 35,
  open_warning_alerts: 25,
} as const;

export const HEALTH_OUT_OF = Object.values(HEALTH_WEIGHTS).reduce((sum, value) => sum + value, 0);

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function check(
  checkId: keyof typeof HEALTH_WEIGHTS,
  failing: boolean,
  failStatus: Exclude<CheckStatus, 'pass'>,
  label: string,
  settingId: string | null,
): HealthCheck {
  return {
    checkId,
    label,
    status: failing ? failStatus : 'pass',
    // "Points gained by fixing it. Zero when passing."
    points: failing ? HEALTH_WEIGHTS[checkId] : 0,
    settingId,
  };
}

/**
 * Derives the setup-health card. `score` is the sum of the passing rules'
 * weights; `pointsAvailable` is what fixing every failing rule would recover,
 * so `score + pointsAvailable === outOf` always.
 */
export function deriveSetupHealth(inputs: HealthInputs, checkedAt: Date): SetupHealth {
  const checks = [
    check(
      'users_without_mfa',
      inputs.usersWithoutMfa > 0,
      'warn',
      inputs.usersWithoutMfa > 0
        ? plural(inputs.usersWithoutMfa, 'user without MFA', 'users without MFA')
        : 'Every user signs in with MFA',
      'u-mfa',
    ),
    check(
      'open_critical_alerts',
      inputs.dangerAlerts > 0,
      'fail',
      inputs.dangerAlerts > 0
        ? plural(inputs.dangerAlerts, 'critical alert open', 'critical alerts open')
        : 'No critical alerts',
      null,
    ),
    check(
      'open_warning_alerts',
      inputs.warningAlerts > 0,
      'warn',
      inputs.warningAlerts > 0
        ? plural(inputs.warningAlerts, 'warning open', 'warnings open')
        : 'No open warnings',
      null,
    ),
  ];
  const pointsAvailable = checks.reduce((sum, item) => sum + item.points, 0);
  return {
    score: HEALTH_OUT_OF - pointsAvailable,
    outOf: HEALTH_OUT_OF,
    pointsAvailable,
    checkedAt: checkedAt.toISOString(),
    checks,
  };
}

const SEVERITY_RANK: Record<Severity, number> = { success: 0, info: 1, warning: 2, danger: 3 };

export interface BadgeGroup {
  settingId: string;
  severity: Severity;
  count: number;
}

export interface Badge {
  settingId: string;
  count: number;
  severity: Severity;
}

/**
 * Rolls per-(settingId, severity) counts into one badge per settingId,
 * carrying the most severe severity among them. A zero count is never sent:
 * "Absent means no badge" (SettingsMenuBadges, `count` minimum 1).
 */
export function rollUpBadges(groups: readonly BadgeGroup[]): Badge[] {
  const bySetting = new Map<string, Badge>();
  for (const group of groups) {
    if (group.count < 1) continue;
    const existing = bySetting.get(group.settingId);
    if (existing === undefined) {
      bySetting.set(group.settingId, { ...group });
      continue;
    }
    existing.count += group.count;
    if (SEVERITY_RANK[group.severity] > SEVERITY_RANK[existing.severity]) {
      existing.severity = group.severity;
    }
  }
  return [...bySetting.values()].sort((left, right) =>
    left.settingId < right.settingId ? -1 : left.settingId > right.settingId ? 1 : 0,
  );
}

/**
 * The current billing period: the UTC calendar month containing `now`,
 * half-open. M23 (billing) has no owner yet; a calendar month is the
 * placeholder until a subscription row says otherwise.
 */
export function currentBillingPeriod(now: Date): { periodStart: string; periodEnd: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { periodStart: start.toISOString(), periodEnd: end.toISOString() };
}

/**
 * Where a cell's data lives. A fact about the deployment, not the tenant
 * (AdminHomeSummary.dataRegion). An unknown cell is reported as itself rather
 * than guessed at.
 */
const CELL_REGIONS: Record<string, { code: string; displayName: string }> = {
  'za-1': { code: 'af-south-1', displayName: 'South Africa' },
};

export function dataRegionForCell(cell: string): { code: string; displayName: string } {
  return CELL_REGIONS[cell] ?? { code: cell, displayName: cell };
}

/**
 * The country part of a BCP 47 locale (`en-NG` -> `NG`), or null. Used as the
 * proxy for `countryCount` until tenants record operating countries.
 */
export function localeCountry(locale: string): string | null {
  const region = locale.split('-')[1];
  if (region === undefined || !/^[A-Za-z]{2}$/.test(region)) return null;
  // en-XA is the pseudo-locale (pnpm i18n:pseudo), not a country.
  return region.toUpperCase() === 'XA' ? null : region.toUpperCase();
}
