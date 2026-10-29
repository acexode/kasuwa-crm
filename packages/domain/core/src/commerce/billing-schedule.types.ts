export const BILLING_CADENCES = ['monthly', 'quarterly', 'yearly'] as const;
export type BillingCadence = (typeof BILLING_CADENCES)[number];

export const BILLING_SCHEDULE_STATUSES = ['active', 'paused', 'ended'] as const;
export type BillingScheduleStatus = (typeof BILLING_SCHEDULE_STATUSES)[number];

export const BILLING_SCHEDULE_TRANSITIONS: Readonly<
  Record<BillingScheduleStatus, readonly BillingScheduleStatus[]>
> = {
  active: ['paused', 'ended'],
  paused: ['active', 'ended'],
  ended: [],
};

export interface BillingSchedule {
  id: string;
  programmeId: string;
  invoiceId: string | null;
  cadence: BillingCadence;
  nextRunAt: Date;
  status: BillingScheduleStatus;
  createdAt: Date;
  updatedAt: Date;
}
