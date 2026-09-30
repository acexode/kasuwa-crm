import { z } from 'zod';

/**
 * The browser's half of `docs/api/admin.openapi.yaml` — the contract behind the
 * 22 P02 admin-console screens.
 *
 * Zod at the boundary, per `CLAUDE.md` section 4. An HTTP response is untrusted
 * input even when our own server sent it; a cast would let a contract change
 * surface as `undefined` three renders later, on a screen, in front of a
 * customer.
 *
 * SAME-ORIGIN. Every path here is relative, exactly as in `auth-api.ts`: the
 * browser never learns an API hostname, nothing needs `process.env` (which is
 * lint-enforced), and a 300 ms link is not asked for a second DNS lookup, TLS
 * handshake and CORS preflight per request.
 *
 * SWITCH ON `code`, NEVER ON `message`. `message` is English prose for logs;
 * `code` is a fixed enum and the web app localises it as `admin.error.<code>`.
 *
 * NULL IS NOT ZERO, AND NULL IS NOT "OFF". Three fields in this contract are
 * nullable because the system genuinely does not know the answer:
 *
 *   `presence`         the telephony adapter is unavailable (ADR-0003)
 *   `needed`           the WFM forecast is unavailable (ADR-0003)
 *   `slaAttainment7d`  the programme has no traffic yet
 *   `usageCount90d`    the interaction aggregate is unavailable
 *
 * Every one of them is `.nullable()` here and rendered as "not known" — never
 * as "Offline", never as `0%`. A supervisor told an agent is offline when the
 * truth is that we lost the feed will make a staffing decision on a fiction.
 */

/** The fixed `code` enum from the contract's `Error` schema. */
export const AdminErrorCode = z.enum([
  'validation_failed',
  'not_authenticated',
  'not_permitted',
  'not_found',
  'duplicate_name',
  'duplicate_code',
  'stale_write',
  'role_hierarchy_cycle',
  'role_in_use',
  'legal_hold_active',
  'too_many_requests',
  'not_implemented',
  'service_unavailable',
]);
export type AdminErrorCode = z.infer<typeof AdminErrorCode>;

export const ApiError = z.object({
  statusCode: z.number(),
  error: z.string(),
  code: AdminErrorCode,
  message: z.string(),
  details: z.array(z.object({ path: z.string(), code: z.string() })).optional(),
  conflictingIds: z.array(z.string()).optional(),
  retryAt: z.string().optional(),
});
export type ApiError = z.infer<typeof ApiError>;

/**
 * `network` is not in the contract's enum because the server can never send it:
 * it means the request never arrived. It is localised from `admin.error.network`
 * like any other code.
 */
export const NETWORK_ERROR_CODE = 'network' as const;
export type ScreenErrorCode = AdminErrorCode | typeof NETWORK_ERROR_CODE;

export interface ScreenError {
  readonly code: ScreenErrorCode;
  readonly details?: readonly { path: string; code: string }[];
}

export const NETWORK_FAILURE: ScreenError = { code: NETWORK_ERROR_CODE };

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ScreenError };

// ---------------------------------------------------------------------------
// Schemas — one per response body the screens in this build actually read.
// ---------------------------------------------------------------------------

const Severity = z.enum(['info', 'success', 'warning', 'danger']);
export type Severity = z.infer<typeof Severity>;

export const HealthCheck = z.object({
  checkId: z.string(),
  label: z.string(),
  status: z.enum(['pass', 'warn', 'fail', 'todo']),
  points: z.number(),
  settingId: z.string().nullable().optional(),
});
export type HealthCheck = z.infer<typeof HealthCheck>;

export const AdminHomeSummary = z.object({
  tenant: z.object({
    id: z.string(),
    name: z.string(),
    planName: z.string(),
    countryCount: z.number(),
    userCount: z.number(),
  }),
  dataRegion: z.object({ code: z.string(), displayName: z.string() }),
  health: z.object({
    score: z.number(),
    outOf: z.number(),
    pointsAvailable: z.number(),
    checkedAt: z.string(),
    checks: z.array(HealthCheck),
  }),
});
export type AdminHomeSummary = z.infer<typeof AdminHomeSummary>;

export const AdminAlert = z.object({
  id: z.string(),
  severity: Severity,
  category: z.enum(['security', 'channels', 'compliance', 'billing', 'data']),
  title: z.string(),
  body: z.string(),
  sourceLabel: z.string().nullable().optional(),
  raisedAt: z.string(),
  actionLabel: z.string().nullable().optional(),
  settingId: z.string().nullable().optional(),
  dismissed: z.boolean(),
});
export type AdminAlert = z.infer<typeof AdminAlert>;

