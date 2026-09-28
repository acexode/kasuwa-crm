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

const nextConfig = {
  reactStrictMode: true,
  // @kasuwa/* packages ship TypeScript source rather than a build step, so Next
  // compiles them alongside the app. Keeps the edit-refresh loop instant, which
  // matters more than build purity for a workspace this size.
  transpilePackages: ['@kasuwa/ui', '@kasuwa/i18n'],
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${API_ORIGIN}/api/v1/:path*` }];
  },
};

export default nextConfig;
