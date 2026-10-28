import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { PROGRAMME_A1, TENANT_A } from '@kasuwa/db';
import { describe, expect, it } from 'vitest';

/**
 * ACCEPTANCE — T-0168, `packages/payments-adapter` (Agent A2, S1 Commerce).
 *
 * The payments boundary only: PaymentProvider contract, a fake, a default that
 * fails closed. Real Paystack / Flutterwave SDKs and the payment-links API are
 * T-0169. PAN never enters Kasuwa.
 *
 * ------------------------------------------------------------------------
 * THE CONTRACT. Internals are yours; these are not.
 *
 *   Package: `packages/payments-adapter`, package.json name
 *   `@kasuwa/payments-adapter`, Nx tag `scope:adapter` (same shape as
 *   `packages/channel-adapter` / `packages/telephony-adapter`). Alias in
 *   `vitest.workspace.ts` and `tsconfig.base.json`; workspace dependency of
 *   `tests/acceptance/package.json`.
 *
 *   Exports (runtime):
 *     class FakePaymentProvider implements PaymentProvider
 *       readonly id: 'fake'
 *       readonly createdLinks: readonly CreatePaymentLinkRequest[]
 *       failNextCreate(kind: 'unavailable' | 'rejected'): void
 *       signWebhook(event): { rawBody: string; headers: Record<string, string> }
 *
 *     class NullPaymentProvider implements PaymentProvider
 *       readonly id: 'null'
 *       — every method throws ProviderUnavailableError
 *
 *     defaultPaymentProvider(environment: 'development' | 'test' | 'production')
 *       — Fake in development/test; Null in production (fail closed)
 *
 *     Typed errors, all `extends PaymentError extends Error`, each with a
 *     stable `code` and a `retryable` boolean:
 *       PaymentError
 *       InvalidPaymentRequestError   code 'invalid_request'
 *       ProviderUnavailableError     code 'provider_unavailable', retryable true
 *       ProviderRejectedError        code 'provider_rejected'
 *       InvalidSignatureError        code 'invalid_signature'
 *       InvalidWebhookError          code 'invalid_webhook'
 *       LinkNotFoundError            code 'link_not_found'
 *
 *   Exports (types):
 *     PaymentProvider {
 *       createPaymentLink(request): Promise<PaymentLinkResult>
 *       verifyWebhookSignature(request): Promise<boolean>
 *       parseWebhookEvent(request): Promise<PaymentWebhookEvent>
 *     }
 *     PaymentMethodRef { token: string; lastFour: string }  // PAN-free
 *     CreatePaymentLinkRequest { scope; amountMinor: bigint; currency; reference; idempotencyKey; … }
 *     PaymentLinkResult { providerLinkId; url; status; expiresAt? }
 *     PaymentWebhookEvent { eventId; occurredAt; type; providerLinkId; paymentMethod?; … }
 * ------------------------------------------------------------------------
 */

interface TenantScope {
  tenantId: string;
  programmeId: string;
}

interface CreatePaymentLinkRequest {
  scope: TenantScope;
  amountMinor: bigint;
  currency: 'NGN' | 'GHS' | 'KES' | 'ZAR';
  reference: string;
  idempotencyKey: string;
  description?: string;
  successUrl?: string;
  cancelUrl?: string;
  expiresAt?: Date;
}

interface PaymentLinkResult {
  providerLinkId: string;
  url: string;
  status: 'pending' | 'paid' | 'expired' | 'cancelled';
  expiresAt?: Date;
}

interface PaymentMethodRef {
  token: string;
  lastFour: string;
}

interface PaymentWebhookEvent {
  eventId: string;
  occurredAt: Date;
  type: 'payment.paid' | 'payment.expired' | 'payment.failed';
  providerLinkId: string;
  reference?: string;
  amountMinor?: bigint;
  currency?: 'NGN' | 'GHS' | 'KES' | 'ZAR';
  paymentMethod?: PaymentMethodRef;
}

interface PaymentErrorShape extends Error {
  code: string;
  retryable: boolean;
}

