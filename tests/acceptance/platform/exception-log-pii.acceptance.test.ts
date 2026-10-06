import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import {
  Body,
  ConsoleLogger,
  Controller,
  Module,
  Param,
  Post,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '@kasuwa/api';
import {
  createPool,
  PROGRAMME_A1,
  TENANT_A,
  USER_A_AGENT_1,
  withTenantTransaction,
} from '@kasuwa/db';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { withAuthDatabase } from '../support/api';
import { collectTelemetry, isInboundApiSpan, type Telemetry } from '../support/telemetry';

/**
 * ACCEPTANCE — T-0036, no PII through Nest's exception logger (D-L42).
 *
 * The T-0005 suite (`observability-pii.acceptance.test.ts`) greps everything
 * the process emits THROUGH OPENTELEMETRY. It cannot see the other way out:
 * Nest's built-in exceptions handler, which on any non-HTTP error logs
 * `exception.message` and the stack, to stdout/stderr, outside the SDK. A pg
 * error's message can carry a row value (`invalid input syntax for type uuid:
 * "<the value>"`), its `detail` always can (`Key (...)=(<the value>) already
 * exists.`, `Failing row contains (...)`), and so can any Error a developer
 * builds from its inputs. In production that lands in the log aggregator.
 *
 * This suite triggers those errors deliberately, with probe values, and greps
 * EVERY channel the process can write to:
 *
 *   - Nest's Logger (every call, raw arguments, through a recording logger
 *     installed as the application logger, so `new Logger(ctx)` reaches it);
 *   - `process.stdout.write` and `process.stderr.write`, which is where the
 *     default ConsoleLogger actually writes in production;
 *   - `console.*`;
 *   - every span, its attributes AND its events, and every OTel log record;
 *   - the HTTP response body.
 *
 * Each probe value is grepped raw and percent-encoded, because one of them
 * travels in a URL path.
 *
 * ------------------------------------------------------------------------
 * WHAT THE BUILDER MUST PROVIDE. Internals are yours; these are not.
 *
 *   1. A GLOBAL exception filter (registered in `AppModule`, e.g. through
 *      `APP_FILTER`, so it also covers controllers from other modules — this
 *      suite mounts its own probe controller next to `AppModule.forRoot`).
 *      For anything that is not an `HttpException` it responds:
 *
 *        500 { statusCode: 500, error: 'Internal Server Error',
 *              code: 'internal_error', message: <fixed English text> }
 *
 *      The same body for every unexpected error: no database text, no
 *      SQLSTATE, no class name, no stack. Existing filters
 *      (`ValidationExceptionFilter`, `AdminErrorFilter`) and ordinary
 *      `HttpException`s keep their behaviour; that is not re-asserted here.
 *
 *   2. One log line per unexpected error that STILL makes the incident
 *      diagnosable without naming anybody: the error class (`error.name` /
 *      constructor name), the SQLSTATE `code` when the error has one, and the
 *      ROUTE TEMPLATE in Nest/Express form (`/api/v1/.../:param`), never the
 *      raw URL. Never `message`, never `detail`, never `where`, never stack
 *      frames that carry them, never the request. "One line" means one Nest
 *      Logger call, one line of stdout/stderr, one `console` call or one OTel
 *      log record — any of them, the suite does not prescribe which.
 *
 *   3. The telemetry contract change in `../support/telemetry.ts`:
 *      `collectTelemetry` (`packages/testing/src/telemetry.ts`) now returns
 *      each span's EVENTS. If the filter calls `span.recordException`, it
 *      must record a scrubbed exception (class and code), not the error.
 *
 * The probe controller below is test-only. It exists so the failures are
 * real pg errors raised by the real database through `withTenantTransaction`,
 * thrown through the real application's exception path, without depending on
 * some production route happening to forget a `catch` — a route that maps
 * its own unique violation to a 409 is correct, and must not make this suite
 * vacuous. Its writes roll back with the failing transaction.
 * ------------------------------------------------------------------------
 *
 * Sources: team/DECISIONS.md D-L42; team/tasks/T-0036-exception-log-pii.md;
 * CLAUDE.md section 6.1 ("never log PII ... not in logs, traces, error
 * messages, exception bodies") and 6.4.
 */

/**
 * Probe values. Invented, unmistakable, and none of them can occur in a log by
 * chance. CLAUDE.md 6 forbids real identifiers in fixtures as firmly as in logs.
 */
const PII = {
  email: 'chidinma.eze.t0036-probe@example.test',
  phone: '+2348039990036',
  name: 'Chidinma Eze-T0036Probe',
  nin: '00000000036',
} as const;

/** The probe routes, as Nest/Express name them: the form the log must carry. */
const ROUTE = {
  duplicate: '/api/v1/t0036-probe/portal-users/duplicate',
  check: '/api/v1/t0036-probe/portal-users/check',
  lookup: '/api/v1/t0036-probe/lookup/:reference',
  thrown: '/api/v1/t0036-probe/thrown',
} as const;

/** Text that only a database error or a raw exception would put in a body. */
const DATABASE_TEXT = [
  'duplicate key',
  'violates',
  'Failing row',
  'invalid input syntax',
  'portal_user',
  'DatabaseError',
  'T0036ProbeError',
  '23505',
  '23514',
  '22P02',
  '    at ',
];

/** Thrown by the probe with a message built from its inputs, as real code does. */
class T0036ProbeError extends Error {
  override readonly name = 'T0036ProbeError';
  /** A pg-style extra field: filters that log `detail` must not find it safe. */
  readonly detail: string;

  constructor(message: string, detail: string) {
    super(message);
    this.detail = detail;
  }
}

/* ------------------------------------------------------------------------ */
/* The probe controller (test-only) and the database it reaches.             */
/* ------------------------------------------------------------------------ */

let probePool: Pool | null = null;

function pool(): Pool {
  if (probePool === null) throw new Error('T-0036 suite: probe pool not created');
  return probePool;
}

/** A seeded user with PROGRAMME_A1 in scope, so the inserts pass RLS. */
const PROBE_SESSION = { tenantId: TENANT_A, userId: USER_A_AGENT_1 };

const INSERT_PORTAL_USER = `
  INSERT INTO portal_user (id, tenant_id, programme_id, email, email_masked, display_name, access)
  VALUES ($1, $2, $3, $4, 'c***@example.test', $5, $6)`;

@Controller('api/v1/t0036-probe')
class ExceptionProbeController {
  /** A real 23505: the same address twice in one programme. `detail` carries it. */
  @Post('portal-users/duplicate')
  async duplicate(@Body() body: { email: string; name: string }): Promise<void> {
    await withTenantTransaction(pool(), PROBE_SESSION, async (tx) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await tx.query(INSERT_PORTAL_USER, [
          randomUUID(),
          TENANT_A,
          PROGRAMME_A1,
          body.email,
          body.name,
          'viewer',
        ]);
      }
    });
  }

  /** A real 23514: `Failing row contains (...)` echoes the address and name. */
  @Post('portal-users/check')
  async check(@Body() body: { email: string; name: string }): Promise<void> {
    await withTenantTransaction(pool(), PROBE_SESSION, async (tx) => {
      await tx.query(INSERT_PORTAL_USER, [
        randomUUID(),
        TENANT_A,
        PROGRAMME_A1,
        body.email,
        body.name,
        'not-an-access-level',
      ]);
    });
  }

  /**
   * A real 22P02, whose MESSAGE (not only its detail) carries the value — the
   * case Nest's default handler prints verbatim. The value arrives in the URL
   * path, so the raw URL must not be logged either.
   */
  @Post('lookup/:reference')
  async lookup(@Param('reference') reference: string): Promise<void> {
    await withTenantTransaction(pool(), PROBE_SESSION, async (tx) => {
      await tx.query('SELECT $1::uuid AS id', [reference]);
    });
  }

  /** Not a database error at all: an Error whose message names a person. */
  @Post('thrown')
  thrown(@Body() body: { email: string; phone: string; nin: string }): never {
    throw new T0036ProbeError(`could not reach ${body.email} on ${body.phone}`, `nin=${body.nin}`);
  }
}