export const AdminAlertList = z.object({ items: z.array(AdminAlert) });
export type AdminAlertList = z.infer<typeof AdminAlertList>;

export const Money = z.object({
  amountMinor: z.string(),
  currency: z.string(),
  estimatedTotalMinor: z.string().nullable().optional(),
});
export type Money = z.infer<typeof Money>;

export const UsageMeter = z.object({
  meterId: z.string(),
  label: z.string(),
  unit: z.string(),
  used: z.number(),
  limit: z.number().nullable().optional(),
  warnAtPercent: z.number().nullable().optional(),
  note: z.string().nullable().optional(),
  spend: Money.nullable().optional(),
});
export type UsageMeter = z.infer<typeof UsageMeter>;

export const UsageSummary = z.object({
  periodStart: z.string(),
  periodEnd: z.string(),
  meters: z.array(UsageMeter),
});
export type UsageSummary = z.infer<typeof UsageSummary>;

export const SettingsMenuBadges = z.object({
  badges: z.array(
    z.object({ settingId: z.string(), count: z.number(), severity: Severity }),
  ),
});
export type SettingsMenuBadges = z.infer<typeof SettingsMenuBadges>;

export const ProgrammeStatus = z.enum(['active', 'paused', 'draft', 'archived']);
export type ProgrammeStatus = z.infer<typeof ProgrammeStatus>;

export const ProgrammeChannel = z.enum(['whatsapp', 'voice', 'sms', 'email', 'ussd']);
export type ProgrammeChannel = z.infer<typeof ProgrammeChannel>;

export const Programme = z.object({
  id: z.string(),
  name: z.string(),
  clientName: z.string().nullable().optional(),
  reference: z.string().nullable().optional(),
  countryCode: z.string().nullable().optional(),
  status: ProgrammeStatus,
  channels: z.array(ProgrammeChannel).optional(),
  agentCount: z.number().nullable().optional(),
  slaAttainment7d: z.number().nullable().optional(),
  retentionSummary: z.string().nullable().optional(),
});
export type Programme = z.infer<typeof Programme>;

export const Page = z.object({
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  totalCount: z.number().nullable().optional(),
});

export const ProgrammeList = z.object({
  items: z.array(Programme),
  statusCounts: z.object({
    active: z.number().optional(),
    paused: z.number().optional(),
    draft: z.number().optional(),
    archived: z.number().optional(),
  }),
  page: Page,
});
export type ProgrammeList = z.infer<typeof ProgrammeList>;

