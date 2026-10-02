import type { INestApplication } from '@nestjs/common';
import { PROGRAMME_A1, SEED_CONTACTS, TENANT_A, USER_A_AGENT_1 } from '@kasuwa/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { asUser, createApi } from '../support/api';
import { collectTelemetry, isInboundApiSpan } from '../support/telemetry';

/**
 * ACCEPTANCE — T-0005, observability baseline (Agent 13, DevOps).
 *
 * This file was a checklist of seven placeholder stubs. D-L23 forbids an
 * assigned task from naming a stub, so on assignment each one became real:
 *
 *   every API span carries tenant_id            -> observability-pii: "carries tenant_id, programme_id and cell ..."
 *   programme-scoped spans carry programme_id   -> observability-pii: same test
 *   every span carries the cell identifier      -> observability-pii: same test
 *   no span attribute carries email/phone/NIN/BVN -> observability-pii: "emits no span attribute ..."
 *   no log field carries email/phone/NIN/BVN    -> observability-pii: same test
 *   error telemetry: type and route, not body   -> observability-pii: "records an error ..."
 *   correlated without a client-supplied id     -> observability-pii covers the "without" half;
 *                                                  THIS file covers "can be correlated"
 *
 * The last one was the only behaviour not already asserted: the PII suite
 * proves a forged id is not adopted, which a process that never correlates
 * anything also satisfies. This proves the server mints its own trace identity
 * and that one request is one trace.
 *
 * The contract is in `../support/telemetry.ts`.
 */

const CONTACT_A1_1 = SEED_CONTACTS.filter((contact) => contact.programmeId === PROGRAMME_A1)[0]
  ?.id;

const TRACE_ID = /^[0-9a-f]{32}$/;
const INVALID_TRACE_ID = '0'.repeat(32);

describe('acceptance: observability', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApi(inject('databaseUrl'));
  });

  afterAll(async () => {
    await app.close();
  });

  it('a trace can be correlated to a request without a client-supplied id', async () => {
    const { spans } = await collectTelemetry(async () => {
      // Two requests, neither carrying any trace or request id of its own.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await request(app.getHttpServer())
          .get(`/api/v1/contacts/${CONTACT_A1_1}`)
          .set(asUser(TENANT_A, USER_A_AGENT_1));
      }
    });

    const inbound = spans.filter(isInboundApiSpan);
    expect(inbound.length, 'expected one inbound API span per request').toBe(2);

    for (const span of spans) {
      expect(span.traceId, `${span.name}: not a W3C trace id`).toMatch(TRACE_ID);
      expect(span.traceId, `${span.name}: the invalid all-zero trace id`).not.toBe(
        INVALID_TRACE_ID,
      );
    }

    // Each request is its own trace — a constant or process-wide id
    // correlates nothing.
    const requestTraces = new Set(inbound.map((span) => span.traceId));
    expect(requestTraces.size, 'two requests share one trace id').toBe(2);

    // And everything recorded belongs to one of those traces: a span that
    // started its own trace cannot be followed back to the request that
    // caused it.
    for (const span of spans) {
      expect(
        requestTraces.has(span.traceId),
        `${span.name} is not correlated to either request's trace`,
      ).toBe(true);
    }
  });
});
