import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { inspect } from 'node:util';
import { PROGRAMME_A1, PROGRAMME_B1, TENANT_A, TENANT_B } from '@kasuwa/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * ACCEPTANCE — T-0017, the channel provider interface (Agent 5, Messaging).
 *
 * Two P0 flows (T-0016 sign-up OTP, T-0012 MFA recovery) need SOMETHING to
 * send a message through. This task is the interface plus a fake provider.
 * Which real vendor sits behind it is an open decision (spend and a contract,
 * so @acexode's), and nothing here may pre-empt it.
 *
 * ------------------------------------------------------------------------
 * THE CONTRACT. Internals are yours; these are not.
 *
 *   Package: `packages/channel-adapter`, package.json name
 *   `@kasuwa/channel-adapter`, Nx tag `scope:adapter` (same shape as
 *   `packages/telephony-adapter`). Register it as an alias in
 *   `vitest.workspace.ts` and as a workspace dependency of
 *   `tests/acceptance/package.json` so this file can resolve it.
 *
 *   Exports (runtime values):
 *     createChannelAdapter(options: {
 *       provider: ChannelProvider;      // any provider, real or fake
 *       dnd: DndRegister;
 *       logger?: ChannelLogger;
 *     }): ChannelProvider
 *       The compliance boundary. Validates the request (Zod), checks DND for
 *       promotional traffic, calls the provider, and turns whatever the
 *       provider throws into a typed ChannelError. The DND check lives HERE,
 *       not in a provider, so every provider gets it.
 *
 *     class FakeChannelProvider implements ChannelProvider
 *       readonly sent: readonly SendRequest[]    what reached the provider
 *       failNextSend(kind: 'unavailable' | 'rejected'): void
 *       setDeliveryState(messageId: string, state: DeliveryState): void
 *
 *     class FakeDndRegister implements DndRegister
 *       constructor(registered: Iterable<string>)   E.164 numbers
 *
 *     Typed errors, all `extends ChannelError extends Error`, each with a
 *     stable `code` and a `retryable` boolean:
 *       ChannelError               base class
 *       DndRefusedError            code 'dnd_refused',          retryable false
 *       InvalidSendRequestError    code 'invalid_request',      retryable false
 *       ProviderUnavailableError   code 'provider_unavailable', retryable true
 *       ProviderRejectedError      code 'provider_rejected',    retryable false
 *       MessageNotFoundError       code 'message_not_found',    retryable false
 *
 *   Exports (types), mirrored locally below so this file typechecks before
 *   the package exists:
 *     type MessagePurpose = 'transactional' | 'promotional'
 *     type ChannelKind    = 'sms' | 'whatsapp'
 *     type DeliveryState  = 'queued' | 'sent' | 'delivered' | 'failed'
 *     interface TenantScope   { tenantId: string; programmeId: string }
 *     interface SendRequest   { scope; channel; to; body; purpose; idempotencyKey }
 *     interface SendResult    { messageId: string; state: DeliveryState }
 *     interface DeliveryStatus{ messageId: string; state: DeliveryState; updatedAt: Date }
 *     interface ChannelProvider {
 *       send(request: SendRequest): Promise<SendResult>;
 *       getDeliveryStatus(scope: TenantScope, messageId: string): Promise<DeliveryStatus>;
 *       capabilities(): { channels; templates; webhooks };
 *       templates(scope): Promise<readonly unknown[]>;
 *       parseWebhook(rawBody): Promise<unknown>;
 *     }
 *     interface DndRegister   { isRegistered(e164: string): Promise<boolean> }
 *     interface ChannelLogger { debug|info|warn|error(message: string, fields?: Record<string, unknown>): void }
 *
 *   `purpose` is REQUIRED and has no default. Whether a message is
 *   promotional is the caller's explicit statement, never inferred from the
 *   body, because the second caller will be a campaign and "it looked
 *   transactional" is not a defence to the NCC.
 * ------------------------------------------------------------------------
 *
 * The module is loaded by package name through a non-literal specifier, so
 * this file typechecks today and fails at runtime with a readable message.
 * The builder may replace `loadAdapter()` with a static import once the
 * package exists — the assertions must not change.
 */

// ---------------------------------------------------------------------------
// The contract, mirrored as local types.
// ---------------------------------------------------------------------------

type MessagePurpose = 'transactional' | 'promotional';
type ChannelKind = 'sms' | 'whatsapp';
type DeliveryState = 'queued' | 'sent' | 'delivered' | 'failed';

interface TenantScope {
  tenantId: string;
  programmeId: string;
}

interface SendRequest {
  scope: TenantScope;
  channel: ChannelKind;
  to: string;
  body: string;
  purpose: MessagePurpose;
  /** T-0186 / D-L37: required so retries cannot double-deliver. */
  idempotencyKey: string;
}

interface SendResult {
  messageId: string;
  state: DeliveryState;
}

interface DeliveryStatus {
  messageId: string;
  state: DeliveryState;
  updatedAt: Date;
}

interface ChannelCapabilities {
  channels: readonly ChannelKind[];
  templates: boolean;
  webhooks: boolean;
}

interface ChannelProvider {
  send(request: SendRequest): Promise<SendResult>;
  getDeliveryStatus(scope: TenantScope, messageId: string): Promise<DeliveryStatus>;
  capabilities(): ChannelCapabilities;
  templates(scope: TenantScope): Promise<readonly unknown[]>;
  parseWebhook(rawBody: string | Uint8Array): Promise<unknown>;
}

interface DndRegister {
  isRegistered(e164: string): Promise<boolean>;
}

type LogFn = (message: string, fields?: Record<string, unknown>) => void;
interface ChannelLogger {
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
}

interface ChannelErrorShape extends Error {
  code: string;
  retryable: boolean;
}

type ErrorClass = new (...args: never[]) => ChannelErrorShape;

interface FakeChannelProviderShape extends ChannelProvider {
  readonly sent: readonly SendRequest[];
  failNextSend(kind: 'unavailable' | 'rejected'): void;
  setDeliveryState(messageId: string, state: DeliveryState): void;
}

interface ChannelAdapterModule {
  createChannelAdapter(options: {
    provider: ChannelProvider;
    dnd: DndRegister;
    logger?: ChannelLogger;
  }): ChannelProvider;
  FakeChannelProvider: new () => FakeChannelProviderShape;
  FakeDndRegister: new (registered: Iterable<string>) => DndRegister;
  ChannelError: ErrorClass;
  DndRefusedError: ErrorClass;
  InvalidSendRequestError: ErrorClass;
  ProviderUnavailableError: ErrorClass;
  ProviderRejectedError: ErrorClass;
  MessageNotFoundError: ErrorClass;
}

const REQUIRED_EXPORTS: readonly (keyof ChannelAdapterModule)[] = [
  'createChannelAdapter',
  'FakeChannelProvider',
  'FakeDndRegister',
  'ChannelError',
  'DndRefusedError',
  'InvalidSendRequestError',
  'ProviderUnavailableError',
  'ProviderRejectedError',
  'MessageNotFoundError',
];

// Typed as `string`, not as the literal, so tsc does not try to resolve a
// package that does not exist yet.
const CHANNEL_ADAPTER: string = '@kasuwa/channel-adapter';

async function loadAdapter(): Promise<ChannelAdapterModule> {
  let loaded: Partial<Record<keyof ChannelAdapterModule, unknown>>;
  try {
    loaded = (await import(CHANNEL_ADAPTER)) as Partial<
      Record<keyof ChannelAdapterModule, unknown>
    >;
  } catch (cause) {
    const firstLine = String(cause).split('\n')[0];
    throw new Error(
      `T-0017: '${CHANNEL_ADAPTER}' does not resolve. Create packages/channel-adapter, ` +
        `alias it in vitest.workspace.ts and add it to tests/acceptance/package.json. ` +
        `(underlying: ${firstLine})`,
    );
  }

  const missing = REQUIRED_EXPORTS.filter((name) => typeof loaded[name] !== 'function');
  if (missing.length > 0) {
    throw new Error(`T-0017: ${CHANNEL_ADAPTER} is missing exports: ${missing.join(', ')}`);
  }

  return loaded as unknown as ChannelAdapterModule;
}

// ---------------------------------------------------------------------------
// Fixtures. Scopes come from the seed; phone numbers are invented and cannot
// occur by chance. `CLAUDE.md` section 6 forbids real identifiers here.
// ---------------------------------------------------------------------------

const SCOPE_A: TenantScope = { tenantId: TENANT_A, programmeId: PROGRAMME_A1 };
const SCOPE_B: TenantScope = { tenantId: TENANT_B, programmeId: PROGRAMME_B1 };

/** On the DND register. */
const DND_NUMBER = '+2348090000101';
/** Not on the DND register. */
const CLEAR_NUMBER = '+2348090000202';

/**
 * A deliberately PII-heavy send: a destination number and an OTP body, which
 * `CLAUDE.md` 6.1 treats as PII and a credential respectively. Each probe is
 * a form the value could leak in — a redactor that strips the `+` or only
 * masks E.164 is exactly what this is built to catch.
 */
const PII_TO = '+2348097770313';
const PII_BODY = 'Your Kasuwa code is QZ7-PIIPROBE-K4W. Adaeze Okonkwo-PiiProbe, do not share it.';
const PII_PROBES: Record<string, string> = {
  'destination (E.164)': PII_TO,
  'destination (no plus)': PII_TO.slice(1),
  'destination (national format)': `0${PII_TO.slice(4)}`,
  'message body': PII_BODY,
  'OTP in the body': 'QZ7-PIIPROBE-K4W',
  'name in the body': 'Adaeze Okonkwo-PiiProbe',
};

let sendIdemCounter = 0;

function sendRequest(overrides: Partial<SendRequest> = {}): SendRequest {
  sendIdemCounter += 1;
  return {
    scope: SCOPE_A,
    channel: 'sms',
    to: CLEAR_NUMBER,
    body: 'Your appointment is confirmed.',
    purpose: 'transactional',
    // T-0186: send requires idempotencyKey (D-L37). Unique per call so the
    // fake's idempotency map does not collapse unrelated acceptance probes.
    idempotencyKey: `unit-idem-accept-channel-${String(sendIdemCounter)}`,
    ...overrides,
  };
}

/** A provider written here, not by the builder, so the DND check is proven to sit in front of ANY provider. */
function countingProvider(): ChannelProvider & { sends: SendRequest[] } {
  const sends: SendRequest[] = [];
  return {
    sends,
    send: async (request) => {
      sends.push(request);
      return { messageId: `stub-${sends.length}`, state: 'queued' };
    },
    getDeliveryStatus: async (_scope, messageId) => ({
      messageId,
      state: 'queued',
      updatedAt: new Date(),
    }),
    capabilities: () => ({ channels: ['sms'], templates: false, webhooks: false }),
    templates: async () => [],
    parseWebhook: async () => {
      throw new Error('countingProvider does not parse webhooks');
    },
  };
}

// ---------------------------------------------------------------------------
// Capture of everything the process could emit: an injected logger, every
// console method, and raw stdout/stderr writes.
// ---------------------------------------------------------------------------

interface Captured {
  logs: { level: string; message: string; fields?: Record<string, unknown> }[];
  stray: unknown[][];
}

function capturingLogger(sink: Captured['logs']): ChannelLogger {
  const at =
    (level: string): LogFn =>
    (message, fields) => {
      sink.push(fields === undefined ? { level, message } : { level, message, fields });
    };
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

function captureStray(): Captured['stray'] {
  const stray: unknown[][] = [];
  const record = (...args: unknown[]) => {
    stray.push(args);
  };
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
    vi.spyOn(console, method).mockImplementation(record);
  }
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream) as (...args: unknown[]) => boolean;
    vi.spyOn(stream, 'write').mockImplementation((...args: unknown[]) => {
      stray.push(args);
      return original(...args);
    });
  }
  return stray;
}

