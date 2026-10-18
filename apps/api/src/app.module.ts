import {
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { KeyProvider } from '@kasuwa/auth-crypto';
import { defaultChannelProvider, type ChannelProvider } from '@kasuwa/channel-adapter';
import { nodeEnv, type NodeEnvName } from '@kasuwa/config';
import { AccountsController } from './accounts/accounts.controller';
import { ActivitiesController } from './activities/activities.controller';
import { MyActivitiesController } from './activities/my-activities.controller';
import { ADMIN_CONTROLLERS, AdminModule } from './admin/admin.module';
import { AuthController } from './auth/auth.controller';
import { AuthModule } from './auth/auth.module';
import type { AuthPolicy } from './auth/auth.policy';
import { ContactsController } from './contacts/contacts.controller';
import {
  BullImportQueues,
  DisabledImportQueues,
  IMPORT_QUEUES_TOKEN,
  STORED_OBJECTS_TOKEN,
  storedObjectsFor,
  type ImportQueues,
} from './imports/import-infra';
import { ImportCommitInterceptor, ImportsController } from './imports/imports.controller';
import { DatabaseModule } from './database/database.module';
import { DealsController, PipelineDealsController } from './deals/deals.controller';
import { HealthController } from './health/health.controller';
import { LeadsController } from './leads/leads.controller';
import { MeController } from './me/me.controller';
import { PipelinesController } from './pipelines/pipelines.controller';
import { CHANNEL, createApiChannel } from './messaging/channel';
import { ContactScriptsController, ScriptRunsController } from './scripts/script-runs.controller';
import { ScriptsController } from './scripts/scripts.controller';
import { ScriptsModule } from './scripts/scripts.module';
import { SearchController } from './search/search.controller';
import { SearchThrottleGuard } from './search/search-throttle.guard';
import { JsonBodyLimit } from './common/json-body-limit';
import { AUTH_MODE, KasuwaAuthGuard, type ResolvedAuthMode } from './tenancy/kasuwa-auth.guard';
import { StubAuthGuard } from './tenancy/stub-auth.guard';
import { TenantTransactionInterceptor } from './tenancy/tenant-transaction.interceptor';
import { NoStoreMiddleware } from './common/no-store.middleware';
import { UnexpectedErrorFilter } from './common/unexpected-error.filter';
import { ValidationExceptionFilter } from './common/zod-exception.filter';
import {
  RequestTelemetryMiddleware,
  TELEMETRY_OPTIONS,
  telemetryOptions,
} from './telemetry/request-telemetry';

/**
 * The records controllers (records.openapi.yaml): contacts and both timelines,
 * leads, accounts, activities, `/me/programmes`, the pipeline reads (T-0107), deals (T-0108) and global
 * search (T-0086). Every answer on every one
 * of their routes is `Cache-Control: no-store` (`NoStoreMiddleware`, T-0080).
 */
export const RECORDS_CONTROLLERS = [
  ContactsController,
  LeadsController,
  AccountsController,
  ActivitiesController,
  MeController,
  MyActivitiesController,
  PipelinesController,
  // The deals API (T-0108): listDeals and createDeal under a pipeline, and
  // getDeal, updateDeal and moveDeal.
  PipelineDealsController,
  DealsController,
  // Global search (T-0086): searchRecords and lookupRecords.
  SearchController,
  // CSV import (T-0094): the nine import operations.
  ImportsController,
];

/**
 * The scripting controllers (scripting.openapi.yaml: authoring T-0113, runs
 * T-0114), hosted by ScriptsModule. Every answer is `no-store` too: a script
 * carries a programme's compliance wording, and a run a customer's answers.
 */
export const SCRIPTING_CONTROLLERS = [
  ScriptsController,
  ScriptRunsController,
  ContactScriptsController,
];

/** Controllers hosted by this module. AuthController is hosted by AuthModule. */
const CONTROLLERS = [HealthController, ...RECORDS_CONTROLLERS];

/**
 * Every controller in the app, including those hosted by feature modules. Used
 * only for the telemetry vocabulary: a segment missing here becomes `:param` in
 * an unmatched path's `url.template`, which is safe but less useful. The admin
 * areas' controllers are derived from AdminModule, so a new area is covered
 * without an edit here.
 */
const TELEMETRY_CONTROLLERS = [
  ...CONTROLLERS,
  AuthController,
  ...SCRIPTING_CONTROLLERS,
  ...ADMIN_CONTROLLERS,
];

export interface AppModuleOptions {
  /** kasuwa_app (NOBYPASSRLS). Every route's tenant transaction runs on it. */
  databaseUrl: string;
  /**
   * kasuwa_auth (NOBYPASSRLS, a member of no role): the auth module's own
   * pool, and the only connection that may write the auth tables (T-0049,
   * D-P16, ADR-0013). `main.ts` passes DATABASE_AUTH_URL. Required: an API
   * without it could not record a sign-in, and would find out at the first
   * one rather than at boot.
   */
  authDatabaseUrl: string;
  /** Size of EACH pool (the app pool and the auth pool). */
  poolMax?: number;
  /**
   * How long a request waits for a pooled connection before it is answered
   * 503 `service_unavailable` with `Retry-After` (T-0045). Passed to
   * `createPool`'s `connectionTimeoutMillis` for both pools; omitted,
   * `createPool`'s 5 s default (T-0013) applies.
   */
  poolConnectionTimeoutMillis?: number;
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
  /**
   * NODE_ENV as `apiEnv` parsed it. Outside development and test the app
   * refuses to start when `kasuwa_test_admin` is usable (T-0117, D-L94).
   * `main.ts` passes it; omitted, `nodeEnv()` reads the process's, the same
   * default the channel provider uses.
   */
  nodeEnv?: NodeEnvName;
  /**
   * Redis, where the import API enqueues its BullMQ jobs (T-0094 interface
   * A). `main.ts` passes REDIS_URL. Omitted, the import writes that enqueue
   * answer 503, and every other route is unaffected.
   */
  redisUrl?: string;
  /**
   * The object store the import API presigns, completes and heads through
   * (T-0094 interface A), only ever via StoredObjectRepository. `main.ts`
   * passes an S3ObjectStore built from `storageEnv`. Omitted, the import
   * routes that touch storage answer 503.
   */
  objectStore?: unknown;
}

/** Closes the import queues' Redis connections with the app. */
@Injectable()
class ImportQueuesLifecycle implements OnApplicationShutdown {
  constructor(@Inject(IMPORT_QUEUES_TOKEN) private readonly queues: ImportQueues) {}

  async onApplicationShutdown(): Promise<void> {
    await this.queues.close();
  }
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
    // Every records answer is `no-store`, the guard's 401 and 400 included, which the
    // handlers' `@Header` (set after the guards) never reaches (T-0080, D-L90's follow-up).
    // And every scripting answer (T-0113, scripting.openapi.yaml's NoStore header).
    consumer.apply(NoStoreMiddleware).forRoutes(...RECORDS_CONTROLLERS, ...SCRIPTING_CONTROLLERS);
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
        DatabaseModule.forRoot({
          databaseUrl: options.databaseUrl,
          nodeEnv: options.nodeEnv ?? nodeEnv(),
          ...(options.poolMax === undefined ? {} : { poolMax: options.poolMax }),
          ...(options.poolConnectionTimeoutMillis === undefined
            ? {}
            : { connectionTimeoutMillis: options.poolConnectionTimeoutMillis }),
        }),
        // Authentication, with its own pool (T-0049). AuthModule is the only
        // importer of that pool's module and exports nothing, so nothing
        // outside src/auth can reach the role that writes the auth tables.
        // It also refuses to boot unless each pool logs in as its role.
        AuthModule.forRoot({
          authDatabaseUrl: options.authDatabaseUrl,
          ...(options.poolMax === undefined ? {} : { poolMax: options.poolMax }),
          ...(options.poolConnectionTimeoutMillis === undefined
            ? {}
            : { connectionTimeoutMillis: options.poolConnectionTimeoutMillis }),
          ...(options.authPolicy === undefined ? {} : { authPolicy: options.authPolicy }),
          ...(options.keyProvider === undefined ? {} : { keyProvider: options.keyProvider }),
        }),
        // Every admin area. A new area is added inside AdminModule, not here.
        AdminModule,
        // In-call script authoring (T-0113): its own module for its no-store
        // middleware, like the audit area.
        ScriptsModule,
      ],
      controllers: CONTROLLERS,
      providers: [
        // The 512 KiB JSON body limit, wherever the module boots (T-0113):
        // installed before Nest's own 100 KB parser would be.
        JsonBodyLimit,
        KasuwaAuthGuard,
        StubAuthGuard,
        TenantTransactionInterceptor,
        // The per-user search budgets (T-0086, D-L134): one instance, so one
        // set of counters, for both search routes.
        SearchThrottleGuard,
        // CSV import (T-0094): the queues, the stored-object repository and
        // the interceptor that enqueues only after a transaction commits.
        {
          provide: IMPORT_QUEUES_TOKEN,
          useFactory: (): ImportQueues =>
            options.redisUrl === undefined
              ? new DisabledImportQueues()
              : new BullImportQueues(options.redisUrl),
        },
        { provide: STORED_OBJECTS_TOKEN, useValue: storedObjectsFor(options.objectStore) },
        ImportCommitInterceptor,
        ImportQueuesLifecycle,
        { provide: AUTH_MODE, useValue: options.authMode ?? 'stub' },
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
