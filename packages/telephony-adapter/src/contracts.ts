import { z } from 'zod';

/**
 * Telephony integration contract — v0, PROVISIONAL.
 *
 * Kasuwa does not build telephony (Addendum A1 section 1.1). The platform
 * already exists; this package is the ONLY place Kasuwa talks to it. No other
 * module may import a platform SDK or call a platform URL — the Nx boundary
 * rule enforces that `scope:domain` cannot reach past `scope:adapter`.
 *
 * Every type here is derived from the capability table in Addendum A1 section
 * 1.2. Where that table is ambiguous the contract takes the conservative
 * option and the ambiguity is recorded in team/DECISIONS.md:
 *
 *   D-T1  WebRTC SDK vs embedded softphone  -> TelephonySoftphonePort is
 *         deliberately left undefined below; the event/command halves do not
 *         depend on the answer, so this package will not need reshaping.
 *   D-T2  Who owns the dialer list          -> CampaignPort assumes Kasuwa is
 *         the source of truth for contacts and consent and pushes filtered
 *         lists, per the addendum's own recommendation.
 *   D-T5  Platform tenancy model            -> events are typed as POSSIBLY
 *         lacking tenant/programme (`scope` is optional on the wire type and
 *         required on the normalised type). It is the adapter implementation's
 *         job to attach scope, whether it reads it from the event or derives it
 *         from the connection. This is safe under both answers to D-T5 and is
 *         the single most load-bearing decision in this file.
 *
 * Nothing here is implemented against a real platform. Until the API spec,
 * event catalogue and staging environment arrive (Addendum section 1.4), the
 * only implementation is the in-memory fake in ./fake.ts.
 */

// ---------------------------------------------------------------------------
// Scope — Addendum 1.2, final row: "Every event and call carries tenant_id +
// programme_id". Kasuwa treats this as non-negotiable on its side of the
// boundary even if the platform cannot guarantee it on the wire.
// ---------------------------------------------------------------------------

export const TenantScope = z.object({
  tenantId: z.string().uuid(),
  programmeId: z.string().uuid(),
});
export type TenantScope = z.infer<typeof TenantScope>;

// ---------------------------------------------------------------------------
// Agent identity — Addendum 1.2 row 1
// ---------------------------------------------------------------------------

export const AgentIdentity = z.object({
  /** Kasuwa `user.id`. */
  kasuwaUserId: z.string().uuid(),
  /** Opaque agent identifier on the telephony platform. */
  platformAgentId: z.string().min(1),
});
export type AgentIdentity = z.infer<typeof AgentIdentity>;

// ---------------------------------------------------------------------------
// Agent state — Addendum 1.2 row 2. Consumed by the workspace state selector,
// the wallboard, and (via D-W2) WFM adherence.
// ---------------------------------------------------------------------------

export const AgentStateName = z.enum([
  'available',
  'on_call',
  'wrap_up',
  'break',
  'offline',
  'unknown',
]);
export type AgentStateName = z.infer<typeof AgentStateName>;

export const AgentStateEvent = z.object({
  type: z.literal('agent.state_changed'),
  eventId: z.string().min(1),
  occurredAt: z.coerce.date(),
  scope: TenantScope,
  agent: AgentIdentity,
  state: AgentStateName,
  /** Platform-defined aux/break reason code, e.g. "lunch", "coaching". */
  reasonCode: z.string().optional(),
});
export type AgentStateEvent = z.infer<typeof AgentStateEvent>;

// ---------------------------------------------------------------------------
// Call lifecycle — Addendum 1.2 row 3. Screen-pop has a 1.5s p95 budget
// (PRD 2.13), so this is the latency-critical path.
// ---------------------------------------------------------------------------

export const CallDirection = z.enum(['inbound', 'outbound']);
export type CallDirection = z.infer<typeof CallDirection>;

const CallEventBase = z.object({
  eventId: z.string().min(1),
  occurredAt: z.coerce.date(),
  scope: TenantScope,
  /** Platform call identifier; stable across the life of the call. */
  platformCallId: z.string().min(1),
  direction: CallDirection,
  /** Calling party in E.164. May be absent when withheld. */
  ani: z.string().optional(),
  /** Called party in E.164. */
  dnis: z.string().optional(),
  queueId: z.string().optional(),
  campaignId: z.string().optional(),
  agent: AgentIdentity.optional(),
});