/** Everything an error carries, including non-enumerable fields and its cause chain. */
function describeError(error: unknown): string {
  const parts: string[] = [inspect(error, { depth: 10, showHidden: true })];
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current != null; depth += 1) {
    if (current instanceof Error) {
      parts.push(String(current), current.message, current.stack ?? '');
      for (const key of Object.getOwnPropertyNames(current)) {
        parts.push(inspect((current as unknown as Record<string, unknown>)[key], { depth: 10 }));
      }
      current = (current as Error & { cause?: unknown }).cause;
    } else {
      parts.push(inspect(current, { depth: 10 }));
      break;
    }
  }
  try {
    parts.push(JSON.stringify(error));
  } catch {
    // Unserialisable is fine; inspect() above already saw it.
  }
  return parts.join('\n');
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to be refused, but it resolved');
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Source scans.
// ---------------------------------------------------------------------------

const repoRoot = resolve(__dirname, '..', '..', '..');
const ADAPTER_DIR = join(repoRoot, 'packages', 'channel-adapter');

/**
 * Messaging vendors plausible for this market. Incomplete by nature — a list
 * cannot be — so it is a tripwire for the common case, not a proof. Built
 * from fragments so this file does not trip its own scan if it is ever
 * included in one.
 */
const VENDORS: readonly string[] = [
  'twil' + 'io',
  'term' + 'ii',
  'info' + 'bip',
  'africas' + 'talking',
  "africa'?s[ _-]?" + 'talking',
  '360' + 'dialog',
  'gup' + 'shup',
  'von' + 'age',
  'nex' + 'mo',
  'message' + 'bird',
  'sin' + 'ch',
  'kal' + 'eyra',
  'clicka' + 'tell',
  'pli' + 'vo',
  'rou' + 'tee',
  'hub' + 'tel',
  'arke' + 'sel',
  'mno' + 'tify',
  'send' + 'champ',
  'multi' + 'texter',
  'ebulk' + 'sms',
  'bulksms' + 'nigeria',
  'smartsms' + 'solutions',
  'tele' + 'sign',
  'esen' + 'dex',
  'text' + 'local',
  'd7' + 'networks',
  'client-' + 'pinpoint',
  'graph\\.face' + 'book\\.com',
  'bail' + 'eys',
];
const VENDOR_PATTERN = new RegExp(`\\b(?:${VENDORS.join('|')})\\b`, 'i');

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

