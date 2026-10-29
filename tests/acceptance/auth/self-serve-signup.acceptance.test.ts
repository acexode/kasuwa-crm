import type { INestApplication } from '@nestjs/common';
import { FakeChannelProvider } from '@kasuwa/channel-adapter';
import { NON_TENANT_SCOPED_TABLES } from '@kasuwa/db';
import { FLAGS } from '@kasuwa/feature-flags';
import { reseed } from '@kasuwa/testing';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApi } from '../support/api';

/**
 * ACCEPTANCE — T-0016, self-serve sign-up behind `self_serve_signup`.
 */

const SIGN_UP = '/api/v1/auth/sign-up';
const VERIFY = '/api/v1/auth/verify-otp';

const SIGNUP_BODY = {
  fullName: 'Amina Bello',
  email: 'amina.selfserve@example.test',
  phoneE164: '+27820000001',
  organisationName: 'Cape Contact Services',
  country: 'ZA',
  employeeSize: '51-200' as const,
  isBpo: true,
  password: 'correct-horse-battery-staple',
  acceptedTermsAt: new Date().toISOString(),
};

function extractOtp(provider: FakeChannelProvider): string {
  const last = provider.sent.at(-1);
  if (last === undefined) {
    throw new Error('no OTP was sent through the channel provider');
  }
  const match = /(\d{6})/u.exec(last.body);
  if (match?.[1] === undefined) {
    throw new Error('OTP not found in provider body');
  }
  return match[1];
}

describe('acceptance: self-serve sign-up (T-0016)', () => {
  let appOff: INestApplication;
  let appOn: INestApplication;
  let channel: FakeChannelProvider;
  const RUN = Date.now().toString(36);

  beforeAll(async () => {
    channel = new FakeChannelProvider();
    const url = inject('databaseUrl');
    appOff = await createApi(url, { selfServeSignup: false });
    appOn = await createApi(url, {
      selfServeSignup: true,
      selfServeProvisioningConnection: inject('migrationUrl'),
      channelProvider: channel,
    });
  });

  afterEach(async () => {
    await reseed(inject('migrationUrl'));
  });

  afterAll(async () => {
    await appOff?.close();
    await appOn?.close();
    await reseed(inject('migrationUrl'));
  });

  it('registers signup_attempt as non-tenant-scoped', () => {
    expect(NON_TENANT_SCOPED_TABLES).toContain('signup_attempt');
    expect(FLAGS.self_serve_signup?.defaultValue).toBe(false);
  });

  it('answers 501 when the flag is off', async () => {
    const response = await request(appOff.getHttpServer()).post(SIGN_UP).send(SIGNUP_BODY);
    expect(response.status).toBe(501);
    expect(response.body).toMatchObject({ code: 'not_implemented' });
  });

  it('returns identical 202 bodies for a new and an existing email', async () => {
    const fresh = {
      ...SIGNUP_BODY,
      email: `new.${RUN}@example.test`,
      phoneE164: '+27820000002',
      organisationName: `Org ${RUN}`,
    };
    const first = await request(appOn.getHttpServer()).post(SIGN_UP).send(fresh);
    expect(first.status).toBe(202);

    const client = new Client({ connectionString: inject('migrationUrl') });
    await client.connect();
    await client.query(
      `INSERT INTO tenant (id, name, slug, region_cell, status)
       VALUES (gen_random_uuid(), 'Existing Co', $1, 'za-1', 'active')`,
      [`existing-${RUN}`],
    );
    const tenant = await client.query<{ id: string }>(
      `SELECT id FROM tenant WHERE slug = $1`,
      [`existing-${RUN}`],
    );
    const tenantId = tenant.rows[0]?.id;
    await client.query(
      `INSERT INTO "user" (id, tenant_id, email, display_name, status, is_tenant_admin)
       VALUES (gen_random_uuid(), $1, $2, 'Existing Admin', 'active', true)`,
      [tenantId, fresh.email],
    );
    await client.end();

    const again = await request(appOn.getHttpServer()).post(SIGN_UP).send(fresh);
    expect(again.status).toBe(202);
    expect(again.body.verificationId).toEqual(expect.any(String));
    expect(again.body.emailHint).toBe(first.body.emailHint);
    expect(again.body.phoneHint).toBe(first.body.phoneHint);
  });

  it('delivers OTP through the channel provider and provisions a ZA tenant on verify', async () => {
    const body = {
      ...SIGNUP_BODY,
      email: `provision.${RUN}@example.test`,
      phoneE164: '+27820000003',
      organisationName: `Provision ${RUN}`,
    };
    const started = await request(appOn.getHttpServer()).post(SIGN_UP).send(body);
    expect(started.status).toBe(202);
    expect(channel.sent.length).toBeGreaterThan(0);
    expect(channel.sent[0]?.channel).toBe('sms');

    const verified = await request(appOn.getHttpServer())
      .post(VERIFY)
      .send({
        verificationId: started.body.verificationId,
        channel: 'phone',
        code: extractOtp(channel),
      });
    expect(verified.status).toBe(200);
    expect(verified.body).toMatchObject({
      emailVerified: true,
      phoneVerified: true,
      nextStep: 'onboarding',
    });

    const client = new Client({ connectionString: inject('migrationUrl') });
    await client.connect();
    const user = await client.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM "user" WHERE lower(email) = lower($1)`,
      [body.email],
    );
    expect(user.rows).toHaveLength(1);
    const tenant = await client.query<{ region_cell: string }>(
      `SELECT region_cell FROM tenant WHERE id = $1`,
      [user.rows[0]?.tenant_id],
    );
    expect(tenant.rows[0]?.region_cell).toBe('za-1');
    await client.end();
  });

  it('rejects a non-ZA country without a region field', async () => {
    const response = await request(appOn.getHttpServer())
      .post(SIGN_UP)
      .send({ ...SIGNUP_BODY, country: 'NG' });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'validation_failed' });
  });
});
