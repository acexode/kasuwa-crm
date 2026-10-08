import {
  AUDIT_CHANGE_VALUE_MAX_LENGTH,
  change,
  redactedChange,
  type AuditChange,
  type AuditEventInput,
} from '../admin/audit/audit-writer';
import type { ComplianceDiff } from './script-publish';

/**
 * Authoring audit (T-0113; `x-kasuwa-audited` and `x-kasuwa-audit-names` in
 * docs/api/scripting.openapi.yaml; D-L91, D-L93, D-L96).
 *
 * One event per successful write, `object_type 'script'`, the script id as
 * `object_id`, the script's programme as `programme_id`, the session user as
 * actor (the writer binds it). NEVER WORDING: no node text, title or label,
 * no translation and no publish note reaches an event, by value or in a
 * label. The label is the script's name, which is programme configuration
 * (as a programme's or a disposition's name is), never a customer's.
 *
 *   - createScript: `created`, no changes.
 *   - updateScript: `updated`, naming which of `name`, `sourceLocale` and
 *     `graph` changed, by name only (redacted).
 *   - putScriptTranslation: `updated`, naming the locale
 *     (`translations.<locale>`, redacted).
 *   - publishScript: `published` (D-L96), naming the version number and the
 *     ids of the compliance nodes added, removed and changed since the
 *     previous version, each in entries of its own field. Node ids are
 *     configuration (NodeId), so they are values here; an unchanged
 *     compliance node is named nowhere. A long list is split over several
 *     entries of the same field, each value at most the writer's 300
 *     characters, ids comma-separated and never cut.
 */

export interface ScriptAuditSubject {
  id: string;
  programmeId: string;
  name: string;
}

function event(
  action: 'created' | 'updated' | 'published',
  script: ScriptAuditSubject,
  changes: AuditChange[],
): AuditEventInput {
  return {
    action,
    objectType: 'script',
    objectId: script.id,
    objectLabel: script.name,
    programmeId: script.programmeId,
    changes,
  };
}

export function scriptCreatedEvent(script: ScriptAuditSubject): AuditEventInput {
  return event('created', script, []);
}

/** The draft parts an update changed, by name: any of `name`, `sourceLocale`, `graph`. */
export function scriptUpdatedEvent(
  script: ScriptAuditSubject,
  parts: readonly ('name' | 'sourceLocale' | 'graph')[],
): AuditEventInput {
  return event(
    'updated',
    script,
    parts.map((part) => redactedChange(part)),
  );
}

export function scriptTranslatedEvent(
  script: ScriptAuditSubject,
  locale: string,
): AuditEventInput {
  return event('updated', script, [redactedChange(`translations.${locale}`)]);
}

/** Node ids, comma-separated, in values of at most `max` characters; an id is never split. */
export function chunkIds(ids: readonly string[], max = AUDIT_CHANGE_VALUE_MAX_LENGTH): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const id of ids) {
    const next = current === '' ? id : `${current},${id}`;
    if (next.length > max && current !== '') {
      chunks.push(current);
      current = id;
    } else {
      current = next;
    }
  }
  if (current !== '') chunks.push(current);
  return chunks;
}

export const COMPLIANCE_AUDIT_FIELDS = {
  added: 'complianceNodesAdded',
  removed: 'complianceNodesRemoved',
  changed: 'complianceNodesChanged',
} as const;

export function scriptPublishedEvent(
  script: ScriptAuditSubject,
  versionNumber: number,
  diff: ComplianceDiff,
): AuditEventInput {
  const changes: AuditChange[] = [change('versionNumber', null, String(versionNumber))];
  for (const bucket of ['added', 'removed', 'changed'] as const) {
    for (const value of chunkIds(diff[bucket])) {
      changes.push(change(COMPLIANCE_AUDIT_FIELDS[bucket], null, value));
    }
  }
  return event('published', script, changes);
}
