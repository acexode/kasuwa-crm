import { z } from 'zod';

/**
 * Channel provider contract — v0.
 *
 * The single boundary between Kasuwa and whichever messaging provider sends an
 * SMS or WhatsApp message (CLAUDE.md section 2 rule 8). Which real provider
 * sits behind it is an OPEN decision (T-0017); until it is made, the only
 * implementation is the in-memory fake in ./fake.ts.
 *
 * Callers never talk to a provider directly. They go through
 * `createChannelAdapter` (./adapter.ts), which validates, applies DND and
 * sanitises errors in front of ANY provider.
 */

export const TenantScope = z.object({
  tenantId: z.string().uuid(),
  programmeId: z.string().uuid(),
});
export type TenantScope = z.infer<typeof TenantScope>;

/**
 * Stated by the caller, never inferred from the body. DND restricts
 * promotional traffic only, and "it looked transactional" is no defence.
 */
export const MessagePurpose = z.enum(['transactional', 'promotional']);
export type MessagePurpose = z.infer<typeof MessagePurpose>;

export const ChannelKind = z.enum(['sms', 'whatsapp']);
export type ChannelKind = z.infer<typeof ChannelKind>;

export const DeliveryState = z.enum(['queued', 'sent', 'delivered', 'failed']);
export type DeliveryState = z.infer<typeof DeliveryState>;

/** E.164: a plus, a non-zero leading digit, at most 15 digits in all. */
export const E164 = z.string().regex(/^\+[1-9]\d{7,14}$/);

export const SendRequest = z.object({
  scope: TenantScope,
  channel: ChannelKind,
  to: E164,
  /** WhatsApp's free-form ceiling; SMS concatenation sits well under it. */
  body: z.string().min(1).max(4096),
  purpose: MessagePurpose,
});
export type SendRequest = z.infer<typeof SendRequest>;

export interface SendResult {
  messageId: string;
  state: DeliveryState;
}

export interface DeliveryStatus {
  messageId: string;
  state: DeliveryState;
  updatedAt: Date;
}

export const MessageId = z.string().min(1).max(256);

/**
 * What every provider implements, and what `createChannelAdapter` returns.
 *
 * A provider SHOULD throw the typed errors in ./errors.ts for failures it can
 * classify. Anything else it throws is discarded by the adapter and replaced
 * with a typed error, because a vendor error routinely embeds the request.
 */
export interface ChannelProvider {
  send(request: SendRequest): Promise<SendResult>;
  getDeliveryStatus(scope: TenantScope, messageId: string): Promise<DeliveryStatus>;
}

/** Nigeria's NCC Do-Not-Disturb register, keyed on E.164. */
export interface DndRegister {
  isRegistered(e164: string): Promise<boolean>;
}

export type ChannelLogFn = (message: string, fields?: Record<string, unknown>) => void;

export interface ChannelLogger {
  debug: ChannelLogFn;
  info: ChannelLogFn;
  warn: ChannelLogFn;
  error: ChannelLogFn;
}