export const CallRingingEvent = CallEventBase.extend({ type: z.literal('call.ringing') });
export const CallAnsweredEvent = CallEventBase.extend({ type: z.literal('call.answered') });
export const CallHeldEvent = CallEventBase.extend({ type: z.literal('call.held') });
export const CallResumedEvent = CallEventBase.extend({ type: z.literal('call.resumed') });
export const CallTransferredEvent = CallEventBase.extend({
  type: z.literal('call.transferred'),
  transferredTo: AgentIdentity.optional(),
});
export const CallEndedEvent = CallEventBase.extend({
  type: z.literal('call.ended'),
  durationSeconds: z.number().int().nonnegative(),
  /** Platform-side hangup cause; Kasuwa dispositions are separate and its own. */
  hangupCause: z.string().optional(),
});

export const CallEvent = z.discriminatedUnion('type', [
  CallRingingEvent,
  CallAnsweredEvent,
  CallHeldEvent,
  CallResumedEvent,
  CallTransferredEvent,
  CallEndedEvent,
]);
export type CallEvent = z.infer<typeof CallEvent>;

export const TelephonyEvent = z.union([CallEvent, AgentStateEvent]);
export type TelephonyEvent = z.infer<typeof TelephonyEvent>;

// ---------------------------------------------------------------------------
// Recording metadata & transcripts — Addendum 1.2 rows 8 and 9.
// Kasuwa never stores audio; it stores metadata and requests short-lived URLs.
// Whether the platform owns retention and PCI masking at all is D-T4, open.
// ---------------------------------------------------------------------------

export const RecordingRef = z.object({
  scope: TenantScope,
  platformCallId: z.string().min(1),
  recordingId: z.string().min(1),
  durationSeconds: z.number().int().nonnegative(),
  channels: z.union([z.literal(1), z.literal(2)]),
  /** True when the platform paused capture for a secure payment segment. */
  pciRedacted: z.boolean().default(false),
  retentionUntil: z.coerce.date().optional(),
  legalHold: z.boolean().default(false),
});
export type RecordingRef = z.infer<typeof RecordingRef>;

export const SignedPlaybackUrl = z.object({
  url: z.string().url(),
  expiresAt: z.coerce.date(),
});
export type SignedPlaybackUrl = z.infer<typeof SignedPlaybackUrl>;

