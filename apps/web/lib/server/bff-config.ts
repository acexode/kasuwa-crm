import { webEnv } from '@kasuwa/config/web';
import type { BffConfig, BffDependencies } from './bff-forward';

/**
 * The BFF's configuration, read through `webEnv()` (never `process.env`) at
 * the FIRST REQUEST and kept for the life of the process. Not at module
 * scope: `next build` imports route modules to collect their exports, and a
 * build is not given the runtime settings (D-L172). By the time a request
 * arrives, `next.config.mjs` and `instrumentation.ts` have already run
 * `webEnv()` and its guards, so a mis-configured process never got this far.
 * SERVER ONLY.
 */
let resolved: BffConfig | undefined;

export function bffConfig(): BffConfig {
  if (resolved === undefined) {
    const env = webEnv();
    resolved = Object.freeze({
      apiOrigin: env.KASUWA_API_INTERNAL_URL,
      webOrigin: env.KASUWA_WEB_ORIGIN,
      // Stub identity crosses the web tier only when this process is itself in
      // stub mode, which webEnv() refuses under NODE_ENV=production (point 7).
      forwardStubIdentity: env.KASUWA_AUTH_MODE === 'stub',
      cookie: Object.freeze({ insecure: env.KASUWA_SESSION_COOKIE_INSECURE === '1' }),
    });
  }
  return resolved;
}

/**
 * The real upstream: Node's own `fetch`, called at request time (so a test
 * that stubs the global sees it), and the wall clock for the cookie's Max-Age.
 */
export const bffDependencies: BffDependencies = Object.freeze({
  fetch: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => fetch(input, init),
  now: () => new Date(),
});
