#!/usr/bin/env node
/**
 * Generates `support/auth-mock.generated.ts` from `docs/api/auth.openapi.yaml`.
 *
 * ---------------------------------------------------------------------------
 * WHY GENERATED AND NOT WRITTEN
 *
 * T-0007 (these screens) and T-0001 (the auth API) are being built in parallel,
 * deliberately. Agent 1 published the contract first so that the screens are
 * not blocked; the screens are built against a mock, and wiring to the real
 * endpoints is the last step.
 *
 * That only works if the mock IS the contract. A hand-written one drifts
 * silently — nothing fails, because the thing it would disagree with does not
 * exist yet — and the wiring step then discovers that sixteen screens were
 * built against a fiction. So every status code, every example body and the
 * `x-kasuwa-implemented` flag are read out of the spec, and this file is
 * committed alongside a drift check: regenerate, and `git diff` must be empty.
 *
 * Prism (`npx @stoplight/prism-cli mock`) is the other half, and the right tool
 * for poking at the contract by hand — `docs/api/README.md` explains it. It is
 * not used in the e2e run for two reasons: it needs a network fetch at test
 * time, and it cannot express "this attempt is the fifth, so lock the account",
 * which is most of what these failure screens are about. The scenarios live in
 * the spec's own named examples; the state machine that chooses between them
 * lives in the spec-driven handler.
 * ---------------------------------------------------------------------------
 *
 * Run: pnpm --filter @kasuwa/e2e generate-mock
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const here = resolve(import.meta.dirname);
const e2eRoot = resolve(here, '..');
const repoRoot = resolve(e2eRoot, '..', '..');
const specPath = resolve(repoRoot, 'docs/api/auth.openapi.yaml');
const outPath = resolve(e2eRoot, 'support/auth-mock.generated.ts');

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

/**
 * Every concrete response body the contract publishes, keyed by
 * `operationId`, then status, then example name (`default` for a single
 * `example:`).
 */
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
      screens: operation['x-kasuwa-screens'] ?? [],
      responses,
    });
  }
}

operations.sort((a, b) => a.operationId.localeCompare(b.operationId));

const banner = `// GENERATED from docs/api/auth.openapi.yaml — DO NOT EDIT.
// Regenerate with: pnpm --filter @kasuwa/e2e generate-mock
//
// Every body below is an \`example\` the contract publishes, copied verbatim.
// Hand-editing one makes the mock disagree with the API that is being built
// against the same file, silently, which is the entire failure mode this
// generation exists to prevent.
//
// \`implemented\` is the operation's \`x-kasuwa-implemented\` flag:
//   true    — T-0001 builds it; the screen wires to the real endpoint
//   partial — some methods are real, some return 501
//   false   — contract only; the screen stays on this mock (P01/3, P01/4)
`;

const body = `
export interface MockOperation {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly implemented: 'true' | 'partial' | 'false' | 'unknown';
  readonly screens: readonly string[];
  /** status -> example name -> body. \`default\` is the spec's single \`example:\`. */
  readonly responses: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export const AUTH_CONTRACT_SOURCE = 'docs/api/auth.openapi.yaml';

export const AUTH_OPERATIONS = ${JSON.stringify(operations, null, 2)} as const;

/** The same list behind the documented shape, so a change to it fails here. */
export const AUTH_CONTRACT: readonly MockOperation[] = AUTH_OPERATIONS;

export type AuthOperationId = (typeof AUTH_OPERATIONS)[number]['operationId'];

/** The body the contract publishes for one outcome. Throws if it is not there. */
export function contractExample(
  operationId: AuthOperationId,
  status: number,
  example = 'default',
): unknown {
  const operation = AUTH_CONTRACT.find((candidate) => candidate.operationId === operationId);
  if (operation === undefined) {
    throw new Error(\`\${operationId} is not in \${AUTH_CONTRACT_SOURCE}\`);
  }
  const bodies = operation.responses[String(status)];
  if (bodies === undefined) {
    throw new Error(\`\${operationId} publishes no \${status} in \${AUTH_CONTRACT_SOURCE}\`);
  }
  if (!(example in bodies)) {
    throw new Error(
      \`\${operationId} \${status} has no example "\${example}" in \${AUTH_CONTRACT_SOURCE} \` +
        \`(it has: \${Object.keys(bodies).join(', ')})\`,
    );
  }
  return bodies[example];
}
`;

writeFileSync(outPath, `${banner}${body}`, 'utf8');
process.stdout.write(`wrote ${outPath} (${operations.length} operations)\n`);
