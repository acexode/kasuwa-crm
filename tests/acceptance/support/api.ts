import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule, STUB_TENANT_HEADER, STUB_USER_HEADER } from '@kasuwa/api';

/**
 * Boots the real API against the Testcontainers database.
 *
 * The API under test is the real one: real guard, real interceptor, real
 * Postgres, real RLS policies. Nothing is stubbed. An isolation suite that
 * mocks the database proves only that the mock agrees with itself.
 */
export async function createApi(databaseUrl: string): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot({ databaseUrl, poolMax: 5 })],
  }).compile();

  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
}

/** Headers that authenticate a request as a specific seeded user. */
export function asUser(tenantId: string, userId: string): Record<string, string> {
  return { [STUB_TENANT_HEADER]: tenantId, [STUB_USER_HEADER]: userId };
}