/** Source and config Kasuwa ships or builds with: apps, packages, tools, tests, root config. */
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
  // This file names the vendors in order to forbid them.
  return files.filter((file) => file !== __filename);
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

function isInsideAdapter(file: string): boolean {
  return file === ADAPTER_DIR || file.startsWith(ADAPTER_DIR + sep);
}

describe('acceptance: the channel adapter is the only place a provider is named', () => {
  it('exists as @kasuwa/channel-adapter, tagged scope:adapter, exporting the contract', async () => {
    const manifestPath = join(ADAPTER_DIR, 'package.json');
    expect(existsSync(manifestPath), 'packages/channel-adapter/package.json is missing').toBe(true);

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      name?: string;
      nx?: { tags?: string[] };
    };
    expect(manifest.name).toBe('@kasuwa/channel-adapter');
    expect(
      manifest.nx?.tags ?? [],
      'without scope:adapter the boundary lint does not apply',
    ).toContain('scope:adapter');

    const adapter = await loadAdapter();

    // The error classes form one hierarchy a caller can catch once.
    for (const name of [
      'DndRefusedError',
      'InvalidSendRequestError',
      'ProviderUnavailableError',
      'ProviderRejectedError',
      'MessageNotFoundError',
    ] as const) {
      expect(adapter[name].prototype, `${name} must extend ChannelError`).toBeInstanceOf(
        adapter.ChannelError,
      );
      expect(adapter[name].prototype, `${name} must extend Error`).toBeInstanceOf(Error);
    }
  });

  it('no file outside packages/channel-adapter names a messaging vendor', () => {
    // Not vacuous: the adapter must exist for "outside it" to mean anything,
    // the scan must see the codebase, and the pattern must actually fire.
    expect(existsSync(ADAPTER_DIR), 'packages/channel-adapter does not exist').toBe(true);
    expect(
      VENDOR_PATTERN.test(`import x from '${'twil' + 'io'}';`),
      'the vendor pattern does not fire',
    ).toBe(true);

    const files = sourceFiles().filter((file) => !isInsideAdapter(file));
    expect(files.length, 'the scan found almost no source — is the root right?').toBeGreaterThan(
      100,
    );

    // The lockfile is out of scope here: once a vendor is chosen its SDK will
    // appear in it legitimately, as a dependency of the adapter only.
    const outside = files.filter((file) => !file.endsWith('pnpm-lock.yaml'));
    expect(vendorHits(outside), 'a vendor is named outside the adapter (CLAUDE.md 2.8)').toEqual(
      [],
    );
  });

  it('names no vendor anywhere yet, adapter and lockfile included, while the provider decision is open', () => {
    // T-0017: "the provider choice is a decision, not an implementation
    // detail — raise it." Until @acexode answers it in team/DECISIONS.md,
    // the only provider is the fake. The lead removes this test when the
    // decision lands; the test above is the permanent one.
    expect(existsSync(ADAPTER_DIR), 'packages/channel-adapter does not exist').toBe(true);

    const files = sourceFiles().filter(isInsideAdapter);
    expect(files.length, 'packages/channel-adapter has no source').toBeGreaterThan(0);

    const lockfile = join(repoRoot, 'pnpm-lock.yaml');
    const everywhere = existsSync(lockfile) ? [...files, lockfile] : files;
    expect(vendorHits(everywhere), 'a vendor was chosen before the decision was made').toEqual([]);
  });
});

