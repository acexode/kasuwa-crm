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
  // T-0088: a custom-field write refused at a limit (`field_limit_reached`,
  // `picklist_limit_reached` in `details`). Additive.
  'limit_reached',
  // T-0036: the code on every unexpected 500. Additive; generic copy.
  'internal_error',
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

export async function request<T>(
  method: string,
  path: string,
  schema: z.ZodType<T>,
  init: { body?: unknown; signal?: AbortSignal; noStore?: boolean } = {},
): Promise<Result<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      ...(init.noStore === true ? { cache: 'no-store' as const } : {}),
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

// ---------------------------------------------------------------------------
// Scripts, retention, portal users and archive — P02/B6, B7, B8, B9
// ---------------------------------------------------------------------------

/**
 * `rejected_by_provider` is the design's "Rejected by Meta". The provider is
 * NOT in the enum — only adapters name external systems (CLAUDE.md rule 8) —
 * and `providerName` is a display string the client renders without branching
 * on it.
 */
export const ScriptStatus = z.enum(['draft', 'in_review', 'published', 'rejected_by_provider']);
export type ScriptStatus = z.infer<typeof ScriptStatus>;

export const Script = z.object({
  id: z.string(),
  name: z.string(),
  channels: z.array(ProgrammeChannel).optional(),
  /** BCP 47 tags, e.g. `en`, `yo`, `ha`, `pcm`. Not display names. */
  languages: z.array(z.string()).optional(),
  version: z.number(),
  status: ScriptStatus,
  providerName: z.string().nullable().optional(),
  rejectionReason: z.string().nullable().optional(),
  updatedAt: z.string(),
});
export type Script = z.infer<typeof Script>;

export const ScriptList = z.object({ items: z.array(Script), page: Page });
export type ScriptList = z.infer<typeof ScriptList>;

export function listScripts(programmeId: string, signal?: AbortSignal) {
  return request('GET', `${BASE}/programmes/${id(programmeId)}/scripts`, ScriptList, {
    ...(signal ? { signal } : {}),
  });
}

/**
 * Periods are INTEGER DAYS on the wire. The design's "30 days … 10 years"
 * dropdown is a client-side list over the same field, which is why
 * `RETENTION_PERIOD_DAYS` lives in the screen and not here.
 *
 * `redactSensitiveNumbersInTranscripts` is a policy flag and nothing more. No
 * endpoint in this contract ever returns a NIN, a BVN or a PAN, redacted or
 * otherwise, whatever it is set to.
 */
export const RetentionExpiry = z.enum(['delete', 'anonymise']);
export type RetentionExpiry = z.infer<typeof RetentionExpiry>;

export const RetentionPolicy = z.object({
  version: z.number(),
  callRecordingsDays: z.number(),
  messageTranscriptsDays: z.number(),
  screenRecordingsDays: z.number(),
  qaEvaluationsDays: z.number(),
  onExpiry: RetentionExpiry,
  redactSensitiveNumbersInTranscripts: z.boolean(),
  legalHold: z.boolean(),
  /** Read-only. What these rules override. Null when there is no default. */
  workspaceDefaultDays: z.number().nullable().optional(),
});
export type RetentionPolicy = z.infer<typeof RetentionPolicy>;

export interface RetentionPolicyWrite {
  version: number;
  callRecordingsDays: number;
  messageTranscriptsDays: number;
  screenRecordingsDays: number;
  qaEvaluationsDays: number;
  onExpiry: RetentionExpiry;
  redactSensitiveNumbersInTranscripts: boolean;
  legalHold: boolean;
}

export function getRetention(programmeId: string, signal?: AbortSignal) {
  return request('GET', `${BASE}/programmes/${id(programmeId)}/retention`, RetentionPolicy, {
    ...(signal ? { signal } : {}),
  });
}

export function saveRetention(
  programmeId: string,
  body: RetentionPolicyWrite,
  signal?: AbortSignal,
) {
  return request('PUT', `${BASE}/programmes/${id(programmeId)}/retention`, RetentionPolicy, {
    body,
    ...(signal ? { signal } : {}),
  });
}

/**
 * The one list in this contract that carries an email address, because the row
 * IS an invitation and the address is the invitation's identity. `emailMasked`
 * is what the row renders; the full address is never in the list.
 */
export const PortalUser = z.object({
  id: z.string(),
  displayName: z.string(),
  emailMasked: z.string(),
  access: z.enum(['viewer', 'reports_only']),
  status: z.enum(['invited', 'active', 'suspended']),
  invitedAt: z.string().optional(),
});
export type PortalUser = z.infer<typeof PortalUser>;

