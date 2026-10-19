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

/**
 * Whether a URL's hostname is a loopback address: `localhost`, `[::1]`, or
 * 127.0.0.0/8 (ADR-0019 point 8, amendment 2).
 *
 * Takes the hostname as the WHATWG URL parser leaves it, which canonicalises
 * a numeric IPv4 address. So `127.0.0.1.evil.example` is a domain name that
 * merely begins with 127., and is not loopback.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
export function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') {
    return true;
  }
  const octets = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(hostname);
  return octets !== null && octets.slice(1).every((octet) => Number(octet) <= 255);
}

/**
 * Fail-closed guard for the browser session layer (ADR-0019 point 8, D-L94).
 *
 * The cookie's attributes are constants in code (HttpOnly, SameSite=Lax,
 * Path=/, no Domain, the `__Host-` name), so no deployment can weaken them by
 * configuration. What configuration CAN do, and this refuses:
 *
 *   - KASUWA_SESSION_COOKIE_INSECURE outside development and test. Its
 *     PRESENCE refuses, with any value, empty and "0" included: a flag whose
 *     off-switch is a particular spelling is a flag somebody sets by mistake.
 *     Inside development and test it must be exactly "1", for the same reason.
 *   - an `http:` KASUWA_WEB_ORIGIN outside development and test, unless the
 *     host is loopback (browsers treat loopback as a secure context, so the
 *     cookie keeps `Secure` and its prefix there; this is not "loopback means
 *     development", D-L95).
 *   - an `http:` KASUWA_API_INTERNAL_URL outside development and test, unless
 *     the host is loopback (D-L149 #4 with amendment 2): the Bearer token
 *     travels on that leg.
 *
 * Runs on an already-parsed environment, so both URLs have been checked for
 * shape (an origin, no credentials) by the schema. Messages name the variable
 * and never echo its value.
 *
 * @param {{
 *   readonly NODE_ENV: NodeEnvName;
 *   readonly KASUWA_SESSION_COOKIE_INSECURE?: string | undefined;
 *   readonly KASUWA_WEB_ORIGIN?: string | undefined;
 *   readonly KASUWA_API_INTERNAL_URL?: string | undefined;
 * }} env
 * @returns {void}
 */
export function assertSessionCookieIsSafe(env) {
  const relaxed = env.NODE_ENV === 'development' || env.NODE_ENV === 'test';
  if (env.KASUWA_SESSION_COOKIE_INSECURE !== undefined) {
    if (!relaxed) {
      throw new Error(
        'Refusing to start: KASUWA_SESSION_COOKIE_INSECURE is set. It drops Secure and the ' +
          '__Host- prefix from the session cookie and exists only for development and test; ' +
          'outside them its presence, with any value, refuses boot. Remove it. See ' +
          'docs/adr/0019-browser-session.md point 8.',
      );
    }
    if (env.KASUWA_SESSION_COOKIE_INSECURE !== '1') {
      throw new Error(
        'Refusing to start: KASUWA_SESSION_COOKIE_INSECURE must be exactly "1" when it is set. ' +
          'Unset it to keep the secure cookie.',
      );
    }
  }
  if (relaxed) {
    return;
  }
  for (const name of /** @type {const} */ (['KASUWA_WEB_ORIGIN', 'KASUWA_API_INTERNAL_URL'])) {
    const value = env[name];
    if (value === undefined) {
      continue;
    }
    const url = new URL(value);
    if (url.protocol !== 'https:' && !isLoopbackHostname(url.hostname)) {
      throw new Error(
        `Refusing to start: ${name} must be https outside development and test (a loopback ` +
          'host is the one exception). See docs/adr/0019-browser-session.md point 8 and ' +
          'team/DECISIONS.md D-L149.',
      );
    }
  }
}
