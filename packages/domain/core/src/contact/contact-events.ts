/**
 * The events the contact domain publishes (ADR-0018 point 9). The schema
 * objects live in @kasuwa/db's outbox registry, because appendOutboxEvent
 * and the relay must parse them and a shared package cannot import a domain;
 * this is their public name. The SAME object, re-exported, so there is one
 * schema and not two that drift (T-0098 I5). T-0100 wires the producer.
 */
export { ContactOwnerChangedPayload } from '@kasuwa/db';
