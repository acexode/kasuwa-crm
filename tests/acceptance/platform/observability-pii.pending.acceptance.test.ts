import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { PROGRAMME_A1, SEED_CONTACTS, TENANT_A, USER_A_AGENT_1 } from '@kasuwa/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { asUser, createApi } from '../support/api';

/**
 * ACCEPTANCE — T-0005, observability skeleton (Agent 13, DevOps).
 *
 * PENDING. `pnpm test:pending` runs them. Renaming this file to drop
 * `.pending` is what assigns the task.
 *
 * These supersede the `it.todo` entries in
 * `tests/acceptance/platform/observability.acceptance.test.ts` for the two
 * behaviours that actually carry risk. The rest of that stub stays as a
 * checklist.
 *
 * ------------------------------------------------------------------------
 * WHY THE PII ASSERTION IS THE WHOLE POINT
 *
 * Telemetry is the classic way personal data escapes a system that is
 * otherwise careful with it. Nobody decides to log a customer's BVN. What
 * happens is that someone attaches a request body to a span "for debugging"
 * during an incident, it ships, and six months later a Nigerian customer's
 * phone number is sitting in a US-hosted trace store — which is an NDPA
 * cross-border transfer nobody assessed, discovered by a regulator rather
 * than by us.
 *
 * Every other control in `CLAUDE.md` section 6 points at the request path.
 * This one points at the observability path, which is the path that gets
 * added under pressure at 3am and reviewed by nobody.
 *
 * So the test does not check that we remembered to redact. It sends a
 * deliberately PII-heavy request and then greps everything the process
 * emitted for the exact values it sent. A redaction helper that works on the
 * fields someone thought of is not what is being asserted here.
 * ------------------------------------------------------------------------
 *
 * THE CONTRACT for Agent 13. Internals are yours; these are not:
 *
 *   `packages/testing/src/telemetry.ts`, exported from `@kasuwa/testing`:
 *     collectTelemetry(fn): Promise<{
 *       spans: { name: string; attributes: Record<string, unknown> }[];
 *       logs:  Record<string, unknown>[];
 *     }>
 *
 *   It installs an in-memory span exporter and log sink for the duration of
 *   `fn` and restores whatever was there before. It lives in `@kasuwa/testing`
 *   because that package is already lint-fenced out of application code.
 */

/** A seeded contact tenant A can legitimately read — reused, never re-invented. */
const CONTACT_A1_1 = SEED_CONTACTS.filter((contact) => contact.programmeId === PROGRAMME_A1)[0]
  ?.id;

const repoRoot = resolve(__dirname, '..', '..', '..');

function fromRoot(...segments: string[]): string {
  return resolve(repoRoot, ...segments);
}

/**
 * Deliberately PII-heavy, and deliberately values that cannot occur by chance.
 * Every one of these is a field a support engineer would plausibly want in a
 * trace, which is exactly why none of them may be there.
 *
 * These are invented. `CLAUDE.md` section 6 forbids real identifiers in
 * fixtures as firmly as in logs.
 */
const PII = {
  email: 'adaeze.okonkwo.pii-probe@example.test',
  phone: '+2348030000000',
  nin: '00000000001',
  bvn: '22000000001',
  name: 'Adaeze Okonkwo-PiiProbe',
} as const;

/** A recorded span, reduced to the two things these assertions care about. */
interface RecordedSpan {
  name: string;
  attributes: Record<string, unknown>;
}

interface Telemetry {
  spans: RecordedSpan[];
  logs: Record<string, unknown>[];
}

/**
 * Loaded by path rather than by package name, so this file typechecks before
 * `collectTelemetry` exists. It is a pending test: it has to compile today and
 * fail at runtime, not fail the typecheck gate for everyone else.
 *
 * Agent 13 may delete this indirection and import from '@kasuwa/testing'
 * directly once the export lands.
 */
async function collectTelemetry(fn: () => Promise<void>): Promise<Telemetry> {
  const module: { collectTelemetry?: (fn: () => Promise<void>) => Promise<Telemetry> } =
    await import(resolve(repoRoot, 'packages/testing/src/telemetry.ts'));

  if (typeof module.collectTelemetry !== 'function') {
    throw new Error('T-0005: packages/testing/src/telemetry.ts must export collectTelemetry()');
  }

  return module.collectTelemetry(fn);
}

