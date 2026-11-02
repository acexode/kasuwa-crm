import { newId, type TenantTx } from '@kasuwa/db';

export const ONBOARDING_STEPS = [
  'currency_language',
  'whatsapp',
  'import',
  'invite',
  'checklist',
  'done',
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export interface OnboardingStateRecord {
  readonly step: OnboardingStep;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly completedAt: Date | null;
}

interface Row {
  step: OnboardingStep;
  payload: Record<string, unknown>;
  completed_at: Date | null;
}

export async function getOwnOnboardingState(tx: TenantTx): Promise<OnboardingStateRecord | null> {
  const rows = await tx.query<Row>(
    `SELECT step, payload, completed_at
       FROM onboarding_state
      WHERE tenant_id = $1 AND user_id = $2`,
    [tx.session.tenantId, tx.session.userId],
  );
  const row = rows[0];
  return row === undefined
    ? null
    : { step: row.step, payload: row.payload, completedAt: row.completed_at };
}

export async function putOwnOnboardingStep(
  tx: TenantTx,
  step: OnboardingStep,
  payload: Readonly<Record<string, unknown>>,
): Promise<OnboardingStateRecord> {
  const completedAt = step === 'done' ? new Date() : null;
  const rows = await tx.query<Row>(
    `INSERT INTO onboarding_state (id, tenant_id, user_id, step, payload, completed_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     ON CONFLICT (tenant_id, user_id)
     DO UPDATE SET step = EXCLUDED.step, payload = EXCLUDED.payload,
                   completed_at = EXCLUDED.completed_at
     RETURNING step, payload, completed_at`,
    [newId(), tx.session.tenantId, tx.session.userId, step, JSON.stringify(payload), completedAt],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error('onboarding_state upsert returned no row');
  }
  return { step: row.step, payload: row.payload, completedAt: row.completed_at };
}
