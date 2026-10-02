/**
 * The name of the low-bandwidth-mode cookie, in a module with NO
 * `'use client'` directive — because both halves of the app read it.
 *
 * It used to live in `components/auth/lite-mode.tsx`, which is a client
 * module, and `app/layout.tsx` imported it from there. A client module's
 * exports become client references: a server component that imports a
 * component from one gets something React can render, but a server component
 * that imports a plain VALUE gets a proxy, and the failure is at request time
 * with nothing at compile time to warn you. `app/client-boundary.test.ts`
 * found this one; the fix is the same as the rule — a value both sides need
 * belongs in a module neither side has claimed.
 */
export const LITE_COOKIE = 'kasuwa_lite';
