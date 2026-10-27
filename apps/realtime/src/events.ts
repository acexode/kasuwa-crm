import { z } from 'zod';

/**
 * The event seam (ADR-0020): Redis pub/sub, channel `kasuwa.realtime.events`,
 * ids only (D-P29). T-0191 feeds it from the outbox later; today anything that
 * publishes here is trusted only as far as this schema, and the hub still
 * filters on the tenant and programme it names.
 */
export const EVENTS_CHANNEL = 'kasuwa.realtime.events';

const MAX_RAW_BYTES = 64 * 1024;

export const RealtimeEvent = z.object({
  tenantId: z.uuid(),
  programmeId: z.uuid(),
  type: z.string().min(1).max(64),
  ids: z.array(z.string().min(1).max(64)).max(200),
});
export type RealtimeEvent = z.infer<typeof RealtimeEvent>;

/** A well-formed event, or null. A malformed one is dropped, never delivered and never logged. */
export function parseEvent(raw: string): RealtimeEvent | null {
  if (raw.length > MAX_RAW_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = RealtimeEvent.safeParse(value);
  return parsed.success ? parsed.data : null;
}
