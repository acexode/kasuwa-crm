import type { TenantTx } from '@kasuwa/db';
import type { BadgeGroup, HealthInputs, Severity } from './home.rules';

/**
 * SQL for the admin home (T-0031).
 *
 * tenancy-reviewed: every statement carries an explicit `tenant_id` predicate
 * bound to `tx.session.tenantId`, and every statement over admin_alert or
 * admin_alert_dismissal an explicit programme predicate (the session's
 * programme list, or the reachable alert's own programme), IN ADDITION to the
 * RLS policy on the table — two independent layers, so a typo in one does not
 * leak (CLAUDE.md 2.3). Nothing here reads a tenant or programme id from the
 * request.
 *
 * Every function takes the request's `TenantTx` and reads scope from
 * `tx.session` — resolved by withTenantTransaction from `user_programme`,
 * never from the request. Each statement repeats the tenant and programme
 * predicates explicitly on top of RLS (CLAUDE.md 2.3): a count is the easiest
 * place to leak, so a typo in either layer must not be enough.
 *
 * "Reachable users" (D-L47): the distinct users of the caller's tenant who
 * hold a `user_programme` row in at least one programme the caller holds. The
 * caller is always reachable; a caller with no programme reaches only
 * themselves. `user` and `user_programme` are tenant-scoped only under RLS, so
 * the programme filter here is the ONLY thing narrowing these counts below
 * tenant-wide — it is not belt and braces, it is the belt.
 */

const REACHABLE_USERS_CTE = `
  reachable AS (
    SELECT u.id, u.locale
      FROM "user" u
     WHERE u.tenant_id = $1
       AND (
         u.id = $2
         OR EXISTS (
           SELECT 1
             FROM user_programme up
            WHERE up.tenant_id = $1
              AND up.user_id = u.id
              AND up.programme_id = ANY ($3::uuid[])
         )
       )
  )
`;

function scopeParams(tx: TenantTx): [string, string, string[]] {
  return [tx.session.tenantId, tx.session.userId, [...tx.session.programmeIds]];
}

export interface TenantHeader {
  id: string;
  name: string;
  status: string;
  regionCell: string;
  localeDefault: string;
}

export async function findTenantHeader(tx: TenantTx): Promise<TenantHeader | null> {
  const rows = await tx.query<{
    id: string;
    name: string;
    status: string;
    region_cell: string;
    locale_default: string;
  }>(`SELECT id, name, status, region_cell, locale_default FROM tenant WHERE id = $1`, [
    tx.session.tenantId,
  ]);
  const row = rows[0];
  return row === undefined
    ? null
    : {
        id: row.id,
        name: row.name,
        status: row.status,
        regionCell: row.region_cell,
        localeDefault: row.locale_default,
      };
}

export interface ReachableUserStats {
  userCount: number;
  usersWithoutMfa: number;
  locales: string[];
}

/** `tenant.userCount`, `seats.used` and the MFA health input, in one round trip. */
export async function reachableUserStats(tx: TenantTx): Promise<ReachableUserStats> {
  const rows = await tx.query<{
    user_count: number;
    without_mfa: number;
    locales: string[] | null;
  }>(
    `WITH ${REACHABLE_USERS_CTE}
     SELECT (SELECT count(*) FROM reachable)::int AS user_count,
            (SELECT count(*)
               FROM reachable r
              WHERE NOT EXISTS (
                SELECT 1
                  FROM user_mfa_factor f
                 WHERE f.tenant_id = $1
                   AND f.user_id = r.id
                   AND f.confirmed_at IS NOT NULL
              ))::int AS without_mfa,
            (SELECT array_agg(DISTINCT r.locale) FROM reachable r) AS locales`,
    scopeParams(tx),
  );
  const row = rows[0];
  return {
    userCount: row?.user_count ?? 0,
    usersWithoutMfa: row?.without_mfa ?? 0,
    locales: row?.locales ?? [],
  };
}

/** Reachable alerts by severity, for the health rules. Dismissal is per user and ignored here. */
export async function reachableAlertSeverityCounts(
  tx: TenantTx,
): Promise<Pick<HealthInputs, 'dangerAlerts' | 'warningAlerts'>> {
  const [tenantId, , programmeIds] = scopeParams(tx);
  const rows = await tx.query<{ severity: Severity; count: number }>(
    `SELECT a.severity, count(*)::int AS count
       FROM admin_alert a
      WHERE a.tenant_id = $1
        AND a.programme_id = ANY ($2::uuid[])
      GROUP BY a.severity`,
    [tenantId, programmeIds],
  );
  const count = (severity: Severity) => rows.find((row) => row.severity === severity)?.count ?? 0;
  return { dangerAlerts: count('danger'), warningAlerts: count('warning') };
}

