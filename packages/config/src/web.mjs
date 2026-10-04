// @ts-check
/**
 * `@kasuwa/config/web` — the web process's entry point (T-0014).
 *
 * A separate entry point, for the same reason as `@kasuwa/config/feature-flags`:
 * the web process must be able to validate its environment without being
 * handed anything it must not hold. This module:
 *
 *   - LOADS NOTHING. No `.env`, no dotenv import. The workspace `.env` holds
 *     `DATABASE_URL`; loading it here would put into the web process the one
 *     variable `webEnv` exists to refuse.
 *   - exports only the web schema. The `.env` loader is not reachable from it.
 *   - is JavaScript, so that `apps/web/next.config.mjs`, which Next loads with
 *     a native `import()`, can import it with no TypeScript loader in between.
 *     See the note at the top of `./schemas.mjs`.
 */
export { webBuildEnv, webEnv } from './schemas.mjs';

/** @typedef {import('./schemas.mjs').EnvSource} EnvSource */
/** @typedef {import('./schemas.mjs').WebEnv} WebEnv */
