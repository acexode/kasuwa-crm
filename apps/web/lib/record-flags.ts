import { featureFlagClient, initialiseFeatureFlags, toEvaluationContext } from '@kasuwa/feature-flags';

/**
 * The P05 record placeholders (T-0134, D-L194): designed blocks whose module
 * does not exist yet, drawn in the design's own empty or disabled state. Read
 * on the SERVER, like every flag here, and passed to the screen as booleans,
 * so with a flag off neither the block nor its strings ship.
 *
 * A separate file from `feature-flags.ts` so the record's switches travel as
 * one object and no client module names a flag.
 */
export interface RecordPlaceholders {
  /** Composer with the 24-hour window, and the WhatsApp/SMS/Email actions. */
  readonly composer: boolean;
  readonly aiSummary: boolean;
  readonly aiNba: boolean;
  /** The Call action, disabled until telephony places calls. */
  readonly call: boolean;
  /** Related deals, tickets, quotes, invoices and campaigns, and their New deal / New ticket / payment-link actions. */
  readonly related: boolean;
  /** The contact's Identity card (NIN, BVN). */
  readonly identity: boolean;
  readonly addresses: boolean;
  readonly follow: boolean;
}

export const NO_PLACEHOLDERS: RecordPlaceholders = {
  composer: false,
  aiSummary: false,
  aiNba: false,
  call: false,
  related: false,
  identity: false,
  addresses: false,
  follow: false,
};

const CRM_SHELL = 'process:crm-shell';

async function on(flag: string): Promise<boolean> {
  return featureFlagClient().getBooleanValue(flag, false, toEvaluationContext({ tenantId: CRM_SHELL }));
}

export async function recordPlaceholders(): Promise<RecordPlaceholders> {
  await initialiseFeatureFlags();
  const [composer, aiSummary, aiNba, call, related, identity, addresses, follow] = await Promise.all([
    on('whatsapp_composer'),
    on('ai_summary'),
    on('ai_nba'),
    on('call_bar'),
    on('record_related'),
    on('identity_check'),
    on('record_addresses'),
    on('record_follow'),
  ]);
  return { composer, aiSummary, aiNba, call, related, identity, addresses, follow };
}
