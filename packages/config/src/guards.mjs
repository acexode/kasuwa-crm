// @ts-check
/**
 * The fail-closed boot guards.
 *
 * One place to look for "what will stop a mis-configured production boot".
 * Every process schema in `./schemas.mjs` runs `assertAuthModeIsSafe`; the
 * API's also runs the other two, because the API is the only process holding a
 * key provider and a sign-in throttle.
 *
 * This module imports nothing and reads nothing. The guards are pure functions
 * of an already-parsed environment.
 *
 * WHY THIS IS JAVASCRIPT (checked by TypeScript through `@ts-check`, under the
 * workspace's strict settings): `apps/web/next.config.mjs` imports the web
 * schema, and Next loads that file with a native `import()`. Node 22.16 cannot
 * import TypeScript (ERR_UNKNOWN_FILE_EXTENSION), so everything the web schema
 * needs, this guard included, has to be JavaScript that Node runs as-is.
 */

/** @typedef {'development' | 'test' | 'production'} NodeEnvName */
/** @typedef {'stub' | 'jwt'} AuthMode */
/** @typedef {'local' | 'aws-kms'} KmsProvider */

/**
 * Fail-closed guard for the stubbed auth context (team/DECISIONS.md D-L05).
 *
 * The stub resolves the caller from `x-kasuwa-*` request headers. That is safe
 * in development and required by the isolation tests, and catastrophic in
 * production. Refusing to boot is the only acceptable behaviour; there is a
 * unit test asserting this throws.
 *
 * Takes the auth mode AFTER defaulting. `KASUWA_AUTH_MODE` defaults to `stub`,
 * so a schema that left the field out would hand this `undefined` and the
 * guard would wave it through. That is why the field lives in the base schema
 * every process shares, and why the parameter is not optional.
 *
 * @param {{ readonly NODE_ENV: NodeEnvName; readonly KASUWA_AUTH_MODE: AuthMode }} env
 * @returns {void}
 */
export function assertAuthModeIsSafe(env) {
  if (env.NODE_ENV === 'production' && env.KASUWA_AUTH_MODE === 'stub') {
    throw new Error(
      'Refusing to start: KASUWA_AUTH_MODE=stub resolves the caller from request headers ' +
        'and must never run with NODE_ENV=production. See docs/adr/0007-stubbed-auth-context.md.',
    );
  }
}

/**
 * Fail-closed guard for envelope encryption (team/DECISIONS.md D-L13).
 *
 * The local key provider keeps its master key in the application process, next
 * to the ciphertext it protects. That is useful in development — it is what
 * makes a stolen backup useless — and it is not a key-management system. In
 * production the key must live in a KMS, which is the whole of the D-L13
 * answer, so the process refuses to start on the local provider there.
 *
 * Deliberately shaped like `assertAuthModeIsSafe`: same failure, same reason.
 *
 * @param {{ readonly NODE_ENV: NodeEnvName; readonly KASUWA_KMS_PROVIDER: KmsProvider }} env
 * @returns {void}
 */
export function assertKeyProviderIsSafe(env) {
  if (env.NODE_ENV === 'production' && env.KASUWA_KMS_PROVIDER === 'local') {
    throw new Error(
      'Refusing to start: KASUWA_KMS_PROVIDER=local holds its master key in this process ' +
        'and must never run with NODE_ENV=production. Set KASUWA_KMS_PROVIDER=aws-kms and ' +
        'KASUWA_KMS_KEY_ID to this environment’s KMS key. See team/DECISIONS.md D-L13.',
    );
  }
}

/**
 * The per-client sign-in throttle must not silently become a cell-wide ceiling.
 *
 * `SignInThrottleGuard` keys on the socket peer, so behind a load balancer
 * every request in the cell arrives from ONE address and shares ONE bucket. At
 * the shipped default of sixty a minute that is not a rate limit, it is an
 * availability cliff: the sixty-first legitimate sign-in in a minute — across
 * every tenant on the cell — gets a 429, and nothing in the logs says why.
 *
 * The guard's source comment has always been honest about this. A comment in a
 * source file is not a deployment control, which is the whole reason this
 * function exists: the process refuses to start in the configuration that
 * produces the outage, rather than producing it quietly.
 *
 * Two ways to satisfy it, and both are legitimate:
 *   - set KASUWA_TRUST_PROXY_HOPS, so the throttle keys on the real client; or
 *   - raise KASUWA_AUTH_SIGN_IN_PER_MINUTE above the cell-wide floor, i.e.
 *     accept that it is a crude global cap and size it like one.
 */
const CELL_WIDE_SIGN_IN_FLOOR = 600;

/**
 * @param {{
 *   readonly NODE_ENV: NodeEnvName;
 *   readonly KASUWA_TRUST_PROXY_HOPS: number;
 *   readonly KASUWA_AUTH_SIGN_IN_PER_MINUTE: number;
 * }} env
 * @returns {void}
 */
export function assertThrottleIsNotACellWideCliff(env) {
  if (env.NODE_ENV !== 'production') {
    return;
  }
  if (env.KASUWA_TRUST_PROXY_HOPS > 0) {
    return;
  }
  if (env.KASUWA_AUTH_SIGN_IN_PER_MINUTE === 0) {
    // Explicitly disabled. A deliberate choice, and not this check's business.
    return;
  }
  if (env.KASUWA_AUTH_SIGN_IN_PER_MINUTE < CELL_WIDE_SIGN_IN_FLOOR) {
    throw new Error(
      'Refusing to start: KASUWA_TRUST_PROXY_HOPS is 0, so the sign-in throttle keys ' +
        'on the socket peer. Behind a load balancer that is ONE bucket for the whole ' +
        `cell, and KASUWA_AUTH_SIGN_IN_PER_MINUTE=${env.KASUWA_AUTH_SIGN_IN_PER_MINUTE} ` +
        `would then reject every tenant's sign-ins past that many per minute. Either ` +
        'set KASUWA_TRUST_PROXY_HOPS to the number of proxies in front of this process, ' +
        `or raise the limit above ${CELL_WIDE_SIGN_IN_FLOOR} and treat it as the ` +
        'cell-wide cap it would be.',
    );
  }
}