export const TranscriptSegment = z.object({
  scope: TenantScope,
  platformCallId: z.string().min(1),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  speaker: z.enum(['agent', 'customer', 'unknown']),
  text: z.string(),
  isFinal: z.boolean(),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegment>;

// ---------------------------------------------------------------------------
// Queue stats — Addendum 1.2 row 12. Wallboard budget is 3s (PRD 2.13).
// ---------------------------------------------------------------------------

export const QueueStats = z.object({
  scope: TenantScope,
  queueId: z.string().min(1),
  waiting: z.number().int().nonnegative(),
  /** Average speed of answer, seconds. */
  asaSeconds: z.number().nonnegative(),
  /** Average handle time, seconds. */
  ahtSeconds: z.number().nonnegative(),
  /** Service level attainment as a fraction, e.g. 0.8 for 80%. */
  slaAttainment: z.number().min(0).max(1),
  abandonRate: z.number().min(0).max(1),
  observedAt: z.coerce.date(),
});
export type QueueStats = z.infer<typeof QueueStats>;

// ---------------------------------------------------------------------------
// Ports. Kasuwa -> platform is a "command"; platform -> Kasuwa is an "event" or
// a "callback". They are separate interfaces so an implementation can support
// one before the other, and so tests can fake one half.
// ---------------------------------------------------------------------------

export interface OriginateRequest {
  scope: TenantScope;
  agent: AgentIdentity;
  /** Destination in E.164. */
  destination: string;
  /** Presented caller id in E.164; local caller id is a compliance matter. */
  callerId?: string;
  /** Opaque key/value passed back on the resulting call events. */
  context?: Record<string, string>;
}

export interface SupervisorActionRequest {
  scope: TenantScope;
  supervisor: AgentIdentity;
  targetAgent: AgentIdentity;
  platformCallId: string;
  action: 'listen' | 'whisper' | 'barge';
}

export interface SecurePaymentRequest {
  scope: TenantScope;
  platformCallId: string;
  amountMinor: number;
  currency: string;
}

/**
 * Result of a secure payment. Kasuwa receives a token and last four digits and
 * NOTHING else — no PAN, ever, in any field, log or event. This type exists as
 * much to make that rule reviewable as to carry data.
 */
export interface SecurePaymentResult {
  token: string;
  lastFour: string;
  status: 'authorised' | 'declined' | 'abandoned';
}

/** Commands Kasuwa issues to the platform. */
export interface TelephonyCommandPort {
  /** Addendum 1.2 row 4. */
  originate(request: OriginateRequest): Promise<{ platformCallId: string }>;
  /** Addendum 1.2 row 2, write direction. */
  setAgentState(
    scope: TenantScope,
    agent: AgentIdentity,
    state: AgentStateName,
    reasonCode?: string,
  ): Promise<void>;
  /** Addendum 1.2 row 13. Audited on both sides. */
  supervisorAction(request: SupervisorActionRequest): Promise<void>;
  /** Addendum 1.2 row 10. */
  startSecurePayment(request: SecurePaymentRequest): Promise<SecurePaymentResult>;
  /** Addendum 1.2 row 8. */
  getRecordingPlaybackUrl(scope: TenantScope, recordingId: string): Promise<SignedPlaybackUrl>;
  /** Addendum 1.2 row 12, polling variant. */
  getQueueStats(scope: TenantScope, queueIds: readonly string[]): Promise<QueueStats[]>;
}

export interface CampaignListPushRequest {
  scope: TenantScope;
  campaignId: string;
  /**
   * Already filtered by Kasuwa for consent, DND and calling windows. Kasuwa is
   * the source of truth for contacts and consent (D-T2), so the platform
   * receives a list it may dial, not a list it must check.
   */
  entries: { contactId: string; destination: string; attempt: number }[];
}

/** Addendum 1.2 row 6. Shape is provisional until D-T2 is answered. */
export interface TelephonyCampaignPort {
  pushList(request: CampaignListPushRequest): Promise<{ accepted: number; rejected: number }>;
  pullResults(scope: TenantScope, campaignId: string, since: Date): Promise<CallEvent[]>;
}

/** Events the platform delivers to Kasuwa. */
export interface TelephonyEventSink {
  /**
   * Must be idempotent on `eventId` (Addendum 1.2 row 3: "idempotent event
   * ids"). Redelivery is normal, not exceptional.
   */
  handle(event: TelephonyEvent): Promise<void>;
}

/**
 * Addendum 1.2 row 7 — the pre-dial suppression check, in the platform ->
 * Kasuwa direction. Kasuwa implements this; the platform calls it.
 *
 * BLOCKED on D-T3: whether the platform will call this synchronously at all,
 * and whether a sub-100ms budget is something Kasuwa can commit to. Until that
 * is answered, do not build infrastructure around this interface.
 */
export interface MayDialPort {
  mayDial(request: {
    scope: TenantScope;
    destination: string;
    campaignId?: string;
  }): Promise<{ allowed: boolean; reason?: 'dnd' | 'no_consent' | 'quiet_hours' | 'suppressed' }>;
}

/**
 * Softphone / call control — Addendum 1.2 row 5.
 *
 * DELIBERATELY UNDEFINED. Whether Kasuwa renders its own softphone (needing
 * mute/hold/transfer/conference/DTMF) or embeds the platform's widget is D-T1,
 * unanswered. Defining a guess here would invite someone to build against it.
 * When D-T1 is answered, this becomes either a real interface or a deletion.
 */
export type TelephonySoftphonePort = never;

/** The complete platform-facing surface. Implementations may be partial. */
export interface TelephonyAdapter {
  readonly commands: TelephonyCommandPort;
  readonly campaigns: TelephonyCampaignPort;
}
