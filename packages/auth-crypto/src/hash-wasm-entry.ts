/**
 * Build entry for the argon2 worker's copy of `hash-wasm` (T-0013).
 *
 * Nothing imports this file. A bundled app (`apps/api` `build`) has no
 * `node_modules` next to it, so the argon2 worker thread cannot `require` the
 * library by name; the build bundles THIS entry to `dist/hash-wasm.cjs`, and
 * `password.ts` loads that when it sits beside the bundle. Exported names are
 * exactly what the worker uses.
 */
export { argon2id, argon2Verify } from 'hash-wasm';
