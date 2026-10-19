#!/usr/bin/env node
/**
 * DEMO ONLY: prints the current six-digit TOTP code for a seeded user, so the
 * presenter can sign in for real (P01/1 then P01/2) without an authenticator
 * app.
 *
 * The secrets and the password are the committed development fixtures in
 * packages/db/src/fixtures.ts, read from that file at run time rather than
 * copied here. They only exist in a database `pnpm db:seed` wrote, and the seed
 * refuses anything but localhost.
 *
 *   node tools/demo-totp.mjs admin      # Musa Bello, tenant admin
 *   node tools/demo-totp.mjs agent      # Tunde Adeyemi, agent
 *
 * Roles: admin, agent, agent2, unassigned, tenantb (docs/demo/DEMO.md, "Who to
 * sign in as"). Also imported by tools/demo-smoke.mjs, which signs in for real.
 *
 * A code is accepted once: the API refuses a step it has already accepted for
 * that user, so signing the same person in twice inside 30 seconds needs the
 * next code.
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The seeded demo people: user id, workspace slug and work email (development fixtures). */
export const DEMO_USERS = {
  admin: { userId: '11111111-0000-4000-8000-0000000d0003', slug: 'sahel-bpo', email: 'musa.supervisor@tenant-a.test' },
  agent: { userId: '11111111-0000-4000-8000-0000000d0001', slug: 'sahel-bpo', email: 'tunde.agent@tenant-a.test' },
  agent2: { userId: '11111111-0000-4000-8000-0000000d0002', slug: 'sahel-bpo', email: 'ngozi.agent@tenant-a.test' },
  unassigned: { userId: '11111111-0000-4000-8000-0000000d0004', slug: 'sahel-bpo', email: 'emeka.unassigned@tenant-a.test' },
  tenantb: { userId: '22222222-0000-4000-8000-0000000d0005', slug: 'rift-valley-contact', email: 'wanjiru.agent@tenant-b.test' },
};

function fixtures() {
  return readFileSync(join(resolve(import.meta.dirname, '..'), 'packages', 'db', 'src', 'fixtures.ts'), 'utf8');
}

/** The development fixture password, read from packages/db/src/fixtures.ts. */
export function demoPassword() {
  const match = /export const SEED_PASSWORD = '([^']+)'/.exec(fixtures());
  if (match === null) throw new Error('demo-totp: SEED_PASSWORD not found in packages/db/src/fixtures.ts');
  return match[1];
}

function secretFor(role) {
  // Lines look like: [`${A}0000000d0003`]: 'BASE32...',
  const suffix = DEMO_USERS[role].userId.slice(-12);
  const match = new RegExp(`\\[\`\\$\\{[AB]\\}${suffix}\`\\]:\\s*'([A-Z2-7]+)'`).exec(fixtures());
  if (match === null) throw new Error('demo-totp: could not find that user in packages/db/src/fixtures.ts');
  return match[1];
}

function base32(text) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of text) bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** The 30-second step now. */
export function currentStep() {
  return Math.floor(Date.now() / 1000 / 30);
}

/** The six-digit code for `role` at `step` (RFC 6238, SHA-1). */
export function totpFor(role, step = currentStep()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', base32(secretFor(role))).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const role = process.argv[2] ?? 'admin';
  if (!Object.hasOwn(DEMO_USERS, role)) {
    console.error(`demo-totp: unknown role "${role}". One of: ${Object.keys(DEMO_USERS).join(', ')}`);
    process.exit(1);
  }
  const remaining = 30 - (Math.floor(Date.now() / 1000) % 30);
  console.log(`${totpFor(role)}  (valid for ${remaining}s more)`);
}
