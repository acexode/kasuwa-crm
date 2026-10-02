import type en from './locales/en.json';

/**
 * Every message id in the product, as a union of string literals.
 *
 * `import type` is load-bearing: it is erased at compile time, so a module that
 * only needs the TYPE never pulls `en.json` — 100 KB of catalogue — into a
 * browser bundle. `bundle.ts` depends on this file for exactly that reason.
 */
export type MessageId = keyof typeof en;

/** A catalogue, or the part of one a locale actually overrides. */
export type Catalogue = Partial<Record<MessageId, string>>;