describe('acceptance: DND is enforced at the adapter, from the explicit purpose', () => {
  it('refuses a promotional send to a DND-registered number with a typed error, before the provider is called', async () => {
    const adapter = await loadAdapter();
    const provider = new adapter.FakeChannelProvider();
    const channel = adapter.createChannelAdapter({
      provider,
      dnd: new adapter.FakeDndRegister([DND_NUMBER]),
    });

    const error = await rejectionOf(
      channel.send(
        sendRequest({ to: DND_NUMBER, purpose: 'promotional', body: 'Big sale this weekend!' }),
      ),
    );

    expect(error).toBeInstanceOf(adapter.DndRefusedError);
    expect(error).toBeInstanceOf(adapter.ChannelError);
    expect((error as ChannelErrorShape).code).toBe('dnd_refused');
    // Retrying a DND refusal is how a refused message gets sent anyway.
    expect((error as ChannelErrorShape).retryable).toBe(false);
    expect(provider.sent, 'the refused message reached the provider').toHaveLength(0);
  });

  it('allows a transactional send to the same number, and a promotional send to a clear one', async () => {
    const adapter = await loadAdapter();
    const provider = new adapter.FakeChannelProvider();
    const channel = adapter.createChannelAdapter({
      provider,
      dnd: new adapter.FakeDndRegister([DND_NUMBER]),
    });

    // An OTP to a DND-registered number is lawful: DND restricts promotional
    // traffic, not a code the person asked for.
    const otp = await channel.send(
      sendRequest({ to: DND_NUMBER, purpose: 'transactional', body: 'Your code is 0000.' }),
    );
    expect(typeof otp.messageId).toBe('string');
    expect(otp.messageId.length).toBeGreaterThan(0);

    // And DND is a per-number check, not "refuse all promotional".
    await channel.send(
      sendRequest({ to: CLEAR_NUMBER, purpose: 'promotional', body: 'Big sale!' }),
    );

    expect(provider.sent.map((sent) => [sent.to, sent.purpose])).toEqual([
      [DND_NUMBER, 'transactional'],
      [CLEAR_NUMBER, 'promotional'],
    ]);
  });

  it('applies the DND check in front of any provider, not inside the fake', async () => {
    // The second provider will be a real vendor. If the check lives in the
    // fake, it vanishes the day the fake is swapped out.
    const adapter = await loadAdapter();
    const provider = countingProvider();
    const channel = adapter.createChannelAdapter({
      provider,
      dnd: new adapter.FakeDndRegister([DND_NUMBER]),
    });

    const error = await rejectionOf(
      channel.send(sendRequest({ to: DND_NUMBER, purpose: 'promotional' })),
    );
    expect(error).toBeInstanceOf(adapter.DndRefusedError);
    expect(provider.sends).toHaveLength(0);

    await channel.send(sendRequest({ to: DND_NUMBER, purpose: 'transactional' }));
    expect(provider.sends).toHaveLength(1);
  });

  it('requires the purpose to be stated and the destination to be E.164, rather than guessing', async () => {
    const adapter = await loadAdapter();
    const provider = countingProvider();
    const channel = adapter.createChannelAdapter({
      provider,
      dnd: new adapter.FakeDndRegister([DND_NUMBER]),
    });

    const { purpose: _omitted, ...withoutPurpose } = sendRequest({ to: DND_NUMBER });
    const invalid: { label: string; request: unknown }[] = [
      // No default: a missing purpose is not "probably transactional".
      { label: 'missing purpose', request: withoutPurpose },
      { label: 'unknown purpose', request: { ...sendRequest(), purpose: 'marketing' } },
      // The national form of a DND-registered number must not slip past a
      // register keyed on E.164.
      {
        label: 'national-format destination',
        request: sendRequest({ to: `0${DND_NUMBER.slice(4)}`, purpose: 'promotional' }),
      },
    ];

    for (const { label, request } of invalid) {
      const error = await rejectionOf(channel.send(request as SendRequest));
      expect(error, label).toBeInstanceOf(adapter.InvalidSendRequestError);
      expect((error as ChannelErrorShape).code, label).toBe('invalid_request');
      expect((error as ChannelErrorShape).retryable, label).toBe(false);
    }

    expect(provider.sends, 'an invalid request reached the provider').toHaveLength(0);
  });
});

