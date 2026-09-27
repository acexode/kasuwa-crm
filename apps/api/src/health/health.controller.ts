import { Controller, Get } from '@nestjs/common';

/**
 * Liveness only. Deliberately outside the tenant guard and interceptor: a
 * health check that needs a tenant context is a health check that fails during
 * exactly the incidents it exists to report on.
 *
 * It does NOT touch the database. Readiness probes that query Postgres are
 * Agent 13's to design alongside the deployment topology.
 */
@Controller()
export class HealthController {
  @Get('health')
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