export const ProgrammeDetail = Programme.extend({
  version: z.number(),
  businessUnitId: z.string().optional(),
  contract: z
    .object({
      reference: z.string().nullable().optional(),
      startedOn: z.string().nullable().optional(),
      renewsOn: z.string().nullable().optional(),
      billingBasis: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  operating: z
    .object({
      timeZone: z.string().optional(),
      hoursSummary: z.string().nullable().optional(),
      holidayCalendar: z.string().nullable().optional(),
      channels: z
        .array(z.object({ channel: ProgrammeChannel, label: z.string() }))
        .optional(),
    })
    .nullable()
    .optional(),
  people: z
    .object({
      programmeManagerName: z.string().nullable().optional(),
      teamLeadCount: z.number().nullable().optional(),
      agentCount: z.number().nullable().optional(),
      qaAnalystCount: z.number().nullable().optional(),
      portalUserCount: z.number().nullable().optional(),
    })
    .nullable()
    .optional(),
});
export type ProgrammeDetail = z.infer<typeof ProgrammeDetail>;

export const ProgrammeKpis = z.object({
  window: z.enum(['last_7_days', 'last_30_days']),
  kpis: z.array(
    z.object({
      kpiId: z.string(),
      label: z.string(),
      format: z.enum(['percent', 'count', 'duration_seconds']),
      value: z.number(),
      targetValue: z.number().nullable().optional(),
      status: z.enum(['good', 'warn', 'bad']).nullable().optional(),
    }),
  ),
});
export type ProgrammeKpis = z.infer<typeof ProgrammeKpis>;

export const Presence = z.enum(['available', 'on_call', 'on_break', 'offline']);
export type Presence = z.infer<typeof Presence>;

export const ProgrammeAgentList = z.object({
  items: z.array(
    z.object({
      userId: z.string(),
      displayName: z.string(),
      initials: z.string().optional(),
      teamName: z.string().nullable().optional(),
      skills: z.array(z.string()).optional(),
      languages: z.array(z.string()).optional(),
      /** Null means "we do not know". It must never render as "Offline". */
      presence: Presence.nullable(),
    }),
  ),
  page: Page,
});
export type ProgrammeAgentList = z.infer<typeof ProgrammeAgentList>;

export const SkillCover = z.object({
  shiftDate: z.string(),
  shift: z.enum(['day', 'night']),
  timeZone: z.string(),
  items: z.array(
    z.object({
      skillId: z.string(),
      label: z.string(),
      rostered: z.number(),
      /** Null when the WFM forecast is unavailable. No bar, no judgement. */
      needed: z.number().nullable().optional(),
    }),
  ),
});
export type SkillCover = z.infer<typeof SkillCover>;

export const SlaClock = z.enum(['business_hours', 'always']);
export type SlaClock = z.infer<typeof SlaClock>;

export const SlaNotifyRole = z.enum([
  'assigned_agent',
  'team_lead',
  'programme_manager',
  'programme_manager_and_client',
]);
export type SlaNotifyRole = z.infer<typeof SlaNotifyRole>;

export const SlaTarget = z.object({
  channel: ProgrammeChannel,
  firstResponseSeconds: z.number().nullable(),
  /** Null means there is no resolution target — voice's "Same call". */
  resolutionSeconds: z.number().nullable(),
  clock: SlaClock,
});
export type SlaTarget = z.infer<typeof SlaTarget>;

export const SlaPolicy = z.object({
  version: z.number(),
  targets: z.array(SlaTarget),
  pauseOutsideOperatingHours: z.boolean(),
  pauseAwaitingCustomer: z.boolean(),
  warnAtPercentOfTarget: z.number(),
  warnNotifyRole: SlaNotifyRole.optional(),
  breachNotifyRole: SlaNotifyRole.optional(),
  operatingHoursSummary: z.string().nullable().optional(),
  timeZone: z.string().optional(),
});
export type SlaPolicy = z.infer<typeof SlaPolicy>;

export const DispositionCategory = z.enum([
  'promise_to_pay',
  'resolved',
  'callback',
  'escalated',
  'not_reached',
]);
export type DispositionCategory = z.infer<typeof DispositionCategory>;

export const Disposition = z.object({
  id: z.string(),
  code: z.string(),
  label: z.string(),
  category: DispositionCategory,
  noteRequired: z.boolean(),
  followUpRequired: z.boolean(),
  active: z.boolean(),
  position: z.number(),
  /** Null when the aggregate is unavailable. The dialog then omits the line. */
  usageCount90d: z.number().nullable().optional(),
});
export type Disposition = z.infer<typeof Disposition>;

export const DispositionList = z.object({
  items: z.array(Disposition),
  usageWindowDays: z.number(),
});
export type DispositionList = z.infer<typeof DispositionList>;

export const AuditEntrySummary = z.object({
  id: z.string(),
  occurredAt: z.string(),
  action: z.string(),
  actor: z.object({ displayName: z.string().nullable().optional() }).partial().passthrough(),
  recordLabel: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
});

export const AuditEventList = z.object({
  items: z.array(AuditEntrySummary),
  page: Page,
});
export type AuditEventList = z.infer<typeof AuditEventList>;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

async function request<T>(
  method: string,
  path: string,
  schema: z.ZodType<T>,
  init: { body?: unknown; signal?: AbortSignal } = {},
): Promise<Result<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      ...(init.body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) }),
      ...(init.signal === undefined ? {} : { signal: init.signal }),
    });
  } catch {
    return { ok: false, error: NETWORK_FAILURE };
  }

  if (response.status === 204) {
    const empty = schema.safeParse(undefined);
    return empty.success
      ? { ok: true, value: empty.data }
      : { ok: false, error: NETWORK_FAILURE };
  }

  const payload: unknown = await response.json().catch(() => null);

  if (response.ok) {
    const parsed = schema.safeParse(payload);
    if (parsed.success) return { ok: true, value: parsed.data };
    // The server answered with something the contract does not describe. That
    // is not the user's fault and must not be dressed up as one.
    return { ok: false, error: NETWORK_FAILURE };
  }

  const parsed = ApiError.safeParse(payload);
  if (parsed.success) {
    return {
      ok: false,
      error: {
        code: parsed.data.code,
        ...(parsed.data.details === undefined ? {} : { details: parsed.data.details }),
      },
    };
  }
  return { ok: false, error: NETWORK_FAILURE };
}

const BASE = '/api/v1/admin';

/** `encodeURIComponent` on every interpolated id. An id is data, not a path. */
function id(value: string): string {
  return encodeURIComponent(value);
}

export const NOTHING = z.undefined();

export function getHomeSummary(signal?: AbortSignal) {
  return request('GET', `${BASE}/home/summary`, AdminHomeSummary, { ...(signal ? { signal } : {}) });
}

