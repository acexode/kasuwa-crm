import { PHASE_PRODUCTION_BUILD } from 'next/constants.js';
// The deep `src/` path is deliberate. Next loads this file with a native
// `import()`, so the specifier has to resolve under plain Node, and the
// TypeScript path alias `@kasuwa/config/web` does not exist there. The module
// is checked JavaScript for the same reason (packages/config/src/schemas.mjs).
import { webBuildEnv, webEnv } from '@kasuwa/config/src/web.mjs';

/**
 * Configuration comes from `@kasuwa/config/web`, never from `process.env`
 * directly (T-0014). That entry point validates the web environment, REFUSES
 * one holding `DATABASE_URL` or `DATABASE_MIGRATION_URL`, and loads no `.env`.
 *
 * THE PHASE DECIDES WHICH PARSE RUNS.
 *
 *   - `next build` runs `webBuildEnv()`: the same schema and the same refusal
 *     of a database URL, without the stub-auth guard. A build is not a boot;
 *     it resolves no caller, and CI builds with no auth mode at all.
 *   - every other phase, `next dev` and `next start` included, runs `webEnv()`,
 *     which DOES run the guards. A production web server with
 *     KASUWA_AUTH_MODE unset or `stub`, or with an unsafe session layer
 *     (ADR-0019 point 8), refuses to start here, before it binds a port,
 *     exactly as the API does.
 *
 * @param {string} phase
 * @returns {import('next').NextConfig}
 */
export default function nextConfig(phase) {
  const env = phase === PHASE_PRODUCTION_BUILD ? webBuildEnv() : webEnv();

  return {
    reactStrictMode: true,

    /**
     * HARNESS-ONLY: a second dev server in the same checkout (T-0007).
     *
     * The e2e run starts one web server at the flag defaults and a second with
     * `self_serve_signup` switched on server-side, so one Playwright run can
     * prove both that `P01/3` is a 404 and that it renders. Two `next dev`
     * processes sharing `.next` corrupt each other, so the second one gets its
     * own build directory — and its own generated tsconfig, because Next
     * rewrites the tsconfig it is given to include `<distDir>/types`, and the
     * tracked one must not change under a test run. Unset, both are the
     * defaults.
     *
     * Neither of these is a feature flag. The flag itself is read by
     * `@kasuwa/feature-flags` from `KASUWA_FEATURE_FLAGS_ON` through
     * `@kasuwa/config`, never here and never from a request.
     */
    distDir: env.KASUWA_WEB_DIST_DIR,
    typescript: { tsconfigPath: env.KASUWA_WEB_TSCONFIG },

    // @kasuwa/* packages ship TypeScript source rather than a build step, so
    // Next compiles them alongside the app. Keeps the edit-refresh loop
    // instant, which matters more than build purity for a workspace this size.
    // The flag and config packages are server-only: they are imported by
    // server components and never reach a browser bundle.
    transpilePackages: ['@kasuwa/ui', '@kasuwa/i18n', '@kasuwa/feature-flags', '@kasuwa/config'],

    // THE API IS SAME-ORIGIN TO THE BROWSER, through a route handler rather
    // than a rewrite (ADR-0019, T-0125). `app/api/v1/[...path]/route.ts` is the
    // browser's only door to the API: it keeps the session in an HttpOnly
    // cookie, enforces CSRF and forwards server-side to KASUWA_API_INTERNAL_URL,
    // read at runtime through webEnv(). So no API address is resolved at build
    // time, none is inlined into a bundle, and there is no rewrite here.
  };
}
