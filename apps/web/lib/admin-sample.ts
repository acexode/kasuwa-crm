import type { MessageId } from '@kasuwa/i18n/bundle';
import type { ProgrammeKpis, Result, SkillCover } from './admin-api';

/**
 * SAMPLE DATA for the two P02 panels the admin API cannot answer yet (T-0035).
 *
 * `getProgrammeKpis` and `getProgrammeSkillCover` are the only operations in
 * `docs/api/admin.openapi.yaml` still marked `x-kasuwa-implemented: false`:
 * KPIs need an interaction aggregate and skill cover needs the WFM forecast
 * (ADR-0003), and neither exists. With `admin_live_api` ON, every other read
 * on the console comes from the real API, and these two come from HERE.
 *
 * Three rules, and the screen is wrong if any of them breaks:
 *
 *   1. It lives in apps/web, never in a test mock. A browser in production
 *      has no Playwright to fulfil a route, so a panel that only works when a
 *      test intercepts the request is a panel that is blank in front of a
 *      customer.
 *   2. It is LABELLED where it renders: an element with `data-source="mock"`
 *      and a visible, translated "Sample data" note (`components/admin/
 *      sample-data.tsx`). A supervisor who reads a sample SLA figure as their
 *      own programme's will act on it; the label is what stops that.
 *   3. Labels are message ids, not English. The panel is read in Hausa and
 *      Yorùbá too, and sample data is no excuse for an English island.
 *
 * The numbers are illustrative and the same for every programme on purpose —
 * a figure that varied by programme would look like it had been measured.
 * Delete this module when the two endpoints exist.
 */

interface SampleKpi {
  readonly kpiId: string;
  readonly label: MessageId;
  readonly format: 'percent' | 'count' | 'duration_seconds';
  readonly value: number;
  readonly targetValue: number | null;
  readonly status: 'good' | 'warn' | 'bad' | null;
}

const SAMPLE_KPIS: readonly SampleKpi[] = [
  {
    kpiId: 'sla_met',
    label: 'admin.sample.kpi.sla_met',
    format: 'percent',
    value: 93.4,
    targetValue: 95,
    status: 'warn',
  },
  {
    kpiId: 'contacts_handled',
    label: 'admin.sample.kpi.contacts_handled',
    format: 'count',
    value: 4820,
    targetValue: null,
    status: null,
  },
  {
    kpiId: 'average_handle_time',
    label: 'admin.sample.kpi.average_handle_time',
    format: 'duration_seconds',
    value: 360,
    targetValue: 420,
    status: 'good',
  },
  {
    kpiId: 'qa_score',
    label: 'admin.sample.kpi.qa_score',
    format: 'percent',
    value: 88,
    targetValue: 85,
    status: 'good',
  },
];

interface SampleSkill {
  readonly skillId: string;
  readonly label: MessageId;
  readonly rostered: number;
  /** One row with no forecast, so the "not known" rendering stays exercised. */
  readonly needed: number | null;
}

const SAMPLE_SKILLS: readonly SampleSkill[] = [
  { skillId: 'collections', label: 'admin.sample.skill.collections', rostered: 12, needed: 14 },
  { skillId: 'care', label: 'admin.sample.skill.care', rostered: 9, needed: 8 },
  { skillId: 'escalations', label: 'admin.sample.skill.escalations', rostered: 3, needed: null },
];

/** Every message id this module renders, for the screen's bundle. */
export const SAMPLE_MESSAGE_IDS: readonly MessageId[] = [
  'admin.sample.label',
  'admin.sample.note',
  ...SAMPLE_KPIS.map((kpi) => kpi.label),
  ...SAMPLE_SKILLS.map((skill) => skill.label),
];

type Label = (id: MessageId) => string;

export function sampleProgrammeKpis(label: Label): ProgrammeKpis {
  return {
    window: 'last_7_days',
    kpis: SAMPLE_KPIS.map((kpi) => ({ ...kpi, label: label(kpi.label) })),
  };
}

/**
 * `now` is a parameter so a test asserts a value. The shift date is today in
 * the sample's own zone, stated explicitly like the contract does — "today"
 * is not one date across WAT, EAT and SAST.
 */
export function sampleSkillCover(label: Label, now: Date): SkillCover {
  const timeZone = 'Africa/Lagos';
  const shiftDate = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return {
    shiftDate,
    shift: 'day',
    timeZone,
    items: SAMPLE_SKILLS.map((skill) => ({ ...skill, label: label(skill.label) })),
  };
}

/** The same `Result` shape a real read returns, so `Panel` renders it unchanged. */
export function sampleResult<T>(value: T): Promise<Result<T>> {
  return Promise.resolve({ ok: true, value });
}
