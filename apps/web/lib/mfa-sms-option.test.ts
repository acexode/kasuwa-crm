import { describe, expect, it } from 'vitest';
import {
  forgetSmsOption,
  recallSmsOption,
  rememberSmsOption,
  smsOptionHint,
  verifyPath,
  type SmsOptionStore,
} from './mfa-sms-option';

/**
 * `P01/2` — "Text a code to …" (T-0126).
 *
 * The hands-on test found every demo user reading "Text a code to" followed by
 * nothing. The rule below is what decides whether that button exists at all.
 */

const HINT = '+234 ••• ••• 0142';

type Method = Parameters<typeof smsOptionHint>[0][number];

function methods(sms: { available: boolean; deliveryHint: string | null } | undefined): Method[] {
  const totp: Method = { type: 'totp', available: true, deliveryHint: null };
  return sms === undefined ? [totp] : [totp, { type: 'sms', ...sms }];
}

class MemoryStore implements SmsOptionStore {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

class BrokenStore implements SmsOptionStore {
  getItem(): string | null {
    throw new Error('SecurityError');
  }
  setItem(): void {
    throw new Error('QuotaExceededError');
  }
  removeItem(): void {
    throw new Error('SecurityError');
  }
}

describe('smsOptionHint — offered only when SMS is available AND has a number', () => {
  it('hides it when unavailable with no number: what the live API sends today', () => {
    expect(smsOptionHint(methods({ available: false, deliveryHint: null }))).toBeNull();
  });

  it('hides it when available but no number is on file', () => {
    expect(smsOptionHint(methods({ available: true, deliveryHint: null }))).toBeNull();
  });

  it('hides it when a number is on file but SMS is not available', () => {
    expect(smsOptionHint(methods({ available: false, deliveryHint: HINT }))).toBeNull();
  });

  it('offers the masked number when both hold', () => {
    expect(smsOptionHint(methods({ available: true, deliveryHint: HINT }))).toBe(HINT);
  });

  it('hides it when the challenge has no sms entry at all', () => {
    expect(smsOptionHint(methods(undefined))).toBeNull();
  });

  it('treats a blank hint as no number — the "Text a code to" bug in another shape', () => {
    expect(smsOptionHint(methods({ available: true, deliveryHint: '' }))).toBeNull();
    expect(smsOptionHint(methods({ available: true, deliveryHint: '   ' }))).toBeNull();
  });

  it("does not borrow another method's hint", () => {
    const list: Method[] = [
      { type: 'totp', available: true, deliveryHint: HINT },
      { type: 'sms', available: true, deliveryHint: null },
    ];
    expect(smsOptionHint(list)).toBeNull();
  });
});

describe('remember / recall — the decision survives a reload of /verify', () => {
  it('round-trips the hint for the same challenge', () => {
    const store = new MemoryStore();
    rememberSmsOption(store, 'chl_1', HINT);
    expect(recallSmsOption(store, 'chl_1')).toBe(HINT);
  });

  it('is keyed by challenge: another challenge sees nothing', () => {
    const store = new MemoryStore();
    rememberSmsOption(store, 'chl_1', HINT);
    expect(recallSmsOption(store, 'chl_2')).toBeNull();
  });

  it('hides the option when nothing was remembered', () => {
    expect(recallSmsOption(new MemoryStore(), 'chl_1')).toBeNull();
  });

  it('a null decision removes an earlier offer rather than leaving the number behind', () => {
    const store = new MemoryStore();
    rememberSmsOption(store, 'chl_1', HINT);
    rememberSmsOption(store, 'chl_1', null);
    expect(recallSmsOption(store, 'chl_1')).toBeNull();
    expect(store.items.size).toBe(0);
  });

  it('forgets a spent challenge', () => {
    const store = new MemoryStore();
    rememberSmsOption(store, 'chl_1', HINT);
    forgetSmsOption(store, 'chl_1');
    expect(store.items.size).toBe(0);
  });

  it('hides the option on a corrupt or foreign entry instead of throwing', () => {
    const store = new MemoryStore();
    rememberSmsOption(store, 'chl_1', HINT);
    const [key] = [...store.items.keys()];
    for (const raw of ['not json', 'null', '"just a string"', '{}', '{"hint":42}', '{"hint":"  "}']) {
      store.items.set(String(key), raw);
      expect(recallSmsOption(store, 'chl_1')).toBeNull();
    }
  });

  it('treats no store, a throwing store and an empty challenge id as "hidden"', () => {
    expect(recallSmsOption(undefined, 'chl_1')).toBeNull();
    expect(() => rememberSmsOption(undefined, 'chl_1', HINT)).not.toThrow();

    const broken = new BrokenStore();
    expect(() => rememberSmsOption(broken, 'chl_1', HINT)).not.toThrow();
    expect(() => forgetSmsOption(broken, 'chl_1')).not.toThrow();
    expect(recallSmsOption(broken, 'chl_1')).toBeNull();

    const store = new MemoryStore();
    rememberSmsOption(store, '', HINT);
    expect(store.items.size).toBe(0);
    expect(recallSmsOption(store, '')).toBeNull();
  });
});

describe('verifyPath — the masked number never enters the URL', () => {
  it('carries the challenge id and nothing else', () => {
    const path = verifyPath('chl_1');
    expect(path).toBe('/verify?challenge=chl_1');
    expect(path).not.toContain('0142');
    expect(new URL(path, 'https://kasuwa.test').searchParams.size).toBe(1);
  });

  it('encodes the challenge id', () => {
    expect(verifyPath('a&hint=x')).toBe('/verify?challenge=a%26hint%3Dx');
  });
});
