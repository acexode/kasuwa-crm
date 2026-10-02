/**
 * The programme screen's tab vocabulary, in a module with **no `'use client'`
 * directive** — and that is load-bearing, not tidiness.
 *
 * A client module's exports become client REFERENCES. A server component that
 * imports a function from one gets a proxy, and calling it fails at request
 * time with "Attempted to call isProgrammeTab() from the server but
 * isProgrammeTab is on the client" — a 500, not a compile error. `page.tsx` has
 * to read `?tab=` on the server, so the guard cannot live beside the component
 * that consumes it.
 *
 * This is the same rule as `components/auth/message-ids.ts`, which carries the
 * same note because it cost a full e2e run on P01. It cost another one here.
 */

export const PROGRAMME_TABS = [
  'overview',
  'agents',
  'sla',
  'dispositions',
  'scripts',
  'retention',
  'portal',
] as const;

export type ProgrammeTab = (typeof PROGRAMME_TABS)[number];

/**
 * A mistyped query string is not a missing record, so an unknown value falls
 * back to the overview rather than erroring.
 */
export function isProgrammeTab(value: string | undefined): value is ProgrammeTab {
  return PROGRAMME_TABS.includes((value ?? '') as ProgrammeTab);
}
