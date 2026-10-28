import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PaymentMethodRef } from './contracts';

/**
 * Unit tripwire for the PCI rule: the type surface must not grow a PAN-like
 * field. The acceptance suite repeats this over the published package.
 */
const FORBIDDEN = /\b(pan|cardNumber|card_number|primaryAccountNumber|primary_account_number|fullPan|full_pan)\b/;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.endsWith('.test.ts')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.ts')) out.push(full);
  }
}

describe('PAN-free type surface', () => {
  it('PaymentMethodRef accepts only token and lastFour', () => {
    const ok = PaymentMethodRef.safeParse({ token: 'tok_x', lastFour: '4242' });
    expect(ok.success).toBe(true);

    const withPan = PaymentMethodRef.safeParse({
      token: 'tok_x',
      lastFour: '4242',
      pan: '4111111111111111',
    });
    expect(withPan.success, 'PaymentMethodRef must be .strict() and reject pan').toBe(false);

    const withCardNumber = PaymentMethodRef.safeParse({
      token: 'tok_x',
      lastFour: '4242',
      cardNumber: '4111111111111111',
    });
    expect(withCardNumber.success).toBe(false);
  });

  it('no source file in this package declares a PAN-like field name', () => {
    const files: string[] = [];
    walk(join(__dirname), files);
    expect(files.length).toBeGreaterThan(0);

    const hits: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, index) => {
        // Allow this file and comments that mention the ban.
        if (file.endsWith('pan-surface.test.ts')) return;
        if (/never|forbid|no pan|PAN-free|PAN never|no `pan`/i.test(line)) return;
        if (FORBIDDEN.test(line)) hits.push(`${file}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
