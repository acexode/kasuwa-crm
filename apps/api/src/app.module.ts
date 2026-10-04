import {
  Module,
  type DynamicModule,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { createDevelopmentKeyProvider, type KeyProvider } from '@kasuwa/auth-crypto';
import { defaultChannelProvider, type ChannelProvider } from '@kasuwa/channel-adapter';
import { nodeEnv } from '@kasuwa/config';
import { ADMIN_CONTROLLERS, AdminModule } from './admin/admin.module';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { CommitThenFailInterceptor } from './auth/commit-then-fail.interceptor';
import { MfaService } from './auth/mfa.service';
import { SignInThrottleGuard } from './auth/sign-in-throttle.guard';
import { AUTH_POLICY, DEFAULT_AUTH_POLICY, type AuthPolicy } from './auth/auth.policy';
import { KEY_PROVIDER } from './auth/key-provider.token';
import { ContactsController } from './contacts/contacts.controller';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { CHANNEL, createApiChannel } from './messaging/channel';
import { AUTH_MODE, KasuwaAuthGuard, type ResolvedAuthMode } from './tenancy/kasuwa-auth.guard';
import { StubAuthGuard } from './tenancy/stub-auth.guard';
import { TenantTransactionInterceptor } from './tenancy/tenant-transaction.interceptor';
import { UnexpectedErrorFilter } from './common/unexpected-error.filter';
import { ValidationExceptionFilter } from './common/zod-exception.filter';
import {
  RequestTelemetryMiddleware,
  TELEMETRY_OPTIONS,
  telemetryOptions,
} from './telemetry/request-telemetry';

/** Controllers hosted by this module. */
const CONTROLLERS = [HealthController, AuthController, ContactsController];

/**
 * Every controller in the app, including those hosted by feature modules. Used
 * only for the telemetry vocabulary: a segment missing here becomes `:param` in
 * an unmatched path's `url.template`, which is safe but less useful. The admin
 * areas' controllers are derived from AdminModule, so a new area is covered
 * without an edit here.
 */
const TELEMETRY_CONTROLLERS = [...CONTROLLERS, ...ADMIN_CONTROLLERS];

export interface AppModuleOptions {
  databaseUrl: string;
  poolMax?: number;
  /**
   * Which identity transports are accepted.
   *
   * `stub` additionally accepts the `x-kasuwa-*` headers (ADR-0007); `jwt`
   * accepts only a real session. Bearer sessions work in both — the mode
   * widens what is accepted, it never narrows it.
   *
   * Defaults to `stub` so that the isolation suite, which impersonates seeded
   * users deliberately, keeps working without configuration. The guard that
   * makes this safe is in @kasuwa/config: the process refuses to boot with
   * `stub` under NODE_ENV=production, and that check runs before anything
   * binds a port.
   */
  authMode?: ResolvedAuthMode;
  /** Lockout, challenge and session numbers. Defaults to the P01 design's. */
  authPolicy?: Partial<AuthPolicy>;
  /**
   * How TOTP secrets are sealed and opened (D-L13, envelope encryption).
   *
   * Defaults to the development provider, which mirrors `authMode` defaulting
   * to `stub`: convenient locally, and impossible to leave switched on by
   * accident, because the provider refuses to be constructed under
   * NODE_ENV=production and @kasuwa/config refuses to boot on it there.
   * `main.ts` passes the configured one.
   */
  keyProvider?: KeyProvider;
  /**
   * The messaging provider behind `@kasuwa/channel-adapter` (D-L49, T-0030).
   *
   * The API never calls it directly: it is wrapped in `createChannelAdapter`,
   * which validates, applies DND and sanitises errors. When omitted it is
   * `defaultChannelProvider(nodeEnv())` (D-L52): the in-memory fake in
   * development and test, and a null provider in production that refuses
   * every send - so an invitation is a `503`, never a `202` for an email that
   * went nowhere - until D-P10 chooses a real provider. Tests pass their own
   * fake to read what was sent.
   */
  channelProvider?: ChannelProvider;
  /**
   * The `cell` attribute on every API span (T-0005). Defaults to `local`;
   * `main.ts` passes KASUWA_CELL.
   */
  cell?: string;
}

/**
 * The modular monolith's composition root (ADR-0001).
 *
 * The guard and interceptor are applied per-controller rather than globally, so
 * that HealthController can exist without a tenant, and so that the sign-in
 * routes — which by definition have no caller yet — can exist without one
 * either. That is a deliberate, narrow exception: any controller that touches
 * tenant data must carry both decorators, and the acceptance suite fails if a
 * route serves data without them.
 *
 * `forRoot` takes its configuration as arguments rather than reading the
 * environment, so tests can point an app at a Testcontainers instance, or at a
 * different lockout threshold, without mutating process.env.
 */
@Module({})
export class AppModule implements NestModule {
  /**
   * One inbound span per request, for every path — including the ones that
   * match no route, which are the ones an incident is most often about.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestTelemetryMiddleware).forRoutes('{*splat}');
  }

  static forRoot(options: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      // Global, exporting AUTH_MODE, so a feature module's controllers can use
      // KasuwaAuthGuard: Nest resolves a guard's dependencies in the module
      // that hosts the controller, and AUTH_MODE is configured only here.
      // Every admin area relies on this (D-L39); do not remove it while
      // AdminModule exists.
      global: true,
      exports: [AUTH_MODE, CHANNEL],
      imports: [
        DatabaseModule.forRoot(
          options.poolMax === undefined
            ? { databaseUrl: options.databaseUrl }
            : { databaseUrl: options.databaseUrl, poolMax: options.poolMax },
        ),
        // Every admin area. A new area is added inside AdminModule, not here.
        AdminModule,
      ],
      controllers: CONTROLLERS,
      providers: [
        AuthService,
        MfaService,
        CommitThenFailInterceptor,
        SignInThrottleGuard,
        KasuwaAuthGuard,
        StubAuthGuard,
        TenantTransactionInterceptor,
        { provide: AUTH_MODE, useValue: options.authMode ?? 'stub' },
        {
          provide: AUTH_POLICY,
          useValue: { ...DEFAULT_AUTH_POLICY, ...options.authPolicy },
        },
        {
          provide: KEY_PROVIDER,
          useValue: options.keyProvider ?? createDevelopmentKeyProvider(),
        },
        {
          provide: CHANNEL,
          useValue: createApiChannel(options.channelProvider ?? defaultChannelProvider(nodeEnv())),
        },
        { provide: APP_FILTER, useClass: ValidationExceptionFilter },
        // The catch-all (T-0036, D-L42): replaces Nest's default handler, which
        // logs an unexpected error's message and stack. It delegates Zod and
        // cursor errors to the filter above, so their order does not matter.
        { provide: APP_FILTER, useClass: UnexpectedErrorFilter },
        {
          provide: TELEMETRY_OPTIONS,
          useValue: telemetryOptions(options.cell ?? 'local', TELEMETRY_CONTROLLERS),
        },
      ],
    };
  }
}
