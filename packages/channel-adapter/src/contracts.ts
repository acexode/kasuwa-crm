import { z } from 'zod';

/**
 * Channel provider contract — v0.
 *
 * The single boundary between Kasuwa and whichever messaging provider sends an
 * SMS, a WhatsApp message or an email (CLAUDE.md section 2 rule 8). Which real provider
 * sits behind it is an OPEN decision (T-0017); until it is made, the only
 * implementation is the in-memory fake in ./fake.ts.
 *
 * Callers never talk to a provider directly. They go through
 * `createChannelAdapter` (./adapter.ts), which validates, applies DND and
 * sanitises errors in front of ANY provider.
 */

export const TenantScope = z.object({
  tenantId: z.uuid(),
  programmeId: z.uuid(),
});
export type TenantScope = z.infer<typeof TenantScope>;

/**
 * Stated by the caller, never inferred from the body. DND restricts
 * promotional traffic only, and "it looked transactional" is no defence.
 */
export const MessagePurpose = z.enum(['transactional', 'promotional']);
export type MessagePurpose = z.infer<typeof MessagePurpose>;

export const ChannelKind = z.enum(['sms', 'whatsapp', 'email']);
export type ChannelKind = z.infer<typeof ChannelKind>;

/** The channels Nigeria's DND register governs (D-L49). Email is not one of them. */
export type DndChannel = 'sms' | 'whatsapp';

export function isDndChannel(channel: ChannelKind): channel is DndChannel {
  return channel === 'sms' || channel === 'whatsapp';
}

export const DeliveryState = z.enum(['queued', 'sent', 'delivered', 'failed']);
export type DeliveryState = z.infer<typeof DeliveryState>;

/** E.164: a plus, a non-zero leading digit, at most 15 digits in all. */
export const E164 = z.string().regex(/^\+[1-9]\d{7,14}$/);

/**
 * An email address (D-L49), at most 320 characters as in the admin spec. Zod's
 * address rule refuses whitespace, so a CR/LF header-injection payload cannot
 * pass as an address. Never logged (CLAUDE.md 6.1).
 */
export const EmailAddress = z.email().max(320);

/** WhatsApp's free-form ceiling; SMS concatenation and an email body sit under it. */
const MessageBody = z.string().min(1).max(4096);

const IdempotencyKey = z.string().min(1).max(128);

const phoneRequest = <C extends DndChannel>(channel: C) =>
  z.object({
    scope: TenantScope,
    channel: z.literal(channel),
    to: E164,
    body: MessageBody,
    purpose: MessagePurpose,
    /** Required (D-L37 / T-0186): retries without a key can double-deliver OTPs. */
    idempotencyKey: IdempotencyKey,
  });

/**
 * One request shape per channel, discriminated on `channel` (D-L49). SMS and
 * WhatsApp keep the E.164 rule, so a national-format number still cannot slip
 * past a register keyed on E.164; email requires an address instead.
 */
export const SendRequest = z.discriminatedUnion('channel', [
  phoneRequest('sms'),
  phoneRequest('whatsapp'),
  z.object({
    scope: TenantScope,
    channel: z.literal('email'),
    to: EmailAddress,
    body: MessageBody,
    purpose: MessagePurpose,
    idempotencyKey: IdempotencyKey,
  }),
]);
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

/** Provider output is parsed, not trusted, before it is returned or logged. */
export const SendResultOutput = z.object({ messageId: MessageId, state: DeliveryState });
export const DeliveryStatusOutput = z.object({
  messageId: MessageId,
  state: DeliveryState,
  updatedAt: z.date().refine((date) => !Number.isNaN(date.getTime())),
});

/**
 * What every provider implements, and what `createChannelAdapter` returns.
 *
 * A provider SHOULD throw the typed errors in ./errors.ts for failures it can
 * classify. Anything else it throws is discarded by the adapter and replaced
 * with a typed error, because a vendor error routinely embeds the request.
 */
export const ChannelCapabilities = z.object({
  channels: z.array(ChannelKind).min(1),
  templates: z.boolean(),
  webhooks: z.boolean(),
});
export type ChannelCapabilities = z.infer<typeof ChannelCapabilities>;

export const ChannelTemplate = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  channel: ChannelKind,
  category: z.enum(['utility', 'marketing', 'authentication', 'service']).optional(),
  body: z.string().min(1).max(4096),
});
export type ChannelTemplate = z.infer<typeof ChannelTemplate>;

export const ChannelWebhookEvent = z
  .object({
    eventId: z.string().min(1).max(256),
    occurredAt: z.date(),
    type: z.enum(['message.delivered', 'message.failed', 'message.received']),
    providerMessageId: z.string().min(1).max(256),
  })
  .strict();
export type ChannelWebhookEvent = z.infer<typeof ChannelWebhookEvent>;

export interface ChannelProvider {
  send(request: SendRequest): Promise<SendResult>;
  getDeliveryStatus(scope: TenantScope, messageId: string): Promise<DeliveryStatus>;
  /** T-0186: which channels and features this provider exposes. */
  capabilities(): ChannelCapabilities;
  /** T-0186: list approved templates (empty until a real provider / inbox templates). */
  templates(scope: TenantScope): Promise<readonly ChannelTemplate[]>;
  /**
   * T-0186: parse a verified webhook body. Callers must verify the signature
   * themselves (or via a later provider helper); never logs rawBody.
   */
  parseWebhook(rawBody: string | Uint8Array): Promise<ChannelWebhookEvent>;
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
