import {
  Body,
  Controller,
  Get,
  Header,
  Put,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { getOwnOnboardingState, putOwnOnboardingStep } from '@kasuwa/domain-core';
import { AdminErrorFilter, notFound } from '../admin/common/admin-errors';
import { KasuwaAuthGuard } from '../tenancy/kasuwa-auth.guard';
import { TenantTransactionInterceptor } from '../tenancy/tenant-transaction.interceptor';
import { currentTx } from '../tenancy/tenant-context';
import { OnboardingPersistenceGuard } from '../auth/onboarding-persistence.guard';
import { OnboardingStepBody } from './onboarding.schemas';

export interface OnboardingResponse {
  step: string;
  payload: Record<string, unknown>;
  completedAt: string | null;
}

@Controller('api/v1/me/onboarding')
@UseGuards(KasuwaAuthGuard, OnboardingPersistenceGuard)
@UseInterceptors(TenantTransactionInterceptor)
@UseFilters(AdminErrorFilter)
export class OnboardingController {
  @Get()
  @Header('Cache-Control', 'no-store')
  async getOnboarding(): Promise<OnboardingResponse> {
    const state = await getOwnOnboardingState(currentTx());
    if (state === null) {
      throw notFound();
    }
    return rebuild(state);
  }

  @Put('step')
  @Header('Cache-Control', 'no-store')
  async putOnboardingStep(@Body() body: unknown): Promise<OnboardingResponse> {
    const parsed = OnboardingStepBody.parse(body);
    const stored = await putOwnOnboardingStep(currentTx(), parsed.step, parsed.payload);
    return rebuild(stored);
  }
}

function rebuild(state: {
  step: string;
  payload: Readonly<Record<string, unknown>>;
  completedAt: Date | null;
}): OnboardingResponse {
  return {
    step: state.step,
    payload: { ...state.payload },
    completedAt: state.completedAt?.toISOString() ?? null,
  };
}
