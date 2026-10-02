#!/usr/bin/env node
/**
 * Generates `support/admin-mock.generated.ts` from `docs/api/admin.openapi.yaml`.
 *
 * ---------------------------------------------------------------------------
 * WHY GENERATED AND NOT WRITTEN
 *
 * The same reason as `generate-auth-mock.mjs`, and `docs/api/README.md` says it
 * in as many words: **generate the mock from the spec; do not hand-write one.**
 * Almost every operation in the admin contract is `x-kasuwa-implemented: false`
 * today, so the spec's `example` is the only data behind twenty-two screens. A
 * hand-written mock drifts silently — nothing fails, because the thing it would
 * disagree with does not exist yet — and the wiring step then discovers that
 * the screens were built against a fiction.
 *
 * So every status code, every example body and the `x-kasuwa-implemented` flag
 * are READ OUT OF THE SPEC. The only thing `support/admin-mock.ts` adds is the
 * state the contract describes in prose and cannot express in an example:
 * which alert this user has dismissed, whether a disposition has been deleted.
 * ---------------------------------------------------------------------------
 *
 * This is a near-copy of `generate-auth-mock.mjs` rather than a shared module.
 * That is deliberate: merging them would mean regenerating
 * `auth-mock.generated.ts`, which is committed and diffed for drift, as a side
 * effect of adding a second spec. Factoring the two together is a small task on
 * its own and it is named in `team/reports/P02.md`.
 *
 * Run: pnpm --filter @kasuwa/e2e generate-admin-mock
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const here = resolve(import.meta.dirname);
const e2eRoot = resolve(here, '..');
const repoRoot = resolve(e2eRoot, '..', '..');
const specPath = resolve(repoRoot, 'docs/api/admin.openapi.yaml');
const outPath = resolve(e2eRoot, 'support/admin-mock.generated.ts');

const spec = parse(readFileSync(specPath, 'utf8'));

/** Follows a local `$ref`. The spec has no remote refs and must not grow any. */
function deref(node) {
  if (node === null || typeof node !== 'object') return node;
  const ref = node.$ref;
  if (typeof ref !== 'string') return node;
  if (!ref.startsWith('#/')) {
    throw new Error(`remote $ref is not supported: ${ref}`);
  }
  let target = spec;
  for (const segment of ref.slice(2).split('/')) {
    target = target[segment];
    if (target === undefined) throw new Error(`$ref does not resolve: ${ref}`);
  }
  return deref(target);
}

const operations = [];

for (const [path, item] of Object.entries(spec.paths)) {
  for (const [method, operation] of Object.entries(item)) {
    if (typeof operation !== 'object' || operation === null) continue;
    if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;

    const responses = {};
    for (const [status, rawResponse] of Object.entries(operation.responses ?? {})) {
      const response = deref(rawResponse);
      const json = response.content?.['application/json'];
      if (json === undefined) {
        responses[status] = { default: null };
        continue;
      }
      const examples = {};
      if (json.example !== undefined) {
        examples.default = json.example;
      }
      for (const [name, example] of Object.entries(json.examples ?? {})) {
        examples[name] = deref(example).value;
      }
      if (Object.keys(examples).length > 0) {
        responses[status] = examples;
      }
    }

    operations.push({
      operationId: operation.operationId,
      method: method.toUpperCase(),
      path,
      implemented: String(operation['x-kasuwa-implemented'] ?? 'unknown'),
      audited: operation['x-kasuwa-audited'] === true,
      screens: operation['x-kasuwa-screens'] ?? [],
      responses,
    });
  }
}

operations.sort((a, b) => a.operationId.localeCompare(b.operationId));

const banner = `// GENERATED from docs/api/admin.openapi.yaml — DO NOT EDIT.
// Regenerate with: pnpm --filter @kasuwa/e2e generate-admin-mock
//
// Every body below is an \`example\` the contract publishes, copied verbatim.
// Hand-editing one makes the mock disagree with the API that will be built
// against the same file, silently — which is the entire failure mode this
// generation exists to prevent.
//
// \`implemented\` is the operation's \`x-kasuwa-implemented\` flag:
//   true    — real today
//   partial — some of the response is real, the rest is null or absent
//   false   — contract only; the screen stays on this mock
`;

const body = `
export interface MockOperation {
  readonly operationId: string;
  readonly method: string;
  /** The OpenAPI template path, e.g. \`/api/v1/admin/programmes/{programmeId}\`. */
  readonly path: string;
  readonly implemented: 'true' | 'partial' | 'false' | 'unknown';
  /** \`x-kasuwa-audited\` — this operation must write an audit row when built. */
  readonly audited: boolean;
  readonly screens: readonly string[];
  /** status -> example name -> body. \`default\` is the spec's single \`example:\`. */
  readonly responses: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export const ADMIN_CONTRACT_SOURCE = 'docs/api/admin.openapi.yaml';

export const ADMIN_OPERATIONS = ${JSON.stringify(operations, null, 2)} as const;

/** The same list behind the documented shape, so a change to it fails here. */
export const ADMIN_CONTRACT: readonly MockOperation[] = ADMIN_OPERATIONS;

export type AdminOperationId = (typeof ADMIN_OPERATIONS)[number]['operationId'];

/** The body the contract publishes for one outcome. Throws if it is not there. */
export function contractExample(
  operationId: AdminOperationId,
  status: number,
  example = 'default',
): unknown {
  const operation = ADMIN_CONTRACT.find((candidate) => candidate.operationId === operationId);
  if (operation === undefined) {
    throw new Error(\`\${operationId} is not in \${ADMIN_CONTRACT_SOURCE}\`);
  }
  const bodies = operation.responses[String(status)];
  if (bodies === undefined) {
    throw new Error(\`\${operationId} publishes no \${status} in \${ADMIN_CONTRACT_SOURCE}\`);
  }
  if (!(example in bodies)) {
    throw new Error(
      \`\${operationId} \${status} has no example "\${example}" in \${ADMIN_CONTRACT_SOURCE} \` +
        \`(it has: \${Object.keys(bodies).join(', ')})\`,
    );
  }
  return bodies[example];
}

/**
 * Matches a concrete request path against the contract's templates.
 *
 * Segment by segment, because \`{programmeId}\` matches ONE segment and nothing
 * else. A pattern that matched a slash would let \`/programmes/x/sla\` resolve to
 * \`getProgramme\`, and the mock would answer a different screen's question with
 * a plausible-looking body.
 */
export function findOperation(method: string, pathname: string): MockOperation | undefined {
  const actual = pathname.split('/');
  return ADMIN_CONTRACT.find((candidate) => {
    if (candidate.method !== method) return false;
    const template = candidate.path.split('/');
    if (template.length !== actual.length) return false;
    return template.every((segment, index) =>
      segment.startsWith('{') && segment.endsWith('}') ? true : segment === actual[index],
    );
  });
}
`;

writeFileSync(outPath, `${banner}${body}`, 'utf8');
process.stdout.write(`wrote ${outPath} (${operations.length} operations)\n`);
