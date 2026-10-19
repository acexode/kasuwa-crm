/**
 * The events the notifications flow publishes and consumes (T-0100,
 * ADR-0018 point 9). As for `contact.owner_changed`, the schema objects live
 * in @kasuwa/db's outbox registry, because appendOutboxEvent and the relay
 * must parse them and a shared package cannot import a domain; this is their
 * public name: the SAME objects, re-exported, so there is one schema and not
 * two that drift (T-0098 I5, T-0100 I2).
 *
 * `ContactOwnerChangedPayload` is re-exported by ../contact/contact-events.
 */
export {
  AccountOwnerChangedPayload,
  ActivityAssignedPayload,
  DealOwnerChangedPayload,
  ImportFinishedPayload,
} from '@kasuwa/db';

/** The closed vocabulary of the contract (NotificationKind), and migration 0044's CHECK. */
export const NOTIFICATION_KINDS = ['record_assigned', 'task_assigned', 'import_finished'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** NotificationObjectType, and migration 0044's CHECK. */
export const NOTIFICATION_OBJECT_TYPES = [
  'contact',
  'account',
  'deal',
  'activity',
  'import',
] as const;
export type NotificationObjectType = (typeof NOTIFICATION_OBJECT_TYPES)[number];

/** The kind that fixes each object type (`x-kasuwa-notification-kinds`). */
export const NOTIFICATION_KIND_OF: Readonly<Record<NotificationObjectType, NotificationKind>> = {
  contact: 'record_assigned',
  account: 'record_assigned',
  deal: 'record_assigned',
  activity: 'task_assigned',
  import: 'import_finished',
};
