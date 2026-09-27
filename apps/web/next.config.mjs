/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @kasuwa/* packages ship TypeScript source rather than a build step, so Next
  // compiles them alongside the app. Keeps the edit-refresh loop instant, which
  // matters more than build purity for a workspace this size.
  transpilePackages: ['@kasuwa/ui', '@kasuwa/i18n'],
};

export default nextConfig;