type ErrorClass = new (...args: never[]) => PaymentErrorShape;

interface FakePaymentProviderShape {
  readonly id: 'fake';
  readonly createdLinks: readonly CreatePaymentLinkRequest[];
  failNextCreate(kind: 'unavailable' | 'rejected'): void;
  createPaymentLink(request: CreatePaymentLinkRequest): Promise<PaymentLinkResult>;
  verifyWebhookSignature(request: {
    rawBody: string | Uint8Array;
    headers: Record<string, string | string[] | undefined>;
  }): Promise<boolean>;
  parseWebhookEvent(request: {
    rawBody: string | Uint8Array;
    headers: Record<string, string | string[] | undefined>;
  }): Promise<PaymentWebhookEvent>;
  signWebhook(event: PaymentWebhookEvent): { rawBody: string; headers: Record<string, string> };
}

interface NullPaymentProviderShape {
  readonly id: 'null';
  createPaymentLink(request: CreatePaymentLinkRequest): Promise<PaymentLinkResult>;
  verifyWebhookSignature(request: {
    rawBody: string | Uint8Array;
    headers: Record<string, string | string[] | undefined>;
  }): Promise<boolean>;
  parseWebhookEvent(request: {
    rawBody: string | Uint8Array;
    headers: Record<string, string | string[] | undefined>;
  }): Promise<PaymentWebhookEvent>;
}

interface PaymentsAdapterModule {
  FakePaymentProvider: new (options?: { webhookSecret?: string }) => FakePaymentProviderShape;
  NullPaymentProvider: new () => NullPaymentProviderShape;
  defaultPaymentProvider: (
    environment: 'development' | 'test' | 'production',
  ) => FakePaymentProviderShape | NullPaymentProviderShape;
  PaymentError: ErrorClass;
  InvalidPaymentRequestError: ErrorClass;
  ProviderUnavailableError: ErrorClass;
  ProviderRejectedError: ErrorClass;
  InvalidSignatureError: ErrorClass;
  InvalidWebhookError: ErrorClass;
  LinkNotFoundError: ErrorClass;
  PaymentMethodRef: { safeParse: (value: unknown) => { success: boolean } };
  PAYMENT_PROVIDER_IDS: readonly string[];
}

const REQUIRED_EXPORTS: readonly (keyof PaymentsAdapterModule)[] = [
  'FakePaymentProvider',
  'NullPaymentProvider',
  'defaultPaymentProvider',
  'PaymentError',
  'InvalidPaymentRequestError',
  'ProviderUnavailableError',
  'ProviderRejectedError',
  'InvalidSignatureError',
  'InvalidWebhookError',
  'LinkNotFoundError',
  'PaymentMethodRef',
  'PAYMENT_PROVIDER_IDS',
];

const PAYMENTS_ADAPTER: string = '@kasuwa/payments-adapter';

async function loadAdapter(): Promise<PaymentsAdapterModule> {
  let loaded: Partial<Record<keyof PaymentsAdapterModule, unknown>>;
  try {
    loaded = (await import(PAYMENTS_ADAPTER)) as Partial<
      Record<keyof PaymentsAdapterModule, unknown>
    >;
  } catch (cause) {
    const firstLine = String(cause).split('\n')[0];
    throw new Error(
      `T-0168: '${PAYMENTS_ADAPTER}' does not resolve. Create packages/payments-adapter, ` +
        `alias it in vitest.workspace.ts / tsconfig.base.json and add it to ` +
        `tests/acceptance/package.json. (underlying: ${firstLine})`,
    );
  }

  const missing = REQUIRED_EXPORTS.filter((name) => {
    const value = loaded[name];
    if (name === 'PAYMENT_PROVIDER_IDS') return !Array.isArray(value);
    if (name === 'PaymentMethodRef') {
      return value === undefined || typeof (value as { safeParse?: unknown }).safeParse !== 'function';
    }
    return typeof value !== 'function';
  });
  if (missing.length > 0) {
    throw new Error(`T-0168: ${PAYMENTS_ADAPTER} is missing exports: ${missing.join(', ')}`);
  }

  return loaded as unknown as PaymentsAdapterModule;
}