describe('acceptance: delivery status and provider failures are typed', () => {
  it("reports delivery status within the sender's scope, and 404s it for anyone else", async () => {
    const adapter = await loadAdapter();
    const provider = new adapter.FakeChannelProvider();
    const channel = adapter.createChannelAdapter({
      provider,
      dnd: new adapter.FakeDndRegister([]),
    });

    const { messageId, state } = await channel.send(sendRequest());
    expect(['queued', 'sent', 'delivered', 'failed']).toContain(state);

    provider.setDeliveryState(messageId, 'delivered');
    const status = await channel.getDeliveryStatus(SCOPE_A, messageId);
    expect(status.messageId).toBe(messageId);
    expect(status.state).toBe('delivered');
    expect(status.updatedAt).toBeInstanceOf(Date);

    // Another tenant asking about this message gets the same answer as for a
    // message that never existed (CLAUDE.md 6.4).
    for (const [label, scope, id] of [
      ['other tenant', SCOPE_B, messageId],
      ['unknown id', SCOPE_A, 'no-such-message'],
    ] as const) {
      const error = await rejectionOf(channel.getDeliveryStatus(scope, id));
      expect(error, label).toBeInstanceOf(adapter.MessageNotFoundError);
      expect((error as ChannelErrorShape).code, label).toBe('message_not_found');
    }
  });

  it('surfaces a provider failure as a typed error that says whether to retry', async () => {
    const adapter = await loadAdapter();
    const provider = new adapter.FakeChannelProvider();
    const channel = adapter.createChannelAdapter({
      provider,
      dnd: new adapter.FakeDndRegister([]),
    });

    // Transient (timeout, 5xx, throttling): the caller may retry.
    provider.failNextSend('unavailable');
    const transient = await rejectionOf(channel.send(sendRequest()));
    expect(transient).toBeInstanceOf(adapter.ProviderUnavailableError);
    expect(transient).toBeInstanceOf(adapter.ChannelError);
    expect((transient as ChannelErrorShape).code).toBe('provider_unavailable');
    expect((transient as ChannelErrorShape).retryable).toBe(true);

    // Permanent (number unreachable, content refused): retrying is spam.
    provider.failNextSend('rejected');
    const permanent = await rejectionOf(channel.send(sendRequest()));
    expect(permanent).toBeInstanceOf(adapter.ProviderRejectedError);
    expect((permanent as ChannelErrorShape).code).toBe('provider_rejected');
    expect((permanent as ChannelErrorShape).retryable).toBe(false);

    // A failure is one-shot; the adapter is usable afterwards.
    await expect(channel.send(sendRequest())).resolves.toHaveProperty('messageId');
  });
});

