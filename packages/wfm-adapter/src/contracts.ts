import { z } from 'zod';

/**
 * WFM integration contract — v0, PROVISIONAL and largely speculative.
 *
 * Addendum A1 section 2.1 replaces "build WFM-lite" (PRD M11) with "integrate
 * the existing WFM". It names four things Kasuwa needs:
 *
 *   1. published schedules per agent      -> SchedulePort
 *   2. scheduled-vs-actual adherence      -> AdherencePort
 *   3. staffing requirement vs scheduled  -> StaffingPort
 *   4. shift-swap / leave requests        -> RequestLinkPort (link-out only)
 *
 * READ THIS BEFORE BUILDING AGAINST IT: nothing about the existing WFM system
 * has been shared yet — no repo, README, data model, API spec, tests or
 * screenshots (team/DECISIONS.md D-W1). These types are derived from the
 * addendum's prose and general WFM practice, not from the real system. They
 * WILL change. The only safe use today is as a target for the in-memory fake
 * and for shaping Kasuwa-side UI work behind a feature flag.
 *
 * D-W2 (does WFM consume the telephony agent-state stream directly, or through
 * Kasuwa?) is unanswered and decides whether AdherencePort is read-only for
 * Kasuwa or whether Kasuwa must also publish states into WFM. The interface
 * below assumes read-only, which is the smaller commitment.
 */

export const WfmScope = z.object({
  tenantId: z.string().uuid(),
  programmeId: z.string().uuid(),
});
export type WfmScope = z.infer<typeof WfmScope>;

// --- 1. Published schedules ------------------------------------------------

export const ShiftSegmentKind = z.enum([
  'work',
  'break',
  'lunch',
  'meeting',
  'training',
  'offline',
]);
export type ShiftSegmentKind = z.infer<typeof ShiftSegmentKind>;

export const ShiftSegment = z.object({
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  kind: ShiftSegmentKind,
  /** WFM-defined activity or aux code, surfaced to the agent verbatim. */
  activityCode: z.string().optional(),
});
export type ShiftSegment = z.infer<typeof ShiftSegment>;

export const PublishedShift = z.object({
  scope: WfmScope,
  kasuwaUserId: z.string().uuid(),
  shiftId: z.string().min(1),
  /** IANA zone, e.g. "Africa/Lagos". BPO rosters span WAT/EAT/SAST. */
  timezone: z.string().min(1),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  segments: z.array(ShiftSegment),
  /** Bumped by WFM when a published schedule is republished. */
  version: z.number().int().nonnegative(),
});
export type PublishedShift = z.infer<typeof PublishedShift>;

export interface SchedulePort {
  /** Agent Home and the mobile view. Read-only. */
  getPublishedShifts(
    scope: WfmScope,
    kasuwaUserId: string,
    range: { from: Date; to: Date },
  ): Promise<PublishedShift[]>;
}

// --- 2. Adherence ----------------------------------------------------------

export const AdherenceSummary = z.object({
  scope: WfmScope,
  kasuwaUserId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Fraction in [0,1]; WFM owns the tolerance window that produced it. */
  adherence: z.number().min(0).max(1),
  conformance: z.number().min(0).max(1).optional(),
  scheduledSeconds: z.number().int().nonnegative(),
  actualSeconds: z.number().int().nonnegative(),
});
export type AdherenceSummary = z.infer<typeof AdherenceSummary>;

export interface AdherencePort {
  getAdherence(
    scope: WfmScope,
    range: { from: Date; to: Date },
    kasuwaUserIds?: readonly string[],
  ): Promise<AdherenceSummary[]>;
}

// --- 3. Staffing requirement vs scheduled (wallboard) ----------------------

export const StaffingInterval = z.object({
  scope: WfmScope,
  intervalStart: z.coerce.date(),
  intervalMinutes: z.number().int().positive(),
  required: z.number().nonnegative(),
  scheduled: z.number().nonnegative(),
  /** Present only if WFM tracks live presence; the wallboard degrades without it. */
  actual: z.number().nonnegative().optional(),
});
export type StaffingInterval = z.infer<typeof StaffingInterval>;

export interface StaffingPort {
  getStaffing(scope: WfmScope, range: { from: Date; to: Date }): Promise<StaffingInterval[]>;
}

// --- 4. Shift swap / leave -------------------------------------------------

/**
 * Deliberately a LINK, not a workflow. Addendum 2.1 says swap/leave "can stay
 * in WFM's own UI, linked from Kasuwa". Reimplementing an approval workflow on
 * this side would duplicate state and create two sources of truth for who is
 * working tomorrow.
 */
export interface RequestLinkPort {
  getSwapAndLeaveUrl(scope: WfmScope, kasuwaUserId: string): Promise<{ url: string }>;
}

export interface WfmAdapter {
  readonly schedules: SchedulePort;
  readonly adherence: AdherencePort;
  readonly staffing: StaffingPort;
  readonly requests: RequestLinkPort;
}
