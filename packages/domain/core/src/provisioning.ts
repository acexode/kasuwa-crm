/**
 * `@kasuwa/domain-core/provisioning`: operator-only tenant provisioning
 * (T-0015, D-L54 as amended).
 *
 * It is a separate entry point because `provisionTenant` runs on the
 * kasuwa_migrator (BYPASSRLS) connection, and the package's main entry is
 * imported by apps/api. Keeping it off the main entry means no app process
 * can reach it by importing the domain package. ESLint also bans this subpath,
 * and the name `provisionTenant`, under apps/**, and the T-0015 acceptance
 * suite asserts that the main entry does not export it.
 *
 * Consumers: the `pnpm tenant:provision` CLI and the acceptance suite. Nothing
 * that serves traffic. The pure slug rules (`tenant-slug.ts`) stay on the main
 * entry; they hold no credentials.
 */
export * from './tenant/provision-tenant';
