import {
  Module,
  type DynamicModule,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { createDevelopmentKeyProvider, type KeyProvider } from '@kasuwa/auth-crypto';
import { AdminProgrammesController } from './admin/programmes/programmes.controller';
import { FieldSecurityAdminModule } from './admin/field-security/field-security.module';
import { AdminRolesModule } from './admin/roles/admin-roles.module';
import { PermissionSetsController, RolesController } from './admin/roles/roles.controller';
import { FieldSecurityController } from './admin/field-security/field-security.controller';
import { FieldSecurityMatrixController } from './admin/field-security/field-security-matrix.controller';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { SignInThrottleGuard } from './auth/sign-in-throttle.guard';
import { AUTH_POLICY, DEFAULT_AUTH_POLICY, type AuthPolicy } from './auth/auth.policy';
import { KEY_PROVIDER } from './auth/key-provider.token';
import { ContactsController } from './contacts/contacts.controller';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { AUTH_MODE, KasuwaAuthGuard, type ResolvedAuthMode } from './tenancy/kasuwa-auth.guard';
import { StubAuthGuard } from './tenancy/stub-auth.guard';
import { TenantTransactionInterceptor } from './tenancy/tenant-transaction.interceptor';
import { ValidationExceptionFilter } from './common/zod-exception.filter';
import {
  RequestTelemetryMiddleware,
  TELEMETRY_OPTIONS,
  telemetryOptions,
} from './telemetry/request-telemetry';

/** Controllers hosted by this module. */
const CONTROLLERS = [
  HealthController,
  AuthController,
  ContactsController,
  AdminProgrammesController,
];

/**
 * Every controller in the app, including those hosted by feature modules. Used
 * only for the telemetry vocabulary: a segment missing here becomes `:param` in
 * an unmatched path's `url.template`, which is safe but less useful.
 */
const TELEMETRY_CONTROLLERS = [
  ...CONTROLLERS,
  RolesController,
  PermissionSetsController,
  FieldSecurityController,
  FieldSecurityMatrixController,
];

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
      global: true,
      exports: [AUTH_MODE],
      imports: [
        DatabaseModule.forRoot(
          options.poolMax === undefined
            ? { databaseUrl: options.databaseUrl }
            : { databaseUrl: options.databaseUrl, poolMax: options.poolMax },
        ),
        FieldSecurityAdminModule.register({ authMode: options.authMode ?? 'stub' }),
        AdminRolesModule,
      ],
      controllers: CONTROLLERS,
      providers: [
        AuthService,
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
        { provide: APP_FILTER, useClass: ValidationExceptionFilter },
        {
          provide: TELEMETRY_OPTIONS,
          useValue: telemetryOptions(options.cell ?? 'local', TELEMETRY_CONTROLLERS),
        },
      ],
    };
  }
}
