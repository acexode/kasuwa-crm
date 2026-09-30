/**
 * The authorisation matrix harness (T-0004, Agent 12).
 *
 * WHAT IT IS FOR
 *
 * When the permission engine exists (M2, blocked on D-L06), every role × object
 * × action combination needs an expectation, and every expectation needs to be
 * checked against the real evaluator. This is the part that can be built now:
 * the enumeration, the completeness rule, and the runner. Building it later,
 * with thirty objects already in place, is how matrices end up with an implicit
 * default that nobody chose.
 *
 * THE ONE RULE THAT MATTERS
 *
 * A missing cell is an ERROR, never a deny.
 *
 * "Unlisted means deny" looks like the safe default and is not. It means a new
 * object arrives with no expectations at all and nothing says so; the matrix
 * stays green while the thing it is supposed to cover is uncovered. Nobody
 * notices until it is the object that mattered. So `buildAuthzMatrix` refuses
 * to build an incomplete matrix and names the cells it is missing.
 *
 * The same rule in the other direction: an expectation for a cell that does not
 * exist is also an error. It is almost always a rename that half-landed, and
 * silently ignoring it leaves a role or an object with no coverage while the
 * count still looks right.
 *
 * NOT A SECURITY CONTROL BY ITSELF. This harness checks that the evaluator
 * agrees with a table somebody wrote down. It cannot tell you the table is
 * correct. That is a review question, and the matrix exists so there is
 * something concrete to review.
 */

export type AuthzDecision = 'allow' | 'deny';

export interface AuthzMatrixInput {
  readonly roles: readonly string[];
  readonly objects: readonly string[];
  readonly actions: readonly string[];
  /** Keyed `role:object:action`. Every cell must be present. */
  readonly expectations: Readonly<Record<string, AuthzDecision>>;
}

export interface AuthzCell {
  readonly key: string;
  readonly role: string;
  readonly object: string;
  readonly action: string;
  readonly expected: AuthzDecision;
}

export interface AuthzMatrix {
  readonly cells: readonly AuthzCell[];
}

export function authzCellKey(role: string, object: string, action: string): string {
  return `${role}:${object}:${action}`;
}

export class IncompleteAuthzMatrixError extends Error {
  constructor(
    readonly missing: readonly string[],
    readonly unexpected: readonly string[],
  ) {
    const parts: string[] = [];
    if (missing.length > 0) {
      parts.push(`missing expectations for: ${missing.join(', ')}`);
    }
    if (unexpected.length > 0) {
      parts.push(`expectations for cells that do not exist: ${unexpected.join(', ')}`);
    }
    super(
      `The authorisation matrix is incomplete. ${parts.join('; ')}. ` +
        `A missing cell is an error, not a deny — see packages/testing/src/authz-matrix.ts.`,
    );
    this.name = 'IncompleteAuthzMatrixError';
  }
}

/**
 * Expands roles × objects × actions and pairs each cell with its expectation.
 *
 * Throws `IncompleteAuthzMatrixError` naming every cell that is missing and
 * every expectation that matches no cell.
 */
export function buildAuthzMatrix(input: AuthzMatrixInput): AuthzMatrix {
  const cells: AuthzCell[] = [];
  const missing: string[] = [];
  const covered = new Set<string>();

  for (const role of input.roles) {
    for (const object of input.objects) {
      for (const action of input.actions) {
        const key = authzCellKey(role, object, action);
        covered.add(key);
        const expected = input.expectations[key];
        if (expected === undefined) {
          missing.push(key);
          continue;
        }
        cells.push({ key, role, object, action, expected });
      }
    }
  }

  const unexpected = Object.keys(input.expectations).filter((key) => !covered.has(key));

  if (missing.length > 0 || unexpected.length > 0) {
    throw new IncompleteAuthzMatrixError(missing, unexpected);
  }

  return { cells };
}

export interface AuthzMatrixFailure {
  readonly key: string;
  readonly expected: AuthzDecision;
  readonly actual: AuthzDecision;
}

export interface AuthzMatrixResult {
  readonly checked: number;
  readonly failures: readonly AuthzMatrixFailure[];
}

/**
 * Evaluates every cell and reports the disagreements.
 *
 * `evaluate` is the real permission engine once it exists. It is a parameter
 * rather than an import because M2 is blocked on D-L06 and this harness must be
 * usable before the engine is written — which is the whole reason it is built
 * now (D-L25, T-0004).
 *
 * It reports ALL failures rather than throwing on the first. A matrix that
 * stops at the first disagreement makes a permission change look like one
 * regression when it is forty, and the fix gets shaped by the wrong number.
 */
export async function runAuthzMatrix(
  matrix: AuthzMatrix,
  evaluate: (cell: AuthzCell) => AuthzDecision | Promise<AuthzDecision>,
): Promise<AuthzMatrixResult> {
  const failures: AuthzMatrixFailure[] = [];

  for (const cell of matrix.cells) {
    const actual = await evaluate(cell);
    if (actual !== cell.expected) {
      failures.push({ key: cell.key, expected: cell.expected, actual });
    }
  }

  return { checked: matrix.cells.length, failures };
}

/**
 * The placeholder role set, so the harness is exercised before M2 lands.
 *
 * Deliberately tiny and deliberately NOT a proposal: naming roles here would
 * pre-empt D-L06 and M2's own design. It exists so `runAuthzMatrix` has
 * something real to run against and cannot rot into an untested helper — which
 * is what happened to `readNonTenantScopedTableSecurity`, a compensating control
 * that was documented in two places and called by nothing.
 */
export const PLACEHOLDER_ROLES = ['agent', 'supervisor'] as const;
export const PLACEHOLDER_OBJECTS = ['contact'] as const;
export const PLACEHOLDER_ACTIONS = ['read', 'update', 'delete'] as const;

export const PLACEHOLDER_EXPECTATIONS: Readonly<Record<string, AuthzDecision>> = {
  'agent:contact:read': 'allow',
  'agent:contact:update': 'allow',
  'agent:contact:delete': 'deny',
  'supervisor:contact:read': 'allow',
  'supervisor:contact:update': 'allow',
  'supervisor:contact:delete': 'allow',
};

/** The placeholder matrix, built through the same completeness rule. */
export function buildPlaceholderAuthzMatrix(): AuthzMatrix {
  return buildAuthzMatrix({
    roles: PLACEHOLDER_ROLES,
    objects: PLACEHOLDER_OBJECTS,
    actions: PLACEHOLDER_ACTIONS,
    expectations: PLACEHOLDER_EXPECTATIONS,
  });
}