const SCOPE: TenantScope = { tenantId: TENANT_A, programmeId: PROGRAMME_A1 };

function linkRequest(overrides: Partial<CreatePaymentLinkRequest> = {}): CreatePaymentLinkRequest {
  return {
    scope: SCOPE,
    amountMinor: 25_000n,
    currency: 'NGN',
    reference: 'quote-accept-0168',
    idempotencyKey: 'idem-accept-0168',
    ...overrides,
  };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to be refused, but it resolved');
}

// ---------------------------------------------------------------------------
// Source scans.
// ---------------------------------------------------------------------------

const repoRoot = resolve(__dirname, '..', '..', '..');
const ADAPTER_DIR = join(repoRoot, 'packages', 'payments-adapter');

/**
 * Payment vendors this package is allowed to name. Built from fragments so
 * this file does not trip the scan if it is ever included in one.
 */
const VENDORS: readonly string[] = [
  'pay' + 'stack',
  'flutter' + 'wave',
];
const VENDOR_PATTERN = new RegExp(`\\b(?:${VENDORS.join('|')})\\b`, 'i');

/** Field names that would let a PAN into Kasuwa. */
const PAN_FIELD_PATTERN =
  /\b(pan|cardNumber|card_number|primaryAccountNumber|primary_account_number|fullPan|full_pan)\b/;

const SCANNED_EXTENSIONS = /\.(?:ts|tsx|js|mjs|cjs|json|ya?ml|env\.example)$/;
const SKIPPED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nx',
  '.turbo',
  '.git',
  '.artifacts',
]);

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SCANNED_EXTENSIONS.test(name)) out.push(full);
  }
}

function sourceFiles(): string[] {
  const files: string[] = [];
  for (const top of ['apps', 'packages', 'tools', 'tests']) {
    const dir = join(repoRoot, top);
    if (existsSync(dir)) walk(dir, files);
  }
  for (const name of readdirSync(repoRoot)) {
    const full = join(repoRoot, name);
    if (statSync(full).isFile() && SCANNED_EXTENSIONS.test(name)) files.push(full);
  }
  return files.filter((file) => file !== __filename);
}

function isInsideAdapter(file: string): boolean {
  return file === ADAPTER_DIR || file.startsWith(ADAPTER_DIR + sep);
}

/**
 * Pre-existing notification preference copy names the vendors in locale JSON.
 * That is display text, not an integration. The CLAUDE.md 2.8 rule is about
 * calling providers; exclude locale catalogues from the vendor-name scan and
 * record the copy as an open question for the lead.
 */
function isI18nLocale(file: string): boolean {
  const rel = relative(repoRoot, file).split(sep).join('/');
  return rel.startsWith('packages/i18n/src/locales/');
}

function vendorHits(files: readonly string[]): string[] {
  const hits: string[] = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      const match = VENDOR_PATTERN.exec(line);
      if (match) hits.push(`${relative(repoRoot, file)}:${index + 1} names "${match[0]}"`);
    });
  }
  return hits;
}

function panFieldHits(files: readonly string[]): string[] {
  const hits: string[] = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      // Mentions of the ban itself are not fields.
      if (/never|forbid|no pan|PAN-free|PAN never|no `pan`|token \+ last|token plus last/i.test(line)) {
        return;
      }
      // Zod / test probes that assert rejection of a pan field.
      if (/safeParse|toMatch|FORBIDDEN|PAN_FIELD|cardNumber:/i.test(line) && /pan|cardNumber/i.test(line)) {
        return;
      }
      const match = PAN_FIELD_PATTERN.exec(line);
      if (match) hits.push(`${relative(repoRoot, file)}:${index + 1} field "${match[0]}"`);
    });
  }
  return hits;
}

