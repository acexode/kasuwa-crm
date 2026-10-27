import type { Route } from '@playwright/test';

/**
 * The answer to `getMyCapabilities` (T-0158, docs/api/auth.openapi.yaml) for
 * every per-screen mock whose screen asks it: accounts, the account record,
 * leads, activities, the deals board, Studio custom fields and the script
 * builder.
 *
 * It is the browser's read, so a mock answers it where it answers
 * `listMyProgrammes`. A mock that serves `/api/v1/` with a catch-all MUST call
 * `answerCapabilities` for this path first, or the catch-all records a
 * violation (and, being the most recently registered route, shadows any route
 * a spec registered earlier).
 *
 * The DEFAULT is `writer`, whatever role a mock models: the older journeys
 * click write controls to prove the API's 403 is the gate, and they must
 * still see them. A journey about hidden controls passes its own answer
 * through the mock's `capabilities` option. Never register a second
 * `**\/me/capabilities` route in a spec: the mock's route runs first or last
 * depending on registration order, so the option is the one way to override.
 */
export const CAPABILITIES_PATH = '/api/v1/me/capabilities';

export interface CapabilitiesBody {
  readonly tenant: { readonly admin: boolean; readonly can: readonly string[] };
  readonly programmes: readonly { readonly id: string; readonly can: readonly string[] }[];
}

/** `writer`: every write the web checks. `reader`: no write at all. `unreadable`: a 500, so a screen draws its controls. */
export type CapabilitiesAnswer = CapabilitiesBody | 'writer' | 'reader' | 'unreadable';

const PROGRAMME_WRITES = ['account.write', 'activity.write', 'contact.claim_and_set_status', 'contact.write', 'deal.write', 'deal.write_any', 'script.run', 'script.write'];

export function capabilitiesBody(answer: CapabilitiesAnswer, programmeIds: readonly string[]): CapabilitiesBody | null {
  if (answer === 'unreadable') return null;
  if (answer === 'writer') {
    return {
      tenant: { admin: true, can: ['custom_field.write'] },
      programmes: programmeIds.map((id) => ({ id, can: PROGRAMME_WRITES })),
    };
  }
  if (answer === 'reader') {
    return { tenant: { admin: false, can: [] }, programmes: programmeIds.map((id) => ({ id, can: ['script.run'] })) };
  }
  return answer;
}

/** Answer one request for the capabilities path. `calls` counts it, for a journey that asserts the screen asked. */
export function answerCapabilities(route: Route, answer: CapabilitiesAnswer | undefined, programmeIds: readonly string[], calls?: { count: number }): Promise<void> {
  if (calls !== undefined) calls.count += 1;
  const body = capabilitiesBody(answer ?? 'writer', programmeIds);
  if (body === null) {
    return route.fulfill({
      status: 500,
      contentType: 'application/json',
      headers: { 'cache-control': 'no-store' },
      body: JSON.stringify({ statusCode: 500, error: 'Internal Server Error', code: 'internal_error', message: 'Internal error' }),
    });
  }
  return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(body) });
}