export const PortalUserList = z.object({ items: z.array(PortalUser) });
export type PortalUserList = z.infer<typeof PortalUserList>;

export function listPortalUsers(programmeId: string, signal?: AbortSignal) {
  return request('GET', `${BASE}/programmes/${id(programmeId)}/portal-users`, PortalUserList, {
    ...(signal ? { signal } : {}),
  });
}

/**
 * The counts are computed at the moment the dialog opens, not as of whenever
 * the page loaded — which is why this is a separate `GET` and why the dialog
 * reads it on open rather than on mount.
 *
 * `retentionSummary` is NULLABLE and the dialog omits the line when it is null.
 * See the note on the retention screen: Kasuwa does not necessarily enforce the
 * recording half of that rule (D-T4 is BLOCKED), and a summary invented here
 * would be a promise nobody has checked.
 */
export const ArchivePreview = z.object({
  agentsLosingAccess: z.number(),
  openInteractionsBecomingReadOnly: z.number(),
  retentionSummary: z.string().nullable().optional(),
  portalUsersSignedOut: z.number(),
  restorableUntilDays: z.number(),
});
export type ArchivePreview = z.infer<typeof ArchivePreview>;

export function getArchivePreview(programmeId: string, signal?: AbortSignal) {
  return request(
    'GET',
    `${BASE}/programmes/${id(programmeId)}/archive-preview`,
    ArchivePreview,
    { ...(signal ? { signal } : {}) },
  );
}

/**
 * `confirmation` must equal the programme's NAME. The design asks for the word
 * "archive"; the contract asks for the name, because a constant word is the
 * same keystrokes on every programme and stops being a check after the second
 * time. The screen asks for the name for the same reason.
 */
export function archiveProgramme(programmeId: string, confirmation: string, signal?: AbortSignal) {
  return request('POST', `${BASE}/programmes/${id(programmeId)}/archive`, ProgrammeDetail, {
    body: { confirmation },
    ...(signal ? { signal } : {}),
  });
}

// ---------------------------------------------------------------------------
// Roles — P02/C, C1, C2, C3
// ---------------------------------------------------------------------------

/**
 * Flat, with `parentRoleId`, because the screen re-derives the tree on every
 * drag frame. `descendantUserCount` is SERVER-computed and never recomputed
 * here: record visibility follows the same relation, and a second
 * implementation of "beneath" in the browser is how a visibility rule drifts
 * from what the screen promises.
 */
export const Role = z.object({
  id: z.string(),
  name: z.string(),
  parentRoleId: z.string().nullable(),
  userCount: z.number(),
  descendantUserCount: z.number().optional(),
});
export type Role = z.infer<typeof Role>;

export const RoleList = z.object({ version: z.number(), items: z.array(Role) });
export type RoleList = z.infer<typeof RoleList>;

export const RoleDetail = Role.extend({
  seesRecordsOwnedBy: z
    .object({
      roleCount: z.number(),
      userCount: z.number(),
      sample: z.array(z.object({ id: z.string(), name: z.string() })),
    })
    .optional(),
});
export type RoleDetail = z.infer<typeof RoleDetail>;

export interface RoleMove {
  readonly roleId: string;
  readonly parentRoleId: string | null;
}

export function listRoles(signal?: AbortSignal) {
  return request('GET', `${BASE}/roles`, RoleList, { ...(signal ? { signal } : {}) });
}

export function getRole(roleId: string, signal?: AbortSignal) {
  return request('GET', `${BASE}/roles/${id(roleId)}`, RoleDetail, {
    ...(signal ? { signal } : {}),
  });
}

/**
 * Every pending move in one request, as the contract requires. Applying them
 * one at a time would pass through intermediate shapes that are cycles, and a
 * failure halfway would leave a hierarchy nobody designed.
 */
export function saveRoleHierarchy(
  body: { version: number; moves: readonly RoleMove[] },
  signal?: AbortSignal,
) {
  return request('PUT', `${BASE}/roles/hierarchy`, RoleList, {
    body,
    ...(signal ? { signal } : {}),
  });
}

/**
 * `reassignUsersToRoleId` is REQUIRED even when the role has nobody in it —
 * the contract is explicit. Making it conditional would mean the client had to
 * know the user count before it could form a valid request, and a role that
 * gained a member between page load and click would silently orphan them.
 */
export function deleteRole(roleId: string, reassignUsersToRoleId: string, signal?: AbortSignal) {
  const query = `?reassignUsersToRoleId=${encodeURIComponent(reassignUsersToRoleId)}`;
  return request('DELETE', `${BASE}/roles/${id(roleId)}${query}`, NOTHING, {
    ...(signal ? { signal } : {}),
  });
}