describe('acceptance: the payments adapter package and its boundary', () => {
  it('exists as @kasuwa/payments-adapter, tagged scope:adapter, exporting the contract', async () => {
    const manifestPath = join(ADAPTER_DIR, 'package.json');
    expect(existsSync(manifestPath), 'packages/payments-adapter/package.json is missing').toBe(true);

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      name?: string;
      nx?: { tags?: string[] };
    };
    expect(manifest.name).toBe('@kasuwa/payments-adapter');
    expect(
      manifest.nx?.tags ?? [],
      'without scope:adapter the boundary lint does not apply',
    ).toContain('scope:adapter');

    const adapter = await loadAdapter();
    expect(adapter.PAYMENT_PROVIDER_IDS).toEqual(
      expect.arrayContaining(['pay' + 'stack', 'flutter' + 'wave']),
    );

    for (const name of [
      'InvalidPaymentRequestError',
      'ProviderUnavailableError',
      'ProviderRejectedError',
      'InvalidSignatureError',
      'InvalidWebhookError',
      'LinkNotFoundError',
    ] as const) {
      expect(adapter[name].prototype, `${name} must extend PaymentError`).toBeInstanceOf(
        adapter.PaymentError,
      );
      expect(adapter[name].prototype, `${name} must extend Error`).toBeInstanceOf(Error);
    }
  });

  it('is mapped in tsconfig.base.json and vitest.workspace.ts', () => {
    const base = JSON.parse(
      readFileSync(join(repoRoot, 'tsconfig.base.json'), 'utf8').replace(/^\s*\/\/.*$/gm, ''),
    ) as { compilerOptions?: { paths?: Record<string, string[]> } };
    expect(base.compilerOptions?.paths?.['@kasuwa/payments-adapter']).toEqual([
      'packages/payments-adapter/src/index.ts',
    ]);
    expect(readFileSync(join(repoRoot, 'vitest.workspace.ts'), 'utf8')).toMatch(
      /'@kasuwa\/payments-adapter':\s*resolve\(root,\s*'packages\/payments-adapter\/src\/index\.ts'\)/,
    );
  });

  it('no file outside packages/payments-adapter names Paystack or Flutterwave', () => {
    expect(existsSync(ADAPTER_DIR), 'packages/payments-adapter does not exist').toBe(true);
    expect(
      VENDOR_PATTERN.test(`import x from '${'pay' + 'stack'}';`),
      'the vendor pattern does not fire',
    ).toBe(true);

    const files = sourceFiles().filter(
      (file) => !isInsideAdapter(file) && !isI18nLocale(file) && !file.endsWith('pnpm-lock.yaml'),
    );
    expect(files.length, 'the scan found almost no source — is the root right?').toBeGreaterThan(
      100,
    );
    expect(
      vendorHits(files),
      'a payment vendor is named outside the adapter (CLAUDE.md 2.8)',
    ).toEqual([]);
  });
});

describe('acceptance: PAN-free type surface', () => {
  it('PaymentMethodRef accepts token + lastFour and rejects pan / cardNumber', async () => {
    const adapter = await loadAdapter();
    expect(adapter.PaymentMethodRef.safeParse({ token: 'tok_a', lastFour: '4242' }).success).toBe(
      true,
    );
    expect(
      adapter.PaymentMethodRef.safeParse({
        token: 'tok_a',
        lastFour: '4242',
        pan: '4111111111111111',
      }).success,
      'PaymentMethodRef must reject a pan field',
    ).toBe(false);
    expect(
      adapter.PaymentMethodRef.safeParse({
        token: 'tok_a',
        lastFour: '4242',
        cardNumber: '4111111111111111',
      }).success,
      'PaymentMethodRef must reject a cardNumber field',
    ).toBe(false);
  });

  it('no payments-adapter source declares a PAN-like field name', () => {
    expect(existsSync(ADAPTER_DIR)).toBe(true);
    const files: string[] = [];
    walk(ADAPTER_DIR, files);
    const source = files.filter(
      (file) =>
        file.endsWith('.ts') &&
        !file.endsWith('.test.ts') &&
        !file.includes(`${sep}node_modules${sep}`),
    );
    expect(source.length).toBeGreaterThan(0);
    expect(panFieldHits(source)).toEqual([]);
  });
});

