/**
 * What a contact write records (T-0041, T-0061). The rules moved into
 * @kasuwa/domain-core with T-0094 (D-L160), so the import worker audits each
 * contact it creates through the same writer; this file keeps the API's
 * import paths working. See packages/domain/core/src/contact/contact-audit.ts.
 */
export {
  CONTACT_AUDIT_VALUE_FIELDS,
  contactAuditEvent,
  contactChanges,
  encodeContactAuditValue,
} from '@kasuwa/domain-core';
