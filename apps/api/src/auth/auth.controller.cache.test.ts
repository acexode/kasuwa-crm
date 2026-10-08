import 'reflect-metadata';
import { HEADERS_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { AuthController } from './auth.controller';

/**
 * Every auth response that carries a credential — a challenge id, a bearer
 * token, a TOTP secret or backup codes — is sent `Cache-Control: no-store`
 * (T-0012 review). Read from the route metadata Nest applies, so removing a
 * decorator fails here without a database.
 */

type Route = keyof AuthController;

const CREDENTIAL_ROUTES: Route[] = [
  'signIn',
  'verify',
  'enrol',
  'confirmEnrolment',
  'startTotpReplacement',
  'confirmTotpReplacement',
  'regenerateBackupCodes',
];

function headersOf(route: Route): { name: string; value: string }[] {
  const handler = AuthController.prototype[route] as unknown as object;
  return (Reflect.getMetadata(HEADERS_METADATA, handler) ?? []) as {
    name: string;
    value: string;
  }[];
}

describe('auth responses carrying credentials are never cached', () => {
  it.each(CREDENTIAL_ROUTES)('%s sends Cache-Control: no-store', (route) => {
    expect(headersOf(route)).toContainEqual({ name: 'Cache-Control', value: 'no-store' });
  });

  it('me sends Cache-Control: no-store: it carries the staff email and tenant id (T-0062 review)', () => {
    expect(headersOf('me')).toContainEqual({ name: 'Cache-Control', value: 'no-store' });
  });
});