@Module({ controllers: [ExceptionProbeController] })
class ExceptionProbeModule {}

/* ------------------------------------------------------------------------ */
/* Capturing every channel.                                                  */
/* ------------------------------------------------------------------------ */

/** Every line any channel produced during one capture. */
let lines: string[] = [];

function render(value: unknown): string {
  // `inspect`, not JSON: JSON.stringify(new Error()) is "{}", which would make
  // a logged error object look clean. inspect prints message, stack and own
  // properties such as pg's `detail`.
  return typeof value === 'string'
    ? value
    : inspect(value, { depth: 12, breakLength: Number.POSITIVE_INFINITY, showHidden: false });
}

function recordLine(args: readonly unknown[]): void {
  lines.push(args.map(render).join(' '));
}

/**
 * The application logger: records every call's raw arguments, then lets the
 * real ConsoleLogger format and write them, so the stdout/stderr capture below
 * sees exactly what production would.
 */
class RecordingLogger extends ConsoleLogger {
  override log(message: unknown, ...rest: unknown[]): void {
    recordLine([message, ...rest]);
    super.log(message, ...rest);
  }
  override error(message: unknown, ...rest: unknown[]): void {
    recordLine([message, ...rest]);
    super.error(message, ...rest);
  }
  override warn(message: unknown, ...rest: unknown[]): void {
    recordLine([message, ...rest]);
    super.warn(message, ...rest);
  }
  override debug(message: unknown, ...rest: unknown[]): void {
    recordLine([message, ...rest]);
    super.debug(message, ...rest);
  }
  override verbose(message: unknown, ...rest: unknown[]): void {
    recordLine([message, ...rest]);
    super.verbose(message, ...rest);
  }
  override fatal(message: unknown, ...rest: unknown[]): void {
    recordLine([message, ...rest]);
    super.fatal(message, ...rest);
  }
}

