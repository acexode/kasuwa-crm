import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { UsableTestAdminError } from '@kasuwa/db';
import { afterEach, describe, expect, inject, it } from 'vitest';
import { AppModule } from '../app.module';

/**
 * T-0117 (D-L94 addendum): the API refuses to start, in production, when
 * kasuwa_test_admin is usable. The check runs at application bootstrap on the
 * app pool, so `init()` (which `listen()` calls first) rejects and no port is
 * ever bound.
 *
 * The shared harness has the live test login by design, so production here is
 * the refusal and test is the control. The inert case is the acceptance
 * suite's, on its own cluster.
 */
describe('API boot refuses a usable kasuwa_test_admin outside development and test', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function build(nodeEnv: 'production' | 'test'): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.forRoot({
          databaseUrl: inject('databaseUrl'),
          authDatabaseUrl: inject('authDatabaseUrl'),
          poolMax: 2,
          nodeEnv,
        }),
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    return app;
  }

  it('init() rejects in production, naming the role', async () => {
    const built = await build('production');
    const attempt = built.init();
    await expect(attempt).rejects.toBeInstanceOf(UsableTestAdminError);
    await expect(attempt).rejects.toThrow(/kasuwa_test_admin/u);
  });

  it('init() succeeds in test against the same database (control)', async () => {
    const built = await build('test');
    await expect(built.init()).resolves.toBeDefined();
  });
});
