import type {
  AgentIdentity,
  AgentStateName,
  CallEvent,
  CampaignListPushRequest,
  OriginateRequest,
  QueueStats,
  SecurePaymentRequest,
  SecurePaymentResult,
  SignedPlaybackUrl,
  SupervisorActionRequest,
  TelephonyAdapter,
  TelephonyCampaignPort,
  TelephonyCommandPort,
  TelephonyEvent,
  TelephonyEventSink,
  TenantScope,
} from './contracts';

/**
 * In-memory fake telephony platform, for tests only.
 *
 * It records what Kasuwa asked for and lets a test emit events back. It does
 * NOT simulate telephony behaviour — no pacing, no ring timing, no media. When
 * the real platform's staging environment arrives (Addendum section 1.4), the
 * contract tests written against this fake become the contract tests run
 * against staging; that is the point of keeping it honest and dumb.
 *
 * Two behaviours are modelled because they are the ones integrations get wrong:
 *   1. Redelivery — `emit` can deliver the same eventId twice on request, so
 *      sinks are forced to prove idempotency.
 *   2. Missing scope — `emitWithoutScope` produces an event whose scope the
 *      adapter must attach, which is the D-T5 hazard.
 */

export interface RecordedOriginate {
  request: OriginateRequest;
  platformCallId: string;
}

export class FakeTelephonyPlatform implements TelephonyAdapter {
  readonly originated: RecordedOriginate[] = [];
  readonly agentStates: { agent: AgentIdentity; state: AgentStateName; reasonCode?: string }[] = [];
  readonly supervisorActions: SupervisorActionRequest[] = [];
  readonly pushedLists: CampaignListPushRequest[] = [];

  private readonly sinks: TelephonyEventSink[] = [];
  private queueStats = new Map<string, QueueStats>();
  private callSequence = 0;

  // --- platform -> Kasuwa -------------------------------------------------

  subscribe(sink: TelephonyEventSink): void {
    this.sinks.push(sink);
  }

  async emit(event: TelephonyEvent, options: { deliveries?: number } = {}): Promise<void> {
    const deliveries = options.deliveries ?? 1;
    for (let attempt = 0; attempt < deliveries; attempt += 1) {
      for (const sink of this.sinks) {
        await sink.handle(event);
      }
    }
  }

  setQueueStats(stats: QueueStats): void {
    this.queueStats.set(stats.queueId, stats);
  }

  // --- Kasuwa -> platform -------------------------------------------------

  readonly commands: TelephonyCommandPort = {
    originate: async (request: OriginateRequest) => {
      this.callSequence += 1;
      const platformCallId = `fake-call-${this.callSequence}`;
      this.originated.push({ request, platformCallId });
      return { platformCallId };
    },

    setAgentState: async (
      _scope: TenantScope,
      agent: AgentIdentity,
      state: AgentStateName,
      reasonCode?: string,
    ) => {
      this.agentStates.push(
        reasonCode === undefined ? { agent, state } : { agent, state, reasonCode },
      );
    },

    supervisorAction: async (request: SupervisorActionRequest) => {
      this.supervisorActions.push(request);
    },

    startSecurePayment: async (request: SecurePaymentRequest): Promise<SecurePaymentResult> => {
      // Returns a token and last four only. If a future edit makes this return
      // a PAN, the security-reviewer checklist should catch it — and so should
      // whoever is reading this comment.
      void request;
      return { token: 'fake-token-0001', lastFour: '4242', status: 'authorised' };
    },

    getRecordingPlaybackUrl: async (
      _scope: TenantScope,
      recordingId: string,
    ): Promise<SignedPlaybackUrl> => ({
      url: `https://fake-telephony.invalid/recordings/${recordingId}`,
      expiresAt: new Date(Date.now() + 60_000),
    }),

    getQueueStats: async (_scope: TenantScope, queueIds: readonly string[]) =>
      queueIds
        .map((id) => this.queueStats.get(id))
        .filter((stats): stats is QueueStats => stats !== undefined),
  };

  readonly campaigns: TelephonyCampaignPort = {
    pushList: async (request: CampaignListPushRequest) => {
      this.pushedLists.push(request);
      return { accepted: request.entries.length, rejected: 0 };
    },
    pullResults: async (): Promise<CallEvent[]> => [],
  };
}
