/**
 * The audit writer (T-0025). It moved into @kasuwa/domain-core with T-0094
 * (D-L160), so the import worker audits through exactly the same code as the
 * API; this file keeps every API import path working. See
 * packages/domain/core/src/audit/audit-writer.ts for the rules.
 */
export {
  AUDIT_ACTIONS,
  AUDIT_CHANGE_VALUE_MAX_LENGTH,
  AUDIT_EVENT_MAX_CHANGES,
  AUDIT_OBJECT_TYPES,
  AUDIT_OBJECT_TYPE_LABELS,
  AuditProgrammeOutOfScopeError,
  InvalidAuditEventError,
  change,
  changedFields,
  recordAuditEvent,
  redactedChange,
} from '@kasuwa/domain-core';
export type {
  AuditAction,
  AuditChange,
  AuditEventInput,
  AuditObjectType,
} from '@kasuwa/domain-core';