// ---------------------------------------------------------------------------
// Field-level security — P02/D, D1, D2
// ---------------------------------------------------------------------------

export const FieldAccessLevel = z.enum(['none', 'read', 'edit']);
export type FieldAccessLevel = z.infer<typeof FieldAccessLevel>;

export const FieldClassification = z.enum(['none', 'pii', 'sensitive']);
export type FieldClassification = z.infer<typeof FieldClassification>;

export const FieldSecurityObjectList = z.object({
  items: z.array(z.object({ objectApiName: z.string(), label: z.string(), fieldCount: z.number() })),
});
export type FieldSecurityObjectList = z.infer<typeof FieldSecurityObjectList>;

export const PermissionSetList = z.object({
  items: z.array(
    z.object({
      permissionSetId: z.string(),
      label: z.string(),
      /** Null when the count is unavailable. Never rendered as zero. */
      userCount: z.number().nullable().optional(),
      locked: z.boolean(),
    }),
  ),
});
export type PermissionSetList = z.infer<typeof PermissionSetList>;

/**
 * A description of WHO MAY SEE a field. It never carries a field's data — no
 * sample value, no record count, no "example of this field". A helpful preview
 * of the BVN column would be the exact leak this screen exists to prevent.
 */
export const FieldSecurityMatrix = z.object({
  objectApiName: z.string(),
  version: z.number(),
  totalFieldCount: z.number().optional(),
  rows: z.array(
    z.object({
      fieldApiName: z.string(),
      label: z.string(),
      classification: FieldClassification,
      cells: z.array(
        z.object({
          permissionSetId: z.string(),
          level: FieldAccessLevel,
          locked: z.boolean(),
        }),
      ),
    }),
  ),
});
export type FieldSecurityMatrix = z.infer<typeof FieldSecurityMatrix>;

export interface FieldSecurityChange {
  readonly fieldApiName: string;
  readonly permissionSetId: string;
  readonly level: FieldAccessLevel;
}

export function listFieldSecurityObjects(signal?: AbortSignal) {
  return request('GET', `${BASE}/field-security/objects`, FieldSecurityObjectList, {
    ...(signal ? { signal } : {}),
  });
}

export function listPermissionSets(signal?: AbortSignal) {
  return request('GET', `${BASE}/field-security/permission-sets`, PermissionSetList, {
    ...(signal ? { signal } : {}),
  });
}

export function getFieldSecurityMatrix(
  options: { object: string; q?: string; sensitiveOnly?: boolean },
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ object: options.object });
  if (options.q !== undefined && options.q !== '') query.set('q', options.q);
  if (options.sensitiveOnly === true) query.set('sensitiveOnly', 'true');
  return request('GET', `${BASE}/field-security/matrix?${query.toString()}`, FieldSecurityMatrix, {
    ...(signal ? { signal } : {}),
  });
}

/**
 * **Two axes, and there is deliberately no `programmeId`** (D-P9).
 *
 * The matrix is tenant-level on permission sets. Programme scoping comes from
 * ASSIGNMENT: `user_programme` carries the permission set that applies to that
 * person in that programme, so a BPO honours two clients with different rules
 * about the same Contact field by giving their agents different permission
 * sets — not by storing the same field twice at different levels.
 *
 * `changes` is CELL-LEVEL, never "bulk edit", because every changed cell is a
 * separate audit row when this is implemented. A bulk action that touched forty
 * cells and wrote one row saying "bulk edit" is not an audit trail, and the
 * shape of this request is what decides that.
 *
 * `version` comes from the last `GET`; a stale one is `409 stale_write`.
 */
export function saveFieldSecurityMatrix(
  body: {
    objectApiName: string;
    version: number;
    changes: readonly FieldSecurityChange[];
  },
  signal?: AbortSignal,
) {
  return request('PUT', `${BASE}/field-security/matrix`, FieldSecurityMatrix, {
    body,
    ...(signal ? { signal } : {}),
  });
}

// ---------------------------------------------------------------------------
// Audit log — P02/E, E1, E2
// ---------------------------------------------------------------------------

export const AuditAction = z.enum([
  'created',
  'updated',
  'deleted',
  'exported',
  'invited',
  'viewed',
  'failed_sign_in',
  'rejected',
  'rotated',
  'played_recording',
  // A script version published (T-0113, D-L96).
  'published',
]);
export type AuditAction = z.infer<typeof AuditAction>;

