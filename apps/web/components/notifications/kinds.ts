import type { MessageId } from '@kasuwa/i18n/bundle';
import type { IconName } from '@kasuwa/ui';
import type { NotificationKind, NotificationObjectType } from '../../lib/notifications-api';

/**
 * How each notification type is drawn (P26, T-0137): the tinted tile and its
 * glyph, the object line's glyph and noun, and the filter entries in the
 * design's order. Types only from `@kasuwa/ui`, and no `'use client'`, so the
 * server-side message lists can read it too.
 *
 * The design's type list names ten entries. Three are produced today
 * (`record_assigned`, `task_assigned`, `import_finished`); the rest have no
 * producer yet and are drawn disabled behind `notification_types` (D-L194).
 * The design folds every assignment into one "Assignments" entry; the API
 * filters one kind at a time (T-0099), so tasks keep their own entry, placed
 * right after it.
 */

/** A type's tile: the soft tint, its text colour, and the glyph (P26 B row anatomy). */
export interface KindLook {
  readonly icon: IconName;
  readonly tile: string;
}

export const KIND_LOOK: Readonly<Record<NotificationKind, KindLook>> = {
  record_assigned: { icon: 'assignment_ind', tile: 'bg-primary-soft text-primary-text' },
  task_assigned: { icon: 'assignment_ind', tile: 'bg-primary-soft text-primary-text' },
  import_finished: { icon: 'upload_file', tile: 'bg-info-soft text-info-text' },
};

/** The object line: a 15px glyph and the object's noun ("Deal · Dangote Cement renewal"). */
export const OBJECT_LOOK: Readonly<Record<NotificationObjectType, { readonly icon: IconName; readonly label: MessageId }>> = {
  contact: { icon: 'person', label: 'notifications.object.contact' },
  account: { icon: 'apartment', label: 'notifications.object.account' },
  deal: { icon: 'handshake', label: 'notifications.object.deal' },
  activity: { icon: 'task_alt', label: 'notifications.object.activity' },
  import: { icon: 'upload_file', label: 'notifications.object.import' },
};

/** One entry of the filter rail's TYPE list: a served kind, or a type with no producer yet. */
export type TypeEntry =
  | { readonly kind: NotificationKind; readonly icon: IconName; readonly label: MessageId }
  | { readonly placeholder: string; readonly icon: IconName; readonly label: MessageId };

/** The TYPE list after "All types", in the design's order (P26 B, 1440). */
export const TYPE_ENTRIES: readonly TypeEntry[] = [
  { kind: 'record_assigned', icon: 'assignment_ind', label: 'notifications.kind.record_assigned' },
  { kind: 'task_assigned', icon: 'task_alt', label: 'notifications.kind.task_assigned' },
  { placeholder: 'mentions', icon: 'alternate_email', label: 'notifications.filter.mentions' },
  { placeholder: 'approvals', icon: 'approval', label: 'notifications.filter.approvals' },
  { placeholder: 'sla', icon: 'timer', label: 'notifications.type.sla' },
  { placeholder: 'campaigns', icon: 'campaign', label: 'notifications.type.campaigns' },
  { kind: 'import_finished', icon: 'upload_file', label: 'notifications.kind.import_finished' },
  { placeholder: 'payments', icon: 'payments', label: 'notifications.type.payments' },
  { placeholder: 'einvoices', icon: 'receipt_long', label: 'notifications.type.einvoices' },
  { placeholder: 'security', icon: 'shield_person', label: 'notifications.type.security' },
];

/** The SHOW list's entries with no producer yet (P26 B): Mentions and Approvals, drawn disabled. */
export const SHOW_PLACEHOLDERS: readonly { readonly id: string; readonly icon: IconName; readonly label: MessageId }[] = [
  { id: 'mentions', icon: 'alternate_email', label: 'notifications.filter.mentions' },
  { id: 'approvals', icon: 'approval', label: 'notifications.filter.approvals' },
];

/** The `live` entries the bell and the centre read (`notificationPlaceholders()`). */
export const TYPES_LIVE = 'notification-types';
export const PREFERENCES_LIVE = 'notification-preferences';
export const PREFERENCES_HREF = '/settings/notifications';