export interface AlertRow {
  id: string;
  severity: Severity;
  category: string;
  title: string;
  body: string;
  sourceLabel: string | null;
  raisedAt: Date;
  actionLabel: string | null;
  settingId: string | null;
  dismissed: boolean;
}

/** The alert card: reachable alerts, newest first, with this user's dismissal state. */
export async function listAlerts(tx: TenantTx, includeDismissed: boolean): Promise<AlertRow[]> {
  const [tenantId, userId, programmeIds] = scopeParams(tx);
  const rows = await tx.query<{
    id: string;
    severity: Severity;
    category: string;
    title: string;
    body: string;
    source_label: string | null;
    raised_at: Date;
    action_label: string | null;
    setting_id: string | null;
    dismissed: boolean;
  }>(
    `SELECT a.id, a.severity, a.category, a.title, a.body, a.source_label,
            a.raised_at, a.action_label, a.setting_id,
            (d.alert_id IS NOT NULL) AS dismissed
       FROM admin_alert a
       LEFT JOIN admin_alert_dismissal d
              ON d.alert_id = a.id
             AND d.tenant_id = a.tenant_id
             AND d.programme_id = a.programme_id
             AND d.user_id = $2
      WHERE a.tenant_id = $1
        AND a.programme_id = ANY ($3::uuid[])
        AND ($4::boolean OR d.alert_id IS NULL)
      ORDER BY a.raised_at DESC, a.id`,
    [tenantId, userId, programmeIds, includeDismissed],
  );
  return rows.map((row) => ({
    id: row.id,
    severity: row.severity,
    category: row.category,
    title: row.title,
    body: row.body,
    sourceLabel: row.source_label,
    raisedAt: row.raised_at,
    actionLabel: row.action_label,
    settingId: row.setting_id,
    dismissed: row.dismissed,
  }));
}

/** A reachable alert's programme, or null for anything else (foreign, unassigned, absent). */
export async function findReachableAlert(
  tx: TenantTx,
  alertId: string,
): Promise<{ id: string; programmeId: string } | null> {
  const [tenantId, , programmeIds] = scopeParams(tx);
  const rows = await tx.query<{ id: string; programme_id: string }>(
    `SELECT a.id, a.programme_id
       FROM admin_alert a
      WHERE a.id = $1
        AND a.tenant_id = $2
        AND a.programme_id = ANY ($3::uuid[])`,
    [alertId, tenantId, programmeIds],
  );
  const row = rows[0];
  return row === undefined ? null : { id: row.id, programmeId: row.programme_id };
}

/** Idempotent: a second dismissal by the same user is a no-op, not a second row. */
export async function insertDismissal(
  tx: TenantTx,
  alert: { id: string; programmeId: string },
): Promise<void> {
  await tx.query(
    `INSERT INTO admin_alert_dismissal (alert_id, user_id, tenant_id, programme_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (alert_id, user_id) DO NOTHING`,
    [alert.id, tx.session.userId, tx.session.tenantId, alert.programmeId],
  );
}

/** Idempotent: restoring a never-dismissed alert deletes nothing (D-L47). */
export async function deleteDismissal(
  tx: TenantTx,
  alert: { id: string; programmeId: string },
): Promise<void> {
  await tx.query(
    `DELETE FROM admin_alert_dismissal
      WHERE alert_id = $1
        AND user_id = $2
        AND tenant_id = $3
        AND programme_id = $4`,
    [alert.id, tx.session.userId, tx.session.tenantId, alert.programmeId],
  );
}

/**
 * Open (not dismissed by this user) reachable alerts that point at a settings
 * item, grouped for the badge roll-up.
 */
export async function badgeGroups(tx: TenantTx): Promise<BadgeGroup[]> {
  const [tenantId, userId, programmeIds] = scopeParams(tx);
  const rows = await tx.query<{ setting_id: string; severity: Severity; count: number }>(
    `SELECT a.setting_id, a.severity, count(*)::int AS count
       FROM admin_alert a
       LEFT JOIN admin_alert_dismissal d
              ON d.alert_id = a.id
             AND d.tenant_id = a.tenant_id
             AND d.programme_id = a.programme_id
             AND d.user_id = $2
      WHERE a.tenant_id = $1
        AND a.programme_id = ANY ($3::uuid[])
        AND a.setting_id IS NOT NULL
        AND d.alert_id IS NULL
      GROUP BY a.setting_id, a.severity`,
    [tenantId, userId, programmeIds],
  );
  return rows.map((row) => ({
    settingId: row.setting_id,
    severity: row.severity,
    count: row.count,
  }));
}
