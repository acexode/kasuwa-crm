import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';

/**
 * Network profiles and the two numbers a screen test is allowed to assert on.
 *
 * PRD 2.13 commits to a workspace that is usable at 256 kbps with 300 ms of
 * latency. That commitment survives thirty screens only if it is a number a
 * test can fail on, so this module exposes exactly two:
 *
 *   fcpMs             first contentful paint, in milliseconds
 *   transferredBytes  what actually crossed the wire for the whole page load
 *
 * Both are measured through the Chrome DevTools Protocol rather than inferred.
 * `Network.emulateNetworkConditions` is what makes the throttling real — it is
 * applied inside the browser, so it shapes every request the page makes,
 * including ones Playwright never sees.
 */

export interface ProfileMetrics {
  fcpMs: number;
  transferredBytes: number;
}

export interface NetworkProfile {
  /** Round-trip latency added to every request, in milliseconds. */
  latencyMs: number;
  /** Maximum download throughput in bytes per second, or null for unthrottled. */
  downloadBytesPerSecond: number | null;
  uploadBytesPerSecond: number | null;
}

function kbps(value: number): number {
  return (value * 1024) / 8;
}

/**
 * `default` is an unthrottled local load — the baseline a comparison needs.
 * `low-bandwidth` is the PRD 2.13 commitment, and nothing else. Do not "relax"
 * it to make a screen pass: a screen that cannot meet it is a finding about the
 * screen, and it belongs in team/DECISIONS.md rather than here.
 */
export const NETWORK_PROFILES = {
  default: { latencyMs: 0, downloadBytesPerSecond: null, uploadBytesPerSecond: null },
  'low-bandwidth': {
    latencyMs: 300,
    downloadBytesPerSecond: kbps(256),
    uploadBytesPerSecond: kbps(256),
  },
} as const satisfies Record<string, NetworkProfile>;

export type ProfileName = keyof typeof NETWORK_PROFILES;

const METRICS_FILE = resolve(__dirname, '..', '.artifacts', 'harness-metrics.json');

/** Only the fields this harness reads, so a protocol change fails at compile time. */
interface LoadingFinishedEvent {
  requestId: string;
  encodedDataLength: number;
}
interface RequestEvent {
  requestId: string;
}
interface RequestWillBeSentEvent extends RequestEvent {
  request: { url: string };
}

/**
 * Load `url` under `profile` and report what it cost.
 *
 * Nothing here waits on a clock. The page-load wait is Playwright's own load
 * state, the paint wait is a `PerformanceObserver` entry appearing, and the
 * "all bytes counted" wait polls the set of in-flight requests until it is
 * empty. Sleeping for a fixed number of milliseconds in any of those places
 * would trade a real signal for a guess, and an acceptance test greps this
 * directory for the Playwright call that does it.
 */
export async function measurePageLoad(
  page: Page,
  url: string,
  profileName: ProfileName,
): Promise<ProfileMetrics> {
  const profile = NETWORK_PROFILES[profileName];
  const client = await page.context().newCDPSession(page);

  await client.send('Network.enable');
  // Without this the second profile measured in a session reads a warm cache
  // and reports a fraction of the bytes, which would make the two profiles
  // incomparable — and would look exactly like throttling working.
  await client.send('Network.setCacheDisabled', { cacheDisabled: true });

  const inFlight = new Set<string>();
  let transferredBytes = 0;

  client.on('Network.requestWillBeSent', (event: RequestWillBeSentEvent) => {
    // Only real network requests. A `data:` or `blob:` URL is announced here
    // but never reports `loadingFinished`, so counting one would leave the
    // in-flight set permanently non-empty and turn the wait below into a hang.
    if (event.request.url.startsWith('http')) {
      inFlight.add(event.requestId);
    }
  });
  client.on('Network.loadingFinished', (event: LoadingFinishedEvent) => {
    transferredBytes += event.encodedDataLength;
    inFlight.delete(event.requestId);
  });
  client.on('Network.loadingFailed', (event: RequestEvent) => {
    inFlight.delete(event.requestId);
  });

  await client.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: profile.latencyMs,
    downloadThroughput: profile.downloadBytesPerSecond ?? -1,
    uploadThroughput: profile.uploadBytesPerSecond ?? -1,
  });

  const response = await page.goto(url, { waitUntil: 'load' });
  if (response === null || !response.ok()) {
    throw new Error(`${url} did not load: ${response === null ? 'no response' : response.status()}`);
  }

  await page.waitForFunction(
    () => performance.getEntriesByName('first-contentful-paint').length > 0,
  );
  const fcpMs = await page.evaluate(
    () => performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? 0,
  );

  // Every byte accounted for before we report a total.
  await expect.poll(() => inFlight.size, { message: 'requests still in flight' }).toBe(0);

  await client.detach();

  return { fcpMs, transferredBytes };
}

/**
 * Append one profile's numbers to `.artifacts/harness-metrics.json`.
 *
 * The file is the harness's published interface (T-0008 contract point 3): the
 * acceptance suite runs the harness and asserts on this, rather than reading
 * the harness's source and believing it. Safe to read-modify-write because the
 * config pins `workers: 1`.
 */
export function recordProfileMetrics(profileName: ProfileName, metrics: ProfileMetrics): void {
  mkdirSync(dirname(METRICS_FILE), { recursive: true });

  let existing: Record<string, ProfileMetrics> = {};
  try {
    existing = JSON.parse(readFileSync(METRICS_FILE, 'utf8')) as Record<string, ProfileMetrics>;
  } catch {
    existing = {};
  }

  existing[profileName] = metrics;
  writeFileSync(METRICS_FILE, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');
}

/**
 * Fail the run when a page costs more than it is allowed to.
 *
 * Deliberately a thrown Error rather than an `expect`, so the message reads the
 * same in the terminal, in the HTML report and in a CI log, and so the word
 * "budget" is impossible to miss in any of them.
 *
 * `tests/e2e/fixtures/over-budget.spec.ts` exists to demonstrate this firing.
 * Do not delete it: a budget check that has only ever been seen passing is
 * indistinguishable from one that checks nothing.
 */
export function assertWithinByteBudget(
  label: string,
  transferredBytes: number,
  budgetBytes: number,
): void {
  if (transferredBytes > budgetBytes) {
    const overBy = transferredBytes - budgetBytes;
    throw new Error(
      `Transferred-byte budget exceeded by ${label}: ${transferredBytes} bytes transferred ` +
        `against a budget of ${budgetBytes} bytes (over by ${overBy}). ` +
        'At 256 kbps that is roughly ' +
        `${(overBy / kbps(256)).toFixed(1)}s of extra waiting for a user on the network ` +
        'PRD 2.13 commits to. Reduce the page, or raise the budget in a pull request that ' +
        'says why.',
    );
  }
}