export function listAlerts(includeDismissed: boolean, signal?: AbortSignal) {
  const query = includeDismissed ? '?includeDismissed=true' : '';
  return request('GET', `${BASE}/home/alerts${query}`, AdminAlertList, {
    ...(signal ? { signal } : {}),
  });
}

export function dismissAlert(alertId: string, signal?: AbortSignal) {
  return request('PUT', `${BASE}/home/alerts/${id(alertId)}/dismissal`, NOTHING, {
    ...(signal ? { signal } : {}),
  });
}

export function restoreAlert(alertId: string, signal?: AbortSignal) {
  return request('DELETE', `${BASE}/home/alerts/${id(alertId)}/dismissal`, NOTHING, {
    ...(signal ? { signal } : {}),
  });
}

export function getUsage(signal?: AbortSignal) {
  return request('GET', `${BASE}/home/usage`, UsageSummary, { ...(signal ? { signal } : {}) });
}

export function getSettingsMenuBadges(signal?: AbortSignal) {
  return request('GET', `${BASE}/settings-menu/badges`, SettingsMenuBadges, {
    ...(signal ? { signal } : {}),
  });
}

export function listRecentAuditEvents(signal?: AbortSignal) {
  return request('GET', `${BASE}/audit/events?pageSize=5`, AuditEventList, {
    ...(signal ? { signal } : {}),
  });
}

export function listProgrammes(
  options: { q?: string; status?: ProgrammeStatus },
  signal?: AbortSignal,
) {
  const query = new URLSearchParams();
  if (options.q !== undefined && options.q !== '') query.set('q', options.q);
  if (options.status !== undefined) query.set('status', options.status);
  const suffix = query.size === 0 ? '' : `?${query.toString()}`;
  return request('GET', `${BASE}/programmes${suffix}`, ProgrammeList, {
    ...(signal ? { signal } : {}),
  });
}

export function getProgramme(programmeId: string, signal?: AbortSignal) {
  return request('GET', `${BASE}/programmes/${id(programmeId)}`, ProgrammeDetail, {
    ...(signal ? { signal } : {}),
  });
}

export function getProgrammeKpis(programmeId: string, signal?: AbortSignal) {
  return request('GET', `${BASE}/programmes/${id(programmeId)}/kpis`, ProgrammeKpis, {
    ...(signal ? { signal } : {}),
  });
}

export function listProgrammeAgents(programmeId: string, q: string, signal?: AbortSignal) {
  const suffix = q === '' ? '' : `?q=${encodeURIComponent(q)}`;
  return request('GET', `${BASE}/programmes/${id(programmeId)}/agents${suffix}`, ProgrammeAgentList, {
    ...(signal ? { signal } : {}),
  });
}

export function getSkillCover(programmeId: string, signal?: AbortSignal) {
  return request('GET', `${BASE}/programmes/${id(programmeId)}/skill-cover`, SkillCover, {
    ...(signal ? { signal } : {}),
  });
}

export function getSla(programmeId: string, signal?: AbortSignal) {
  return request('GET', `${BASE}/programmes/${id(programmeId)}/sla`, SlaPolicy, {
    ...(signal ? { signal } : {}),
  });
}

export interface SlaPolicyWrite {
  version: number;
  targets: readonly SlaTarget[];
  pauseOutsideOperatingHours: boolean;
  pauseAwaitingCustomer: boolean;
  warnAtPercentOfTarget: number;
  warnNotifyRole: SlaNotifyRole;
  breachNotifyRole: SlaNotifyRole;
}

export function saveSla(programmeId: string, body: SlaPolicyWrite, signal?: AbortSignal) {
  return request('PUT', `${BASE}/programmes/${id(programmeId)}/sla`, SlaPolicy, {
    body,
    ...(signal ? { signal } : {}),
  });
}

export function listDispositions(programmeId: string, signal?: AbortSignal) {
  return request('GET', `${BASE}/programmes/${id(programmeId)}/dispositions`, DispositionList, {
    ...(signal ? { signal } : {}),
  });
}

export function deleteDisposition(
  programmeId: string,
  dispositionId: string,
  signal?: AbortSignal,
) {
  return request(
    'DELETE',
    `${BASE}/programmes/${id(programmeId)}/dispositions/${id(dispositionId)}`,
    NOTHING,
    { ...(signal ? { signal } : {}) },
  );
}

export function deactivateDisposition(
  programmeId: string,
  dispositionId: string,
  signal?: AbortSignal,
) {
  return request(
    'PATCH',
    `${BASE}/programmes/${id(programmeId)}/dispositions/${id(dispositionId)}`,
    Disposition,
    { body: { active: false }, ...(signal ? { signal } : {}) },
  );
}