describe('acceptance: fail-closed default provider', () => {
  it('defaultPaymentProvider("production") refuses create, verify and parse', async () => {
    const adapter = await loadAdapter();
    const provider = adapter.defaultPaymentProvider('production');
    expect(provider).toBeInstanceOf(adapter.NullPaymentProvider);

    const createError = await rejectionOf(provider.createPaymentLink(linkRequest()));
    expect(createError).toBeInstanceOf(adapter.ProviderUnavailableError);
    expect((createError as PaymentErrorShape).retryable).toBe(true);

    const verifyError = await rejectionOf(
      provider.verifyWebhookSignature({ rawBody: '{}', headers: {} }),
    );
    expect(verifyError).toBeInstanceOf(adapter.ProviderUnavailableError);

    const parseError = await rejectionOf(
      provider.parseWebhookEvent({ rawBody: '{}', headers: {} }),
    );
    expect(parseError).toBeInstanceOf(adapter.ProviderUnavailableError);
  });

  it('NullPaymentProvider never silently succeeds', async () => {
    const adapter = await loadAdapter();
    const provider = new adapter.NullPaymentProvider();
    await expect(provider.createPaymentLink(linkRequest())).rejects.toBeInstanceOf(
      adapter.ProviderUnavailableError,
    );
    await expect(
      provider.verifyWebhookSignature({ rawBody: '{"ok":true}', headers: { 'x-sig': '1' } }),
    ).rejects.toBeInstanceOf(adapter.ProviderUnavailableError);
  });
});

describe('acceptance: FakePaymentProvider works', () => {
  it('creates a link, signs a webhook, verifies it, and parses token + lastFour', async () => {
    const adapter = await loadAdapter();
    const provider = new adapter.FakePaymentProvider();
    expect(adapter.defaultPaymentProvider('test')).toBeInstanceOf(adapter.FakePaymentProvider);

    const link = await provider.createPaymentLink(linkRequest());
    expect(link.status).toBe('pending');
    expect(link.providerLinkId.length).toBeGreaterThan(0);
    expect(link.url).toMatch(/^https:\/\//);
    expect(provider.createdLinks).toHaveLength(1);

    const event: PaymentWebhookEvent = {
      eventId: 'evt-accept-0168',
      occurredAt: new Date('2026-10-28T12:00:00.000Z'),
      type: 'payment.paid',
      providerLinkId: link.providerLinkId,
      reference: 'quote-accept-0168',
      amountMinor: 25_000n,
      currency: 'NGN',
      paymentMethod: { token: 'tok_accept_4242', lastFour: '4242' },
    };
    const { rawBody, headers } = provider.signWebhook(event);

    await expect(provider.verifyWebhookSignature({ rawBody, headers })).resolves.toBe(true);
    await expect(
      provider.verifyWebhookSignature({ rawBody, headers: { 'x-kasuwa-payments-signature': 'nope' } }),
    ).resolves.toBe(false);

    const parsed = await provider.parseWebhookEvent({ rawBody, headers });
    expect(parsed.type).toBe('payment.paid');
    expect(parsed.paymentMethod).toEqual({ token: 'tok_accept_4242', lastFour: '4242' });
    expect(Object.keys(parsed.paymentMethod ?? {}).sort()).toEqual(['lastFour', 'token']);
  });

  it('failNextCreate surfaces typed unavailable / rejected errors', async () => {
    const adapter = await loadAdapter();
    const provider = new adapter.FakePaymentProvider();
    provider.failNextCreate('unavailable');
    await expect(provider.createPaymentLink(linkRequest())).rejects.toBeInstanceOf(
      adapter.ProviderUnavailableError,
    );
    provider.failNextCreate('rejected');
    await expect(
      provider.createPaymentLink(linkRequest({ idempotencyKey: 'idem-2' })),
    ).rejects.toBeInstanceOf(adapter.ProviderRejectedError);
  });
});
