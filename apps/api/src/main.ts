import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { env } from '@kasuwa/config';
import { initialiseFeatureFlags } from '@kasuwa/feature-flags';
import { AppModule } from './app.module';

/**
 * API entrypoint.
 *
 * `env()` validates the environment and, critically, refuses to return at all
 * if KASUWA_AUTH_MODE=stub with NODE_ENV=production. That check runs before
 * anything binds a port.
 */
async function bootstrap(): Promise<void> {
  const configuration = env();

  await initialiseFeatureFlags();

  const app = await NestFactory.create(
    AppModule.forRoot({
      databaseUrl: configuration.DATABASE_URL,
      poolMax: configuration.DATABASE_POOL_MAX,
      authMode: configuration.KASUWA_AUTH_MODE,
      authPolicy: {
        lockoutMaxAttempts: configuration.KASUWA_AUTH_LOCKOUT_MAX_ATTEMPTS,
        lockoutWindowMinutes: configuration.KASUWA_AUTH_LOCKOUT_WINDOW_MINUTES,
        lockoutMinutes: configuration.KASUWA_AUTH_LOCKOUT_MINUTES,
        challengeMinutes: configuration.KASUWA_AUTH_CHALLENGE_MINUTES,
        challengeMaxAttempts: configuration.KASUWA_AUTH_CHALLENGE_MAX_ATTEMPTS,
        sessionHours: configuration.KASUWA_AUTH_SESSION_HOURS,
      },
    }),
    configuration.NODE_ENV === 'production' ? { logger: ['error', 'warn'] } : {},
  );

  app.enableShutdownHooks();
  await app.listen(configuration.API_PORT);
  process.stdout.write(`kasuwa api listening on ${configuration.API_PORT}\n`);
}

bootstrap().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
});