describe('acceptance: the destination number and the body never leave in telemetry', () => {
  it('emits neither for a successful PII-heavy send', async () => {
    const adapter = await loadAdapter();
    const logs: Captured['logs'] = [];
    const stray = captureStray();

    const channel = adapter.createChannelAdapter({
      provider: new adapter.FakeChannelProvider(),
      dnd: new adapter.FakeDndRegister([]),
      logger: capturingLogger(logs),
    });
    const result = await channel.send(sendRequest({ to: PII_TO, body: PII_BODY }));
    vi.restoreAllMocks();

    // The result is returned to the caller, and is the thing most likely to
    // be logged by the caller next.
    const haystack = [
      inspect({ logs, stray, result }, { depth: 10 }),
      JSON.stringify({ logs, result }),
    ].join('\n');
    for (const [label, value] of Object.entries(PII_PROBES)) {
      expect(haystack, `a successful send leaked the ${label}`).not.toContain(value);
    }
  });

  it("emits neither when the provider fails, even when the provider's own error carries both", async () => {
    // The specific hazard T-0017 names: a vendor SDK's error object embeds the
    // request, and an adapter that rethrows it, wraps it as `cause`, or logs it
    // "to be actionable" ships the number and the OTP to wherever errors go.
    const adapter = await loadAdapter();
    const leakyVendor: ChannelProvider = {
      send: async (request) => {
        throw Object.assign(
          new Error(`400 Bad Request: could not deliver "${request.body}" to ${request.to}`),
          {
            request: { to: request.to, body: request.body },
            response: { data: { msisdn: request.to.slice(1) } },
          },
        );
      },
      getDeliveryStatus: async () => {
        throw new Error('not used');
      },
      capabilities: () => ({ channels: ['sms'], templates: false, webhooks: false }),
      templates: async () => [],
      parseWebhook: async () => {
        throw new Error('leakyVendor does not parse webhooks');
      },
    };

    const fake = new adapter.FakeChannelProvider();
    fake.failNextSend('unavailable');

    for (const [label, provider] of [
      ['a raw vendor error', leakyVendor],
      ['the fake failing', fake],
    ] as const) {
      const logs: Captured['logs'] = [];
      const stray = captureStray();
      const channel = adapter.createChannelAdapter({
        provider,
        dnd: new adapter.FakeDndRegister([]),
        logger: capturingLogger(logs),
      });

      const error = await rejectionOf(channel.send(sendRequest({ to: PII_TO, body: PII_BODY })));
      vi.restoreAllMocks();

      // Still typed and actionable: whatever the provider threw, the caller
      // gets a ChannelError with a code and a retry answer.
      expect(error, `${label}: not a ChannelError`).toBeInstanceOf(adapter.ChannelError);
      expect(typeof (error as ChannelErrorShape).code, `${label}: no code`).toBe('string');
      expect(typeof (error as ChannelErrorShape).retryable, `${label}: no retryable`).toBe(
        'boolean',
      );

      // And diagnosable: the failure was logged, by code — which names nobody.
      const logText = JSON.stringify(logs);
      expect(logs.length, `${label}: the failure was not logged at all`).toBeGreaterThan(0);
      expect(logText, `${label}: the log does not carry the error code`).toContain(
        (error as ChannelErrorShape).code,
      );

      const haystack = [
        describeError(error),
        inspect({ logs, stray }, { depth: 10 }),
        logText,
      ].join('\n');
      for (const [probe, value] of Object.entries(PII_PROBES)) {
        expect(haystack, `${label}: leaked the ${probe}`).not.toContain(value);
      }
    }
  });
});
