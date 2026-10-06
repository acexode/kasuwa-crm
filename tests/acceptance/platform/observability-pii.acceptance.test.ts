import type { INestApplication } from '@nestjs/common';
import { PROGRAMME_A1, SEED_CONTACTS, TENANT_A, USER_A_AGENT_1 } from '@kasuwa/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { asUser, createApi } from '../support/api';
import { collectTelemetry, isInboundApiSpan, type RecordedSpan } from '../support/telemetry';

/**
 * ACCEPTANCE — T-0005, observability skeleton (Agent 13, DevOps).
 *
 * ACTIVE. Promoted out of `.pending` when T-0005 was assigned (D-L23), so the
 * blocking `isolation` project enforces it from here on.
 *
 * Scope of this file is the telemetry path only. The CI assertions that used
 * to sit here moved to `platform/ci-hardening.acceptance.test.ts`, and the
 * "nothing was provisioned" assertion to
 * `platform/environments.pending.acceptance.test.ts`, because environments are
 * not part of this round of T-0005.
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
 * The contract Agent 13 must provide (`collectTelemetry()` in
 * `packages/testing/src/telemetry.ts`) is stated in `../support/telemetry.ts`.
 */

/** A seeded contact tenant A can legitimately read — reused, never re-invented. */
const CONTACT_A1_1 = SEED_CONTACTS.filter((contact) => contact.programmeId === PROGRAMME_A1)[0]
  ?.id;

/**
 * Deliberately PII-heavy, and deliberately values that cannot occur by chance.
 * Every one of these is a field a support engineer would plausibly want in a
 * trace, which is exactly why none of them may be there.
 *
 * These are invented. `CLAUDE.md` section 6 forbids real identifiers in
 * fixtures as firmly as in logs.
 *
 * "Cannot occur by chance" includes the fixture ids, which every trace
 * carries. They end in long runs of zeros (`…-000000000001`), so the NIN
 * probe was once `00000000001` and matched tenant A's id in every span: a
 * failure that named a leak which was not there. The probe now uses digits
 * with no runs, which no hand-written fixture id contains.
 */
const PII = {
  email: 'adaeze.okonkwo.pii-probe@example.test',
  phone: '+2348030000000',
  nin: '70451962038',
  bvn: '22000000001',
  name: 'Adaeze Okonkwo-PiiProbe',
} as const;

/**
 * Every form a value can take once it has passed through a URL. A value sent in
 * a query string is recorded percent-encoded (`url.full`, `http.target`), so
 * `+2348030000000` lands in a span as `%2B2348030000000` — which does not
 * contain the raw string. Grepping only the raw form would pass on exactly the
 * leak the query-string probe exists to catch.
 */
function formsOf(value: string): string[] {
  return [...new Set([value, encodeURIComponent(value)])];
}

function expectNoPii(haystack: string, what: string): void {
  for (const [label, value] of Object.entries(PII)) {
    for (const form of formsOf(value)) {
      expect(haystack, `${what} leaked the ${label} it was sent (as "${form}")`).not.toContain(
        form,
      );
    }
  }
}

describe('acceptance: telemetry never carries personal data', () => {
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
    expectNoPii(JSON.stringify({ spans, logs }), 'telemetry');
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

    expectNoPii(haystack, 'error telemetry');

    // It must still be diagnosable: the route and the error type, which name
    // nobody.
    expect(haystack, 'the error is unattributable to a route').toMatch(/contacts/);
  });

  it('carries tenant_id, programme_id and cell on every API span it emits', async () => {
    // Without these a trace cannot be scoped to a tenant during an incident,
    // and the first instinct of whoever is debugging will be to add the one
    // attribute that identifies the customer — which is a person.
    const { spans } = await collectTelemetry(async () => {
      await request(server())
        .get(`/api/v1/contacts/${CONTACT_A1_1}`)
        .set(asUser(TENANT_A, USER_A_AGENT_1));
    });

    // The inbound request span is held to the rule whether or not it carries
    // tenant_id. Selecting only spans that already carry tenant_id would make
    // the assertion check itself: an API span WITHOUT it would never be looked
    // at, which is the defect this test exists to catch.
    const inbound = spans.filter(isInboundApiSpan);
    expect(inbound.length, 'no inbound API span (one with http.route) was recorded').toBeGreaterThan(
      0,
    );

    const held = spans.filter(
      (span: RecordedSpan) => isInboundApiSpan(span) || 'tenant_id' in span.attributes,
    );

    for (const span of held) {
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

    // Without this the assertion below passes on a process that records
    // nothing, which is not the same as one that records safely.
    expect(spans.length, 'no spans were recorded at all — is telemetry wired?').toBeGreaterThan(
      0,
    );

    const haystack = JSON.stringify(spans);
    expect(haystack, 'a client-supplied id became the trace identity').not.toContain(forged);
  });
});
