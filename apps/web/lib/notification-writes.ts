/**
 * How the notification writes are sequenced (T-0101, N12), as pure functions:
 * which writes may start, what a lost answer does, what an answer does to the
 * badge, and whether an answer still belongs to the list it was asked from.
 * The hook only sends requests and dispatches; every rule that could draw a
 * lie lives here, where each is a test (D-L176's lesson).
 *
 *   - N1  a write marks the count store busy while it is in flight
 *         (`notification-count.ts`), so a count read that straddles it is
 *         dropped; this module decides what the ANSWER does to the badge.
 *   - N2  a 404 changes nothing the reader can see, so the badge is read
 *         again rather than stepped (the item may never have been counted).
 *   - N3  a mark-all answer belongs to the query it was sent from.
 *   - N4  a dot and a mark-all are never in flight together.
 */

/** The delays before each resend of a write whose answer was lost: both inside the ten seconds D-L171 allows. */
export const RESEND_DELAYS_MS: readonly number[] = [1_000, 3_000];

/**
 * One write, sent again with the SAME request when its answer was lost (a
 * network failure, whether or not it applied). Anything else, an answer or a
 * refusal, ends it. `run` is built once by the caller, so a resend can never
 * be wider than the first send.
 */
export async function sendWithResends<R extends { readonly ok: boolean; readonly error?: { readonly code: string } }>(
  run: () => Promise<R>,
  sleep: (ms: number) => Promise<void>,
  delays: readonly number[] = RESEND_DELAYS_MS,
): Promise<R> {
  let result = await run();
  for (const delay of delays) {
    if (result.ok || result.error?.code !== 'network') return result;
    await sleep(delay);
    result = await run();
  }
  return result;
}

export interface GateView {
  readonly busyIds: readonly string[];
  readonly allBusy: boolean;
  readonly writeWaitUntil: number | null;
  readonly headId: string | null;
}

function waiting(view: GateView, now: number): boolean {
  return view.writeWaitUntil !== null && view.writeWaitUntil > now;
}

/** A dot may start unless that dot or a mark-all is in flight, or a 429's wait is running (N4). */
export function canToggle(view: GateView, id: string, now: number): boolean {
  return !view.allBusy && !view.busyIds.includes(id) && !waiting(view, now);
}

/** A mark-all may start when it has a bound, and no mark-all or dot is in flight (N4). */
export function canReadAll(view: GateView, now: number): boolean {
  return view.headId !== null && !view.allBusy && view.busyIds.length === 0 && !waiting(view, now);
}

export type CountEffect = { readonly kind: 'step'; readonly delta: -1 | 1 } | { readonly kind: 'refresh' } | { readonly kind: 'none' };

export type DotOutcome = { readonly ok: true; readonly readAt: string | null } | { readonly ok: false; readonly code: string };

/**
 * What a dot's answer does to the badge. Only a change the server confirmed
 * steps it, once. A 404, or a failure that leaves it unknown whether the
 * change applied, reads the count again instead (N2): stepping would count an
 * item the count never held, or one it no longer holds.
 */
export function dotEffect(wasUnread: boolean, outcome: DotOutcome): CountEffect {
  if (!outcome.ok) return { kind: 'refresh' };
  const nowUnread = outcome.readAt === null;
  if (wasUnread && !nowUnread) return { kind: 'step', delta: -1 };
  if (!wasUnread && nowUnread) return { kind: 'step', delta: 1 };
  return { kind: 'none' };
}

/** A mark-all answer is drawn only on the list (query) it was sent from (N3); the count it carries is the server's and is always taken. */
export function isCurrentGeneration(sentWith: number, current: number): boolean {
  return sentWith === current;
}
