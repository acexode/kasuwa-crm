import type { RealtimeEvent } from './events';

/**
 * Server-side fan-out (CLAUDE.md of this app, invariants 1 and 2). A client is
 * given an event only when the event's tenant is the client's and the event's
 * programme is in the client's SUBSCRIBED set, which is always a subset of the
 * programmes the session reached at connect. "Send everything and let the
 * client filter" is how a wallboard leaks another BPO client's queue.
 */
export interface HubClient {
  readonly tenantId: string;
  /** What the client may subscribe to: fixed at connect, from `user_programme`. */
  readonly reachable: ReadonlySet<string>;
  /** What it receives now. Always a subset of `reachable`. */
  subscribed: ReadonlySet<string>;
  send(frame: unknown): void;
}

export class Hub {
  private readonly clients = new Set<HubClient>();

  add(client: HubClient): void {
    this.clients.add(client);
  }

  remove(client: HubClient): void {
    this.clients.delete(client);
  }

  get size(): number {
    return this.clients.size;
  }

  all(): HubClient[] {
    return [...this.clients];
  }

  /** Delivers `event` to every client entitled to it; returns how many. The frame has no tenant id. */
  publish(event: RealtimeEvent): number {
    let delivered = 0;
    for (const client of this.clients) {
      if (client.tenantId !== event.tenantId) continue;
      if (!client.subscribed.has(event.programmeId)) continue;
      client.send({
        type: 'event',
        event: { type: event.type, programmeId: event.programmeId, ids: event.ids },
      });
      delivered += 1;
    }
    return delivered;
  }
}

export type SubscriptionResult =
  { readonly ok: true; readonly programmeIds: string[] } | { readonly ok: false };

/**
 * What a `subscribe` frame asks for, judged against the socket's reachable
 * set. Any id outside it, whether another programme, another tenant's, or one
 * that does not exist, is the one `{ ok: false }` (the caller answers one
 * identical `not_found`). An empty or absent list means every programme in scope.
 */
export function resolveSubscription(
  reachable: ReadonlySet<string>,
  requested: readonly string[] | undefined,
): SubscriptionResult {
  if (requested === undefined || requested.length === 0) {
    return { ok: true, programmeIds: [...reachable].sort() };
  }
  for (const id of requested) {
    if (!reachable.has(id)) return { ok: false };
  }
  return { ok: true, programmeIds: [...new Set(requested)].sort() };
}
