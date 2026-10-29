import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { ChannelProvider, DndRegister } from '@kasuwa/channel-adapter';
import { AppModule, STUB_TENANT_HEADER, STUB_USER_HEADER } from '@kasuwa/api';
import { inject } from 'vitest';

/**
 * The `kasuwa_auth` connection the harness provides (T-0049 I7).
 *
 * Read through a cast so this file typechecks before the harness declares the
 * key. A harness that provides none fails here, by name, rather than as a
 * sign-in that 42501s three layers down.
 */
export function authDatabaseUrl(): string {
  const value: unknown = (inject as unknown as (key: string) => unknown)('authDatabaseUrl');
  if (typeof value !== 'string' || value === '') {
    throw new Error(
      "The harness provides no inject('authDatabaseUrl'). T-0049 I7: startTestStack returns the " +
        'kasuwa_auth URL as authDatabaseUrl and global-setup provides it.',
    );
  }
  return value;
}

/**
 * Adds the auth pool's URL to `AppModule.forRoot` options (T-0049 I5). Every
 * suite that boots the API goes through this, so the second pool is never
 * forgotten and the call sites keep their own options.
 */
export function withAuthDatabase<T extends object>(options: T): T & { authDatabaseUrl: string } {
  return { ...options, authDatabaseUrl: authDatabaseUrl() };
}

export interface CreateApiOptions {
  portalEnabled?: boolean;
  selfServeSignup?: boolean;
  onboardingPersistence?: boolean;
  selfServeProvisioningConnection?: string;
  channelProvider?: ChannelProvider;
  dndRegister?: DndRegister;
  inboxTemplatesEnabled?: boolean;
  inboxRoutingEnabled?: boolean;
}

/**
 * Boots the real API against the Testcontainers database.
 *
 * The API under test is the real one: real guard, real interceptor, real
 * Postgres, real RLS policies. Nothing is stubbed. An isolation suite that
 * mocks the database proves only that the mock agrees with itself.
 */
export async function createApi(
  databaseUrl: string,
  options: CreateApiOptions = {},
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.forRoot(
        withAuthDatabase({
          databaseUrl,
          poolMax: 5,
          ...(options.portalEnabled === undefined
            ? {}
            : { portalEnabled: options.portalEnabled }),
          ...(options.selfServeSignup === undefined
            ? {}
            : { selfServeSignup: options.selfServeSignup }),
          ...(options.onboardingPersistence === undefined
            ? {}
            : { onboardingPersistence: options.onboardingPersistence }),
          ...(options.selfServeProvisioningConnection === undefined
            ? {}
            : { selfServeProvisioningConnection: options.selfServeProvisioningConnection }),
          ...(options.channelProvider === undefined
            ? {}
            : { channelProvider: options.channelProvider }),
          ...(options.dndRegister === undefined ? {} : { dndRegister: options.dndRegister }),
          ...(options.inboxTemplatesEnabled === undefined
            ? {}
            : { inboxTemplatesEnabled: options.inboxTemplatesEnabled }),
          ...(options.inboxRoutingEnabled === undefined
            ? {}
            : { inboxRoutingEnabled: options.inboxRoutingEnabled }),
        }),
      ),
    ],
  }).compile();

  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
}

/** Headers that authenticate a request as a specific seeded user. */
export function asUser(tenantId: string, userId: string): Record<string, string> {
  return { [STUB_TENANT_HEADER]: tenantId, [STUB_USER_HEADER]: userId };
}