interface Captured {
  status: number;
  body: unknown;
  rawBody: string;
  telemetry: Telemetry;
  /** Every log line from every channel, OTel log records included. */
  lines: string[];
}

/**
 * Runs one request with every channel captured. The stream and console spies
 * are installed OUTSIDE `collectTelemetry`, so they also cover the moment
 * after the response when the request span and its log record end.
 */
async function capture(send: () => request.Test): Promise<Captured> {
  lines = [];
  const chunkToLines = (chunk: unknown): void => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString();
    for (const line of text.split('\n')) if (line !== '') lines.push(line);
  };
  const spies = [
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      chunkToLines(chunk);
      return true;
    }),
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      chunkToLines(chunk);
      return true;
    }),
    ...(['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => recordLine(args)),
    ),
  ];

  let status = 0;
  let body: unknown;
  let rawBody = '';
  let telemetry: Telemetry;
  try {
    telemetry = await collectTelemetry(async () => {
      const response = await send();
      status = response.status;
      body = response.body;
      rawBody = response.text;
    });
  } finally {
    for (const spy of spies) spy.mockRestore();
  }

  return {
    status,
    body,
    rawBody,
    telemetry,
    lines: [...lines, ...telemetry.logs.map((record) => render(record))],
  };
}

/** The raw value and its URL-encoded form (see the T-0005 suite's `formsOf`). */
function formsOf(value: string): string[] {
  return [...new Set([value, encodeURIComponent(value)])];
}

/**
 * Greps everything the process emitted and returned. Span events are named
 * separately in the haystack so a failure says where the value went.
 */
function expectNoPii(captured: Captured, what: string): void {
  const { telemetry } = captured;

  // The contract, enforced: a span without `events` is not "a span with no
  // events", it is a collector that does not look.
  for (const span of telemetry.spans) {
    expect(
      Array.isArray(span.events),
      `${span.name}: collectTelemetry returned no events array`,
    ).toBe(true);
  }

  const channels: Record<string, string> = {
    'a log line (Nest Logger, stdout/stderr, console or an OTel log record)':
      captured.lines.join('\n'),
    'a span attribute': JSON.stringify(telemetry.spans.map((span) => span.attributes)),
    'a span event': JSON.stringify(telemetry.spans.map((span) => span.events)),
    'the response body': captured.rawBody,
  };

  for (const [channel, haystack] of Object.entries(channels)) {
    for (const [label, value] of Object.entries(PII)) {
      for (const form of formsOf(value)) {
        expect(haystack, `${what}: ${channel} leaked the ${label} (as "${form}")`).not.toContain(
          form,
        );
      }
    }
  }
}

/** True when ONE line carries every needle. */
function someLineCarries(captured: Captured, needles: readonly string[]): boolean {
  return captured.lines.some((line) => needles.every((needle) => line.includes(needle)));
}

/* ------------------------------------------------------------------------ */

