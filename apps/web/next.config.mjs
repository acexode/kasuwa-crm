/**
 * @type {import('next').NextConfig}
 *
 * THE API IS SAME-ORIGIN TO THE BROWSER.
 *
 * Every fetch in `apps/web` is a relative `/api/v1/...` path, and this rewrite
 * is the only place an API hostname appears. Two reasons, in order of weight:
 *
 *   1. No `process.env` in application code. That rule is lint-enforced and its
 *      point is that environment parsing happens at one validated boundary.
 *      A `.config.mjs` file is the exemption the lint config already grants,
 *      and it is read once at server start rather than on every render.
 *   2. No third origin for the browser to resolve. On a 300 ms link an extra
 *      DNS lookup, TLS handshake and CORS preflight is most of a second before
 *      the first byte of a sign-in response — per request.
 *
 * `@kasuwa/config` would be the natural home for the variable, but it demands a
 * `DATABASE_URL` and the web process has none; reconciling that is a real
 * question and it is raised in team/reports/T-0007.md rather than worked
 * around here.
 */
const API_ORIGIN = process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:3001';

/**
 * HARNESS-ONLY: a second dev server in the same checkout (T-0007).
 *
 * The e2e run starts one web server at the flag defaults and a second with
 * `self_serve_signup` switched on server-side, so one Playwright run can prove
 * both that `P01/3` is a 404 and that it renders. Two `next dev` processes
 * sharing `.next` corrupt each other, so the second one gets its own build
 * directory — and its own generated tsconfig, because Next rewrites the
 * tsconfig it is given to include `<distDir>/types`, and the tracked one must
 * not change under a test run. Unset, both are the defaults.
 *
 * Neither of these is a feature flag. The flag itself is read by
 * `@kasuwa/feature-flags` from `KASUWA_FEATURE_FLAGS_ON` through
 * `@kasuwa/config`, never here and never from a request.
 */
const DIST_DIR = process.env.KASUWA_WEB_DIST_DIR ?? '.next';
const TSCONFIG = process.env.KASUWA_WEB_TSCONFIG ?? 'tsconfig.json';

const nextConfig = {
  reactStrictMode: true,
  distDir: DIST_DIR,
  typescript: { tsconfigPath: TSCONFIG },
  // @kasuwa/* packages ship TypeScript source rather than a build step, so Next
  // compiles them alongside the app. Keeps the edit-refresh loop instant, which
  // matters more than build purity for a workspace this size. The flag and
  // config packages are server-only: they are imported by server components
  // and never reach a browser bundle.
  transpilePackages: ['@kasuwa/ui', '@kasuwa/i18n', '@kasuwa/feature-flags', '@kasuwa/config'],
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${API_ORIGIN}/api/v1/:path*` }];
  },
};

export default nextConfig;
