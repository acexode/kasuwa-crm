import { Module, type DynamicModule } from '@nestjs/common';
import { createDevelopmentKeyProvider, type KeyProvider } from '@kasuwa/auth-crypto';
import { AuthDatabaseModule, type AuthDatabaseOptions } from './auth-database.module';
import { AuthTenantTransactionInterceptor } from './auth-tenant-transaction.interceptor';
import { AuthController } from './auth.controller';
import { PortalController } from './portal/portal.controller';
import { PortalReadsController } from './portal/portal-reads.controller';
import { PortalReadsService } from './portal/portal-reads.service';
import { PortalService } from './portal/portal.service';
import { PortalAuthGuard } from './portal/portal-auth.guard';
import { PortalEnabledGuard, PORTAL_ENABLED_TOKEN } from './portal/portal-enabled.guard';
import { PortalTransactionInterceptor } from './portal/portal-transaction.interceptor';
import { AUTH_POLICY, DEFAULT_AUTH_POLICY, type AuthPolicy } from './auth.policy';
import { AuthService } from './auth.service';
import { CommitThenFailInterceptor } from './commit-then-fail.interceptor';
import { KEY_PROVIDER } from './key-provider.token';
import { MfaService } from './mfa.service';
import { PoolIdentityCheck } from './pool-identity';
import { OnboardingPersistenceGuard } from './onboarding-persistence.guard';
import { SelfServeSignupService } from './self-serve-signup.service';
import { SignInThrottleGuard } from './sign-in-throttle.guard';
import {
  ONBOARDING_PERSISTENCE_ENABLED,
  SELF_SERVE_PROVISIONING_CONNECTION,
  SELF_SERVE_SIGNUP_ENABLED,
} from './self-serve.tokens';

export interface AuthModuleOptions extends AuthDatabaseOptions {
  /** Lockout, challenge and session numbers; see `AppModuleOptions.authPolicy`. */
  authPolicy?: Partial<AuthPolicy>;
  /** See `AppModuleOptions.keyProvider`. */
  keyProvider?: KeyProvider;
  /** `client_portal` flag (T-0179). Off, portal routes answer 404. */
  portalEnabled?: boolean;
  /** `self_serve_signup` (T-0016). Off, sign-up routes answer 404. */
  selfServeSignup?: boolean;
  /** `onboarding_persistence` (T-0018). Off, onboarding routes answer 404. */
  onboardingPersistence?: boolean;
  /** Migrator connection for self-serve provision (operator boundary). */
  selfServeProvisioningConnection?: string;
}

/**
 * The authentication module: its controller, its services, and its pool
 * (T-0049, D-P16).
 *
 * THIS IS THE ONLY IMPORTER OF `AuthDatabaseModule`, and it exports nothing.
 * Nest resolves a guard's or interceptor's dependencies in the module that
 * hosts the controller using it, so `AuthTenantTransactionInterceptor` (which
 * needs `AUTH_PG_POOL`) can only be used by a controller hosted here. A
 * controller anywhere else that reaches for it fails at boot with an
 * unresolved dependency, rather than quietly running a request as the one role
 * allowed to write the auth tables. `auth.module.test.ts` proves that.
 *
 * Global providers it relies on: `PG_POOL` (DatabaseModule) and `AUTH_MODE`
 * (exported by AppModule), for `KasuwaAuthGuard` and the app-pool reads.
 */
@Module({})
export class AuthModule {
  static forRoot(options: AuthModuleOptions): DynamicModule {
    return {
      module: AuthModule,
      imports: [
        AuthDatabaseModule.forRoot({
          authDatabaseUrl: options.authDatabaseUrl,
          ...(options.poolMax === undefined ? {} : { poolMax: options.poolMax }),
          ...(options.connectionTimeoutMillis === undefined
            ? {}
            : { connectionTimeoutMillis: options.connectionTimeoutMillis }),
        }),
      ],
      controllers: [AuthController, PortalController, PortalReadsController],
      providers: [
        AuthService,
        PortalService,
        PortalReadsService,
        PortalAuthGuard,
        PortalEnabledGuard,
        PortalTransactionInterceptor,
        {
          provide: PORTAL_ENABLED_TOKEN,
          useValue: options.portalEnabled === true,
        },
        MfaService,
        CommitThenFailInterceptor,
        SignInThrottleGuard,
        AuthTenantTransactionInterceptor,
        PoolIdentityCheck,
        {
          provide: AUTH_POLICY,
          useValue: { ...DEFAULT_AUTH_POLICY, ...options.authPolicy },
        },
        {
          provide: KEY_PROVIDER,
          useValue: options.keyProvider ?? createDevelopmentKeyProvider(),
        },
        SelfServeSignupService,
        OnboardingPersistenceGuard,
        {
          provide: SELF_SERVE_SIGNUP_ENABLED,
          useValue: options.selfServeSignup ?? false,
        },
        {
          provide: ONBOARDING_PERSISTENCE_ENABLED,
          useValue: options.onboardingPersistence ?? false,
        },
        {
          provide: SELF_SERVE_PROVISIONING_CONNECTION,
          useValue: options.selfServeProvisioningConnection ?? null,
        },
      ],
      exports: [OnboardingPersistenceGuard, ONBOARDING_PERSISTENCE_ENABLED],
    };
  }
}
