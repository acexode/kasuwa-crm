import type { TenantTx } from '@kasuwa/db';
import {
  AUDIT_EVENT_MAX_CHANGES,
  recordAuditEvent,
  redactedChange,
  type AuditEventInput,
} from './audit-writer';

/**
 * Records `event` with one REDACTED change per custom key appended: the key
 * (an api name, at most 63 characters, so within the writer's field bound) and
 * never a value, whatever the field's classification (ADR-0016 item 7). An
 * event that would pass the writer's change cap is continued in further
 * events of the same kind, so every key is audited and no write is refused
 * for it.
 *
 * Moved here from apps/api (T-0089's custom-values.ts) by T-0094, so the
 * import worker audits a created contact through the same code as
 * createContact (D-L160).
 */
export async function recordAuditWithCustom(
  tx: TenantTx,
  event: AuditEventInput,
  customKeys: readonly string[],
): Promise<void> {
  const all = [...event.changes, ...customKeys.map((key) => redactedChange(key))];
  if (all.length <= AUDIT_EVENT_MAX_CHANGES) {
    await recordAuditEvent(tx, { ...event, changes: all });
    return;
  }
  for (let start = 0; start < all.length; start += AUDIT_EVENT_MAX_CHANGES) {
    await recordAuditEvent(tx, { ...event, changes: all.slice(start, start + AUDIT_EVENT_MAX_CHANGES) });
  }
}
