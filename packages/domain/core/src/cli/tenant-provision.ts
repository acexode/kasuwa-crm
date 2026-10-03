import { parseArgs } from 'node:util';
import { env } from '@kasuwa/config';
import { provisionTenant, TENANT_REGIONS, type TenantRegion } from '../tenant/provision-tenant';

/**
 * `pnpm tenant:provision` — the sales-led provisioning command (T-0015).
 *
 *   pnpm -s tenant:provision --slug <slug> --name <name> --admin-email <email> \
 *     --admin-name <display name> [--region ZA|NG|KE] [--allow-non-local]
 *
 * `-s` matters: without it pnpm echoes the full command line, admin email
 * included, as a lifecycle banner before this code runs. The inner pnpm call
 * in the root script is already `--silent`; the outer one is the operator's.
 *
 * A thin wrapper over `provisionTenant`, which holds every rule and the
 * local-database guard (a guard on the command line would protect only the
 * callers that use the command line). Runs as kasuwa_migrator, reading
 * DATABASE_MIGRATION_URL through @kasuwa/config exactly as `db:seed` does.
 *
 * OUTPUT DISCIPLINE. Progress and the audit-event shape go to stderr. The
 * one-time setup credential goes to stdout, once, and nowhere else: not to
 * stderr, not to a file, not into an error. The admin's email and name are
 * never printed — the operator typed them and does not need them echoed into
 * a terminal scrollback or a CI log.
 */

const USAGE =
  'usage: pnpm -s tenant:provision --slug <slug> --name <name> --admin-email <email> ' +
  '--admin-name <display name> [--region ZA|NG|KE] [--allow-non-local]';

function isRegion(value: string): value is TenantRegion {
  return (TENANT_REGIONS as readonly string[]).includes(value);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      slug: { type: 'string' },
      name: { type: 'string' },
      'admin-email': { type: 'string' },
      'admin-name': { type: 'string' },
      region: { type: 'string' },
      'allow-non-local': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const slug = values.slug;
  const name = values.name;
  const adminEmail = values['admin-email'];
  const adminDisplayName = values['admin-name'];
  if (
    slug === undefined ||
    name === undefined ||
    adminEmail === undefined ||
    adminDisplayName === undefined
  ) {
    throw new Error(USAGE);
  }

  // Region is a code or nothing (D-P2: omitted means ZA). Anything else is
  // handed to provisionTenant as-is so it raises the one InvalidRegionError.
  const region = values.region;
  if (region !== undefined && !isRegion(region)) {
    throw new Error(`--region must be one of ${TENANT_REGIONS.join(', ')}`);
  }

  const connectionString = env().DATABASE_MIGRATION_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_MIGRATION_URL is not set. Provisioning runs as kasuwa_migrator, like db:seed.',
    );
  }

  const result = await provisionTenant({
    connectionString,
    slug,
    name,
    adminEmail,
    adminDisplayName,
    ...(region === undefined ? {} : { region }),
    allowNonLocalDatabase: values['allow-non-local'],
    log: (message) => process.stderr.write(`${message}\n`),
  });

  process.stdout.write(
    [
      `Tenant provisioned: ${result.slug}`,
      `  tenant id           ${result.tenantId}`,
      `  region              ${result.region} (cell ${result.regionCell})`,
      `  business unit       ${result.businessUnitId}`,
      `  default programme   ${result.programmeId}`,
      `  first admin user    ${result.adminUserId}`,
      '',
      'One-time setup credential for the first admin. It is shown ONCE, is not stored',
      'anywhere in readable form and cannot be shown again. Give it to the admin over a',
      'channel you would trust with a password:',
      '',
      `  ${result.setupCredential}`,
      '',
      `The admin signs in to workspace "${result.slug}" with it and must enrol a second`,
      'factor at first sign-in.',
      '',
    ].join('\n'),
  );
}

main().catch((error: unknown) => {
  // The message only: provisionTenant's errors name fields, never values, and
  // a stack trace adds nothing an operator can act on.
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
});
