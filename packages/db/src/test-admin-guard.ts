/**
 * `kasuwa_test_admin` must be unusable in a real cell (T-0117, D-L92, D-L94).
 *
 * Fourteen applied migrations GRANT to or REVOKE from the role by name, so it
 * has to exist wherever they run, and applied migrations are never edited.
 * `bootstrap.sql` therefore creates it as an INERT placeholder: NOLOGIN,
 * NOBYPASSRLS, NOINHERIT, no password, a member of nothing, with no members.
 * It holds what the migrations grant it, and nobody can use that.
 * `bootstrap-test.sql`, applied only by docker-compose's init directory and
 * by `packages/testing`, turns it into the harness's BYPASSRLS login.
 *
 * Two places refuse a usable role outside development and test:
 *   - the migration runner, at every migration (`runMigrations`);
 *   - the API and the worker, at every boot, on the app pool
 *     (`refuseUsableTestAdminAtBoot`), because a role made a login after the
 *     last migration would otherwise go unnoticed until the next one.
 *
 * WHAT "USABLE" MEANS IS WHAT THE CONNECTED ROLE CAN SEE (D-L94 R4):
 * `pg_roles` and `pg_auth_members`, which every role may read. Whether a
 * NOLOGIN role has a password is in `pg_authid`, which only a superuser may
 * read, so a password alone is not refused here; a password is useless
 * without LOGIN, and LOGIN is refused.
 *
 * MEMBERSHIPS COUNT ONLY IF THEY CAN BE USED (lead ruling on T-0117). On
 * managed Postgres (RDS, Cloud SQL) the provisioning admin is CREATEROLE, not
 * a superuser, and PostgreSQL 16 records it as an ADMIN-only member of every
 * role it creates: `admin_option` true, `inherit_option` and `set_option`
 * false. Such a membership lets its holder manage the role's memberships but
 * never become the role or use its privileges, so it is ignored. A membership
 * with SET or INHERIT, in either direction, is refused.
 *
 * Beyond the four D-L94 names (LOGIN, BYPASSRLS, a member, a membership) the
 * other role powers are refused too (SUPERUSER, CREATEROLE, CREATEDB,
 * REPLICATION): the placeholder is meant to have none, and any of them on a
 * role nobody is supposed to touch is a reason to stop, not to proceed.
 * NOINHERIT is not checked: with no memberships it changes nothing.
 *
 * A role that does not exist at all is not refused: nothing can use it.
 */

export const TEST_ADMIN_ROLE = 'kasuwa_test_admin';

/** The one thing these checks need from a pg Client or Pool. */
export interface CatalogueReader {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Row[] }>;
}

interface TestAdminRow extends Record<string, unknown> {
  rolcanlogin: boolean;
  rolbypassrls: boolean;
  rolsuper: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolreplication: boolean;
  has_members: boolean;
  is_member: boolean;
}

/**
 * PostgreSQL 16 or later: `inherit_option` and `set_option` are new in 16.
 *
 * Catalogue only. Reads no table, sets nothing, leaves nothing on the
 * connection, so it may run on a pooled app connection outside a tenant
 * transaction, as the T-0049 pool-identity check does.
 */
const TEST_ADMIN_SQL = `
  SELECT r.rolcanlogin, r.rolbypassrls, r.rolsuper, r.rolcreaterole, r.rolcreatedb,
         r.rolreplication,
         EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m
                  WHERE m.roleid = r.oid AND (m.inherit_option OR m.set_option)) AS has_members,
         EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m
                  WHERE m.member = r.oid AND (m.inherit_option OR m.set_option)) AS is_member
    FROM pg_catalog.pg_roles r
   WHERE r.rolname = $1`;

/** Why the role is usable, as short phrases; empty when it is inert or absent. */
export function testAdminUsabilityReasons(row: TestAdminRow | undefined): string[] {
  if (row === undefined) {
    return [];
  }
  const reasons: string[] = [];
  if (row.rolcanlogin) reasons.push('it can log in (LOGIN)');
  if (row.rolbypassrls) reasons.push('it bypasses row-level security (BYPASSRLS)');
  if (row.rolsuper) reasons.push('it is a superuser');
  if (row.rolcreaterole) reasons.push('it has CREATEROLE');
  if (row.rolcreatedb) reasons.push('it has CREATEDB');
  if (row.rolreplication) reasons.push('it has REPLICATION');
  if (row.has_members) reasons.push('another role is a member of it (with SET or INHERIT)');
  if (row.is_member) reasons.push('it is a member of another role (with SET or INHERIT)');
  return reasons;
}

/** Reads the role from the catalogue and says why it is usable, if it is. */
export async function readTestAdminUsability(reader: CatalogueReader): Promise<string[]> {
  const result = await reader.query<TestAdminRow>(TEST_ADMIN_SQL, [TEST_ADMIN_ROLE]);
  return testAdminUsabilityReasons(result.rows[0]);
}

/**
 * Thrown when `kasuwa_test_admin` is usable where it must be inert. Names the
 * role, the environment and the reasons; never a URL or a password.
 */
export class UsableTestAdminError extends Error {
  constructor(context: string, nodeEnv: string, reasons: readonly string[]) {
    super(
      `${context}: NODE_ENV=${nodeEnv} and the role ${TEST_ADMIN_ROLE} is usable: ` +
        `${reasons.join('; ')}. It is a test-only role (D-L92, D-L94). Outside ` +
        `development and test it must be the inert placeholder bootstrap.sql creates ` +
        `(NOLOGIN NOBYPASSRLS, no membership with SET or INHERIT either way), and ` +
        `bootstrap-test.sql must never be applied to this database. As a superuser: ` +
        `ALTER ROLE ${TEST_ADMIN_ROLE} NOLOGIN NOBYPASSRLS PASSWORD NULL, and revoke ` +
        `every membership with SET or INHERIT it has in either direction.`,
    );
    this.name = 'UsableTestAdminError';
  }
}

/** True for the environments where the test role may be live. */
export function testAdminMayBeLive(nodeEnv: string): boolean {
  return nodeEnv === 'development' || nodeEnv === 'test';
}

/**
 * The boot check for the API and the worker (T-0117, D-L94 addendum). Outside
 * development and test, rejects with `UsableTestAdminError` when
 * `kasuwa_test_admin` is usable. Read on the app pool: `pg_roles` and
 * `pg_auth_members` are readable by kasuwa_app.
 */
export async function refuseUsableTestAdminAtBoot(
  reader: CatalogueReader,
  nodeEnv: string,
): Promise<void> {
  if (testAdminMayBeLive(nodeEnv)) {
    return;
  }
  const reasons = await readTestAdminUsability(reader);
  if (reasons.length > 0) {
    throw new UsableTestAdminError('Refusing to start', nodeEnv, reasons);
  }
}
