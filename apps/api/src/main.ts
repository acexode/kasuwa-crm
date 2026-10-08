import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { createKeyProvider } from '@kasuwa/auth-crypto';
import { apiEnv, loadWorkspaceEnv } from '@kasuwa/config';
import { initialiseFeatureFlags } from '@kasuwa/feature-flags';
import { AppModule } from './app.module';
import { installProcessErrorHandlers } from './common/process-errors';
import { startTelemetry } from './telemetry/sdk';

// First, before anything can throw: an uncaught error or unhandled rejection
// logs only its scrubbed class and code (T-0036), then exits 1 as Node would.
installProcessErrorHandlers(process, (line) => {
  process.stderr.write(`${line}\n`);
});

/**
 * API entrypoint.
 *
 * `apiEnv()` validates the environment and, critically, refuses to return at
 * all if KASUWA_AUTH_MODE=stub with NODE_ENV=production, or if the local key
 * provider is configured there (D-L13), or, outside development and test, if
 * a database URL carries a repository dev password or a PG* fallback is set
 * (T-0117). These run before anything binds a port, and so does the check,
 * at application bootstrap, that kasuwa_test_admin is not usable.
 *
 * `loadWorkspaceEnv()` first: importing `@kasuwa/config` no longer loads the
 * workspace `.env` as a side effect (T-0014), so each server process asks for
 * it. A real environment variable still wins over the file.
 */
async function bootstrap(): Promise<void> {
  loadWorkspaceEnv();
  const configuration = apiEnv();

  await initialiseFeatureFlags();

  // Before the app is built, so the first request is already traced.
  startTelemetry(configuration.KASUWA_OTEL_EXPORTER);

  const app = await NestFactory.create(
    AppModule.forRoot({
      databaseUrl: configuration.DATABASE_URL,
      // kasuwa_auth: the only writer of the auth tables (T-0049, D-P16).
      authDatabaseUrl: configuration.DATABASE_AUTH_URL,
      poolMax: configuration.DATABASE_POOL_MAX,
      cell: configuration.KASUWA_CELL,
      // Outside development and test, refuse to start when kasuwa_test_admin
      // is usable (T-0117, D-L94); checked on the app pool before listen.
      nodeEnv: configuration.NODE_ENV,
      authMode: configuration.KASUWA_AUTH_MODE,
      // No KMS client is passed: nothing is provisioned (D-A4), so asking for
      // aws-kms here fails at boot with a configuration error rather than at
      // the first sign-in. That is the right time to find out.
      keyProvider: createKeyProvider({
        provider: configuration.KASUWA_KMS_PROVIDER,
        keyId: configuration.KASUWA_KMS_KEY_ID,
        localMasterKeyBase64: configuration.KASUWA_KMS_LOCAL_MASTER_KEY,
      }),
      authPolicy: {
        lockoutMaxAttempts: configuration.KASUWA_AUTH_LOCKOUT_MAX_ATTEMPTS,
        lockoutWindowMinutes: configuration.KASUWA_AUTH_LOCKOUT_WINDOW_MINUTES,
        lockoutMinutes: configuration.KASUWA_AUTH_LOCKOUT_MINUTES,
        challengeMinutes: configuration.KASUWA_AUTH_CHALLENGE_MINUTES,
        challengeMaxAttempts: configuration.KASUWA_AUTH_CHALLENGE_MAX_ATTEMPTS,
        mfaMaxAttempts: configuration.KASUWA_AUTH_MFA_MAX_ATTEMPTS,
        maxOpenChallenges: configuration.KASUWA_AUTH_MAX_OPEN_CHALLENGES,
        signInPerMinutePerClient: configuration.KASUWA_AUTH_SIGN_IN_PER_MINUTE,
        signInInFlightPerClient: configuration.KASUWA_AUTH_SIGN_IN_IN_FLIGHT,
        cellTimeZone: configuration.KASUWA_CELL_TIME_ZONE,
        trustProxyHops: configuration.KASUWA_TRUST_PROXY_HOPS,
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
