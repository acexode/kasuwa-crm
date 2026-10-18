#!/usr/bin/env node
/**
 * DEMO ONLY: prints the current six-digit TOTP code for a seeded user, so the
 * presenter can sign in for real (P01/1 then P01/2) without an authenticator
 * app.
 *
 * The secrets are the committed development fixtures in
 * packages/db/src/fixtures.ts, read from that file at run time rather than
 * copied here. They only exist in a database `pnpm db:seed` wrote, and the seed
 * refuses anything but localhost.
 *
 *   node tools/demo-totp.mjs admin      # Musa Bello, tenant admin
 *   node tools/demo-totp.mjs agent      # Tunde Adeyemi, agent
 *
 * Roles: admin, agent, agent2, unassigned, tenantb (the same names as the demo
 * proxy's switcher).
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const USERS = {
  admin: '11111111-0000-4000-8000-0000000d0003',
  agent: '11111111-0000-4000-8000-0000000d0001',
  agent2: '11111111-0000-4000-8000-0000000d0002',
  unassigned: '11111111-0000-4000-8000-0000000d0004',
  tenantb: '22222222-0000-4000-8000-0000000d0005',
};

const role = process.argv[2] ?? 'admin';
if (!Object.hasOwn(USERS, role)) {
  console.error(`demo-totp: unknown role "${role}". One of: ${Object.keys(USERS).join(', ')}`);
  process.exit(1);
}

const fixtures = readFileSync(
  join(resolve(import.meta.dirname, '..'), 'packages', 'db', 'src', 'fixtures.ts'),
  'utf8',
);
// Lines look like: [`${A}0000000d0003`]: 'BASE32...',
const suffix = USERS[role].slice(-12);
const match = new RegExp(`\\[\`\\$\\{[AB]\\}${suffix}\`\\]:\\s*'([A-Z2-7]+)'`).exec(fixtures);
if (match === null) {
  console.error('demo-totp: could not find that user in packages/db/src/fixtures.ts');
  process.exit(1);
}

function base32(text) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of text) bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8)
    bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

const step = Math.floor(Date.now() / 1000 / 30);
const counter = Buffer.alloc(8);
counter.writeBigUInt64BE(BigInt(step));
const hmac = createHmac('sha1', base32(match[1])).update(counter).digest();
const offset = hmac[hmac.length - 1] & 0x0f;
const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
const remaining = 30 - (Math.floor(Date.now() / 1000) % 30);
console.log(`${String(code).padStart(6, '0')}  (valid for ${remaining}s more)`);