describe('acceptance: an unexpected error leaves no personal data in any log, span or body', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const databaseUrl = inject('databaseUrl');
    probePool = createPool({
      connectionString: databaseUrl,
      max: 2,
      applicationName: 't0036-probe',
    });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(withAuthDatabase({ databaseUrl, poolMax: 5 })), ExceptionProbeModule],
    }).compile();

    // NOT `logger: false` (which `createApi` uses): silencing the logger would
    // make this suite pass on exactly the defect it exists to catch.
    app = moduleRef.createNestApplication({ logger: new RecordingLogger() });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await probePool?.end();
    probePool = null;
  });

  const server = () => app.getHttpServer();

  const duplicate = () =>
    request(server()).post(ROUTE.duplicate).send({ email: PII.email, name: PII.name });
  const checkViolation = () =>
    request(server()).post(ROUTE.check).send({ email: PII.email, name: PII.name });
  const lookup = () =>
    request(server()).post(ROUTE.lookup.replace(':reference', encodeURIComponent(PII.email)));
  const thrown = () =>
    request(server()).post(ROUTE.thrown).send({ email: PII.email, phone: PII.phone, nin: PII.nin });

  it('a unique violation on a portal-user email leaks the email nowhere', async () => {
    const captured = await capture(duplicate);

    // Without this the grep passes on a probe that never reached the database.
    expect(captured.status, 'the duplicate insert did not fail as a 500').toBe(500);
    expectNoPii(captured, 'unique violation (23505)');
  });

  it('a check violation whose detail echoes the row leaks neither email nor name', async () => {
    const captured = await capture(checkViolation);

    expect(captured.status, 'the check violation did not fail as a 500').toBe(500);
    expectNoPii(captured, 'check violation (23514)');
  });

  it('a database error whose MESSAGE carries a value from the URL path leaks it in no form', async () => {
    // 22P02 is the case Nest's default handler prints verbatim today: the value
    // is in `message`, not just `detail`. It also arrived percent-encoded in
    // the path, so the raw URL is a second way out.
    const captured = await capture(lookup);

    expect(captured.status, 'the bad cast did not fail as a 500').toBe(500);
    expectNoPii(captured, 'invalid input syntax (22P02)');
  });

  it('an unexpected Error whose message and fields name a person is scrubbed the same way', async () => {
    const captured = await capture(thrown);

    expect(captured.status, 'the thrown error did not become a 500').toBe(500);
    expectNoPii(captured, 'thrown Error');
  });

  it('answers every unexpected error with the same generic 500 body, with a code', async () => {
    const responses = [
      await capture(duplicate),
      await capture(checkViolation),
      await capture(lookup),
      await capture(thrown),
    ];

    for (const response of responses) {
      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({
        statusCode: 500,
        error: 'Internal Server Error',
        code: 'internal_error',
      });
      expect(typeof (response.body as { message?: unknown }).message, 'no message').toBe('string');
      for (const text of DATABASE_TEXT) {
        expect(response.rawBody, `the 500 body carries "${text}"`).not.toContain(text);
      }
    }

    // Generic means identical: a body that differs by failure tells the caller
    // which constraint, column or code path it hit.
    const pick = (body: unknown) => {
      const { statusCode, error, code, message } = body as Record<string, unknown>;
      return { statusCode, error, code, message };
    };
    const [first, ...rest] = responses.map((response) => pick(response.body));
    for (const other of rest) expect(other, 'the 500 body varies with the failure').toEqual(first);
  });

  it('still logs the database error class or SQLSTATE and the route template, on one line', async () => {
    // Scrubbing everything is not the goal; an incident nobody can diagnose
    // gets "fixed" by someone logging the error object. The line must name the
    // failure and where it happened, using things that name nobody.
    const unique = await capture(duplicate);
    expect(
      someLineCarries(unique, ['23505', ROUTE.duplicate]),
      `no single log line carries the SQLSTATE 23505 and the route ${ROUTE.duplicate}`,
    ).toBe(true);

    // The path-parameter route: the TEMPLATE is logged, not the URL that was hit.
    const cast = await capture(lookup);
    expect(
      someLineCarries(cast, ['22P02', ROUTE.lookup]),
      `no single log line carries the SQLSTATE 22P02 and the route template ${ROUTE.lookup}`,
    ).toBe(true);
  });

  it('still logs a thrown error by class and route template, on one line', async () => {
    const captured = await capture(thrown);

    expect(
      someLineCarries(captured, ['T0036ProbeError', ROUTE.thrown]),
      `no single log line carries the class T0036ProbeError and the route ${ROUTE.thrown}`,
    ).toBe(true);
  });

  it('records the failure on an inbound span the event grep can actually see', async () => {
    // Guards the greps above against vacuity: the 500 produced an inbound span
    // under its route template, and every span reports its events.
    const { telemetry } = await capture(lookup);

    const inbound = telemetry.spans.filter(isInboundApiSpan);
    expect(
      inbound.length,
      'no inbound API span (one with http.route) was recorded',
    ).toBeGreaterThan(0);
    expect(
      inbound.some((span) => span.attributes['http.route'] === ROUTE.lookup),
      `no inbound span carries http.route ${ROUTE.lookup}`,
    ).toBe(true);
    expect(
      inbound.some((span) => span.attributes['http.response.status_code'] === 500),
      'the inbound span does not record the 500',
    ).toBe(true);
    for (const span of telemetry.spans) {
      expect(Array.isArray(span.events), `${span.name}: no events array`).toBe(true);
    }
  });
});