describe('acceptance (pending): telemetry never carries personal data', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApi(inject('databaseUrl'));
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();

  it('emits no span attribute and no log field containing the values it was sent', async () => {
    const { spans, logs } = await collectTelemetry(async () => {
      // A search request carrying every identifier we forbid, in a query
      // string, a header and a body — the three places telemetry hoovers up
      // automatically. The endpoint may reject it; that is fine. The
      // assertion is about what was RECORDED, not what was accepted.
      await request(server())
        .post('/api/v1/contacts/search')
        .set(asUser(TENANT_A, USER_A_AGENT_1))
        .set('x-caller-email', PII.email)
        .query({ q: PII.phone })
        .send({ email: PII.email, phone: PII.phone, nin: PII.nin, bvn: PII.bvn, name: PII.name });
    });

    expect(spans.length, 'no spans were recorded at all — is telemetry wired?').toBeGreaterThan(
      0,
    );

    // Grep everything, rather than checking the fields we thought of. A
    // redaction helper that covers the known fields is the thing that fails
    // in production; this catches the unknown one.
    const haystack = JSON.stringify({ spans, logs });

    for (const [label, value] of Object.entries(PII)) {
      expect(haystack, `telemetry leaked the ${label} it was sent`).not.toContain(value);
    }
  });

  it('records an error without recording the request that caused it', async () => {
    // The specific 3am failure mode: an exception handler that attaches the
    // body so the error is "actionable".
    const { spans, logs } = await collectTelemetry(async () => {
      await request(server())
        .post('/api/v1/contacts')
        .set(asUser(TENANT_A, USER_A_AGENT_1))
        .send({ email: PII.email, nin: PII.nin, deliberatelyInvalid: true });
    });

    const haystack = JSON.stringify({ spans, logs });

    for (const [label, value] of Object.entries(PII)) {
      expect(haystack, `error telemetry leaked the ${label}`).not.toContain(value);
    }

    // It must still be diagnosable: the route and the error type, which name
    // nobody.
    expect(haystack, 'the error is unattributable to a route').toMatch(/contacts/);
  });

  it('carries tenant_id, programme_id and cell on the spans it does emit', async () => {
    // Without these a trace cannot be scoped to a tenant during an incident,
    // and the first instinct of whoever is debugging will be to add the one
    // attribute that identifies the customer — which is a person.
    const { spans } = await collectTelemetry(async () => {
      await request(server())
        .get(`/api/v1/contacts/${CONTACT_A1_1}`)
        .set(asUser(TENANT_A, USER_A_AGENT_1));
    });

    const http = spans.filter((span: RecordedSpan) => 'tenant_id' in span.attributes);
    expect(http.length, 'no span carries tenant_id').toBeGreaterThan(0);

    for (const span of http) {
      expect(span.attributes.tenant_id, `${span.name}: wrong tenant_id`).toBe(TENANT_A);
      expect(span.attributes.cell, `${span.name}: no cell attribute`).toBeDefined();
      // Programme scope is resolved, never supplied — so a programme-scoped
      // route must report what the SESSION resolved, not what was asked for.
      expect(span.attributes.programme_id, `${span.name}: no programme_id`).toBeDefined();
    }
  });

  it('correlates a trace without trusting a client-supplied id', async () => {
    // A client-controlled trace id lets a caller merge its spans into someone
    // else's trace, or poison a trace store with a chosen id. Accept it as a
    // parent at most; never as the identity of the trace.
    const forged = 'deadbeefdeadbeefdeadbeefdeadbeef';
    const { spans } = await collectTelemetry(async () => {
      await request(server())
        .get(`/api/v1/contacts/${CONTACT_A1_1}`)
        .set(asUser(TENANT_A, USER_A_AGENT_1))
        .set('x-request-id', forged);
    });

    const haystack = JSON.stringify(spans);
    expect(haystack, 'a client-supplied id became the trace identity').not.toContain(forged);
  });
});

describe('acceptance (pending): CI is hardened', () => {
  const ci = () => readFileSync(fromRoot('.github/workflows/ci.yml'), 'utf8');

  it('scans for secrets, vulnerable dependencies and container CVEs', () => {
    // NOTE: GitGuardian already runs as a GitHub App check on every PR, so
    // secret scanning is not absent today. The ask is an in-repo scanner as
    // well, for two reasons: it runs on a fork and on a developer's machine,
    // where the App does not, and it fails the build rather than posting a
    // check someone can decline to read. Dependency and container scanning
    // have no equivalent at all.
    const workflow = ci();

    expect(workflow, 'no secret scanning').toMatch(/gitleaks|trufflehog/i);
    expect(workflow, 'no dependency scanning').toMatch(/osv-scanner|audit|snyk/i);
  });

  it('does not rebuild the world for a one-file change', () => {
    // Stated as a measured improvement in the task's definition of done; this
    // is the structural half of it.
    expect(ci(), 'CI does not use nx affected or remote caching').toMatch(
      /nx affected|nx-cloud|NX_CLOUD/,
    );
  });

  it('uploads test reports when a job fails', () => {
    // A red build that cannot be diagnosed without re-running it locally gets
    // re-run rather than read, and then gets ignored.
    const workflow = ci();
    expect(workflow).toMatch(/upload-artifact/);
    expect(workflow).toMatch(/if:\s*failure\(\)/);
  });

  it('writes down what a red isolation check means', () => {
    // The one runbook that has to exist before there is an incident, because
    // the pressure during one is always toward merging past it.
    const runbook = fromRoot('docs/runbooks/red-isolation-check.md');
    expect(existsSync(runbook), 'docs/runbooks/red-isolation-check.md is missing').toBe(true);

    const text = readFileSync(runbook, 'utf8');
    expect(text, 'the runbook does not say never to merge past it').toMatch(/never merge/i);
  });
});

describe('acceptance (pending): nothing was provisioned', () => {
  it('writes Terraform but applies none of it', () => {
    // D-A4 is unanswered. The task is to produce a plan and a cost estimate so
    // it can be answered with numbers rather than a guess — not to spend money
    // while waiting for permission to spend money.
    const stateFiles = ['infra/terraform.tfstate', 'infra/terraform.tfstate.backup'];
    for (const file of stateFiles) {
      expect(existsSync(fromRoot(file)), `${file} exists — something was applied`).toBe(false);
    }

    const estimate = fromRoot('infra/COST-ESTIMATE.md');
    expect(existsSync(estimate), 'no cost estimate for D-A4 to be answered with').toBe(true);
  });
});
