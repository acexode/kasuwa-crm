import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { loadWorkspaceEnv, migratorEnv } from '@kasuwa/config';
import { provisionTenant, TENANT_REGIONS, type TenantRegion } from '@kasuwa/domain-core/provisioning';

/**
 * `pnpm tenant:provision`, the sales-led provisioning command (T-0015).
 * INTERACTIVE TERMINAL ONLY.
 *
 *   pnpm -s tenant:provision --slug <slug> --name <name> [--region ZA|NG|KE]
 *     [--allow-non-local] [--print-credential]
 *
 * and then answer two prompts: the admin's email and display name.
 *
 * WHY PROMPTS. pnpm echoes a script's full command line as a lifecycle banner
 * before any of this code runs, so an email passed as an argument lands in the
 * terminal scrollback and in any CI log. Read from stdin, it never appears in
 * argv. `--admin-email` and `--admin-name` are still accepted (they are the
 * T-0015 interface), but a warning is printed when they are used. The inner
 * pnpm call in the root script is `--silent`; `-s` on the outer call is the
 * operator's. Piped input works too: one line for the email, then one for the
 * name.
 *
 * WHY A TERMINAL. The one-time setup credential is printed to stdout, once.
 * If stdout is a pipe or a file, "once, to the operator" becomes "into
 * whatever captured it". So the command refuses to start, before it creates
 * anything, unless stdout is a TTY or `--print-credential` was given to say
 * the capture is deliberate.
 *
 * A thin wrapper over `provisionTenant`, which holds every rule and the
 * local-database guard (a guard on the command line would protect only the
 * callers that use the command line). Runs as kasuwa_migrator, reading
 * DATABASE_MIGRATION_URL through @kasuwa/config exactly as `db:seed` does.
 *
 * OUTPUT DISCIPLINE. Progress and the audit-event shape go to stderr. The
 * credential goes to stdout once, and nowhere else: not to stderr, not to a
 * file, not into an error. The admin's email and name are never printed.
 */

const USAGE =
  'usage: pnpm -s tenant:provision --slug <slug> --name <name> [--region ZA|NG|KE] ' +
  '[--allow-non-local] [--print-credential]   (prompts for the admin email and name; ' +
  'interactive terminal only)';

function isRegion(value: string): value is TenantRegion {
  return (TENANT_REGIONS as readonly string[]).includes(value);
}

/**
 * Reads the missing answers from stdin, one line each. Prompts go to stderr,
 * and only when stdin is a terminal. Nothing read here is ever written back
 * out by this code.
 */
async function readMissing(
  questions: readonly { key: 'email' | 'name'; prompt: string }[],
): Promise<Partial<Record<'email' | 'name', string>>> {
  const answers: Partial<Record<'email' | 'name', string>> = {};
  if (questions.length === 0) {
    return answers;
  }
  const interactive = process.stdin.isTTY === true;
  const rl = createInterface({ input: process.stdin, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  try {
    for (const question of questions) {
      if (interactive) {
        process.stderr.write(question.prompt);
      }
      const next = await lines.next();
      if (next.done === true) {
        throw new Error(`No ${question.key} given on stdin. ${USAGE}`);
      }
      answers[question.key] = String(next.value).trim();
    }
  } finally {
    rl.close();
  }
  return answers;
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
      'print-credential': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  // Before anything is created: a credential printed into a pipe is a
  // credential written to wherever the pipe goes.
  if (process.stdout.isTTY !== true && !values['print-credential']) {
    throw new Error(
      'Refusing to run: stdout is not an interactive terminal, and the one-time setup ' +
        'credential would be written into whatever is capturing it. Run this in a terminal, ' +
        'or pass --print-credential if capturing it is deliberate.',
    );
  }

  const slug = values.slug;
  const name = values.name;
  if (slug === undefined || name === undefined) {
    throw new Error(USAGE);
  }

  // A region is a code or nothing (D-P2: omitted means ZA).
  const region = values.region;
  if (region !== undefined && !isRegion(region)) {
    throw new Error(`--region must be one of ${TENANT_REGIONS.join(', ')}`);
  }

  if (values['admin-email'] !== undefined || values['admin-name'] !== undefined) {
    process.stderr.write(
      'WARNING: --admin-email / --admin-name put personal data on the command line, which ' +
        'pnpm echoes and shells keep in history. Prefer the prompts.\n',
    );
  }

  loadWorkspaceEnv();
  const connectionString = migratorEnv().DATABASE_MIGRATION_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_MIGRATION_URL is not set. Provisioning runs as kasuwa_migrator, like db:seed.',
    );
  }

  const questions: { key: 'email' | 'name'; prompt: string }[] = [];
  if (values['admin-email'] === undefined) {
    questions.push({ key: 'email', prompt: 'First admin email: ' });
  }
  if (values['admin-name'] === undefined) {
    questions.push({ key: 'name', prompt: 'First admin display name: ' });
  }
  const answers = await readMissing(questions);
  const adminEmail = values['admin-email'] ?? answers.email ?? '';
  const adminDisplayName = values['admin-name'] ?? answers.name ?? '';

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