export const AuditActor = z.object({
  kind: z.enum(['user', 'system']),
  id: z.string().nullable().optional(),
  displayName: z.string(),
  roleName: z.string().nullable().optional(),
});
export type AuditActor = z.infer<typeof AuditActor>;

/**
 * `before` and `after` are configuration values, never record data. When the
 * changed value is or could contain personal data the server sends
 * `redacted: true` with both null, and the screen renders THAT A SENSITIVE
 * FIELD CHANGED without rendering what it changed to.
 */
export const AuditChange = z.object({
  field: z.string(),
  before: z.string().nullable().optional(),
  after: z.string().nullable().optional(),
  redacted: z.boolean(),
});
export type AuditChange = z.infer<typeof AuditChange>;

export const AuditEntry = z.object({
  id: z.string(),
  occurredAt: z.string(),
  actor: AuditActor,
  action: AuditAction,
  objectType: z.string(),
  objectLabel: z.string(),
  objectId: z.string().nullable().optional(),
  programmeId: z.string().nullable().optional(),
  /**
   * Personal data under the NDPA. Null means "not shown to you" — and the
   * screen must never let that be told apart from "none was recorded", or the
   * field becomes an oracle for what the log holds.
   */
  sourceIp: z.string().nullable().optional(),
  sourceLocation: z.string().nullable().optional(),
  changes: z.array(AuditChange).optional(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

export const AuditEntryList = z.object({ items: z.array(AuditEntry), page: Page });
export type AuditEntryList = z.infer<typeof AuditEntryList>;

export const AuditFilterOptions = z.object({
  actors: z.array(
    z.object({
      id: z.string().nullable().optional(),
      displayName: z.string(),
      kind: z.enum(['user', 'system']),
    }),
  ),
  actions: z.array(AuditAction),
  objectTypes: z.array(z.object({ objectType: z.string(), label: z.string() })),
});
export type AuditFilterOptions = z.infer<typeof AuditFilterOptions>;

export const AuditExport = z.object({
  exportId: z.string(),
  status: z.enum(['queued', 'running', 'ready', 'failed', 'expired']),
  format: z.enum(['csv', 'json']),
  estimatedRowCount: z.number().nullable().optional(),
  /** Masked. Never the full address, and never a URL. */
  deliveryEmailHint: z.string().nullable().optional(),
  linkExpiresAfterHours: z.number().nullable().optional(),
  requestedAt: z.string(),
  completedAt: z.string().nullable().optional(),
});
export type AuditExport = z.infer<typeof AuditExport>;

export interface AuditQuery {
  readonly actorId?: string;
  readonly action?: AuditAction;
  readonly objectType?: string;
  readonly from?: string;
  readonly to?: string;
  readonly sourceIpPrefix?: string;
}

/** The query string for an `AuditQuery`, shared by the list and the export. */
export function auditQueryParams(query: AuditQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.actorId !== undefined && query.actorId !== '') params.set('actorId', query.actorId);
  if (query.action !== undefined) params.set('action', query.action);
  if (query.objectType !== undefined && query.objectType !== '') {
    params.set('objectType', query.objectType);
  }
  if (query.from !== undefined) params.set('from', query.from);
  if (query.to !== undefined) params.set('to', query.to);
  if (query.sourceIpPrefix !== undefined && query.sourceIpPrefix !== '') {
    params.set('sourceIpPrefix', query.sourceIpPrefix);
  }
  return params;
}

export function listAuditEvents(query: AuditQuery, pageSize: number, signal?: AbortSignal) {
  const params = auditQueryParams(query);
  params.set('pageSize', String(pageSize));
  return request('GET', `${BASE}/audit/events?${params.toString()}`, AuditEntryList, {
    ...(signal ? { signal } : {}),
  });
}

export function getAuditFilterOptions(signal?: AbortSignal) {
  return request('GET', `${BASE}/audit/filter-options`, AuditFilterOptions, {
    ...(signal ? { signal } : {}),
  });
}

/**
 * `includeIpAddresses` has no default here on purpose: the caller states it.
 * The contract defaults it to false because an export that carries personal
 * data by default is one an admin produces without deciding to, and the screen
 * makes that decision visible rather than inheriting it.
 */
export function createAuditExport(
  body: {
    format: 'csv' | 'json';
    scope: 'filtered' | 'last_90_days';
    includeIpAddresses: boolean;
    filters?: AuditQuery;
  },
  signal?: AbortSignal,
) {
  return request('POST', `${BASE}/audit/exports`, AuditExport, {
    body,
    ...(signal ? { signal } : {}),
  });
}
