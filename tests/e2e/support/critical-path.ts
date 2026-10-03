import type { CDPSession, Page } from '@playwright/test';

/**
 * The sign-in critical path, as a rule in code (T-0010, D-L28, PRD 2.13).
 *
 * PRD 2.13 caps the critical path at 300 KB gzipped. "Critical path" left to
 * prose becomes whatever the person measuring wanted, so it is stated here and
 * nowhere else:
 *
 *   - the route is `/`, the sign-in screen (`apps/web/app/page.tsx`);
 *   - a resource counts if its CDP resource type is Document, Script,
 *     Stylesheet or Font — what first contentful paint and a usable sign-in
 *     need — and NOT Image, Fetch, XHR or anything else;
 *   - and only if it was REQUESTED at or before first contentful paint. A chunk
 *     the page asks for after it has painted is lazy by definition: it costs
 *     the user bytes, but not the bytes between them and the screen.
 *
 * The figure is GZIPPED TRANSFER — CDP `encodedDataLength`, what crossed the
 * wire — never decoded bytes. The NFR is stated gzipped, and the two differ by
 * roughly a factor of three; comparing the wrong one to 300 KB is a silent
 * three-fold error in the direction of passing.
 *
 * This module imports nothing from Playwright at runtime, so the acceptance
 * suite can exercise the rule without a browser.
 */

export interface CapturedResource {
  url: string;
  /** The CDP Network.ResourceType string: 'Document' | 'Script' | 'Font' | ... */
  resourceType: string;
  /** Request sent, in ms after navigation start (the page's `timeOrigin`). */
  startedAtMs: number;
  /** What crossed the wire: CDP `encodedDataLength`. */
  transferBytes: number;
  /** The body after content decoding. */
  decodedBytes: number;
}

export interface RecordedResource extends CapturedResource {
  contentEncoding: string | null;
  cacheControl: string | null;
  counted: boolean;
}

export const CRITICAL_PATH_RULE = {
  route: '/',
  resourceTypes: ['Document', 'Script', 'Stylesheet', 'Font'],
  cutoff: 'first-contentful-paint',
} as const satisfies {
  route: string;
  resourceTypes: readonly string[];
  cutoff: 'first-contentful-paint';
};

export interface CriticalPathMeasurement {
  counted: CapturedResource[];
  excluded: CapturedResource[];
  gzippedBytes: number;
  rawBytes: number;
}

const COUNTED_TYPES: ReadonlySet<string> = new Set(CRITICAL_PATH_RULE.resourceTypes);

/** Applies `CRITICAL_PATH_RULE` to a capture. Pure; the only definition there is. */
export function measureCriticalPath(
  resources: readonly CapturedResource[],
  fcpMs: number,
): CriticalPathMeasurement {
  const counted: CapturedResource[] = [];
  const excluded: CapturedResource[] = [];
  for (const resource of resources) {
    if (COUNTED_TYPES.has(resource.resourceType) && resource.startedAtMs <= fcpMs) {
      counted.push(resource);
    } else {
      excluded.push(resource);
    }
  }
  return {
    counted,
    excluded,
    gzippedBytes: counted.reduce((total, r) => total + r.transferBytes, 0),
    rawBytes: counted.reduce((total, r) => total + r.decodedBytes, 0),
  };
}

/**
 * The sign-in critical-path budget, in gzipped bytes.
 *
 * MEASURED, THEN PINNED CLOSE — not set at the 300,000-byte NFR ceiling. A
 * budget at the ceiling permits every regression between today's weight and
 * the limit; one pinned near today's weight fails on the commit that causes
 * the growth, while it is cheap and someone remembers why.
 *
 * Against `next build` + `next start`, cold cache, 256 kbps / 300 ms profile
 * (see team/reports/T-0010.md for the runs):
 *
 *   measured   240,015 bytes gzipped (raw 612,207), identical across six runs:
 *              one document, eleven scripts, one stylesheet, three fonts
 *   budget     250,000 bytes — 9,985 of headroom, inside 10 KiB
 *   ceiling    300,000 bytes (PRD 2.13) — 50,000 above the budget
 *
 * Raising it is allowed, in a pull request that says why. Raising it past the
 * ceiling is not: that is a finding about the app for team/DECISIONS.md.
 */
export const SIGN_IN_CRITICAL_PATH_BUDGET_BYTES = 250_000;

/**
 * Throws when the critical path is over budget. A thrown Error rather than an
 * `expect`, so the message reads the same in a terminal, the HTML report and a
 * CI log. One byte over fails: no rounding, no tolerance, no warning.
 */
export function assertCriticalPathWithinBudget(
  route: string,
  gzippedBytes: number,
  budgetBytes: number,
): void {
  if (gzippedBytes > budgetBytes) {
    const overBy = gzippedBytes - budgetBytes;
    throw new Error(
      `Critical-path byte budget exceeded on route ${route}: ${gzippedBytes} bytes gzipped ` +
        `against a budget of ${budgetBytes} bytes (over by ${overBy}). ` +
        'The critical path is the documents, scripts, styles and fonts requested at or before ' +
        'first contentful paint (tests/e2e/support/critical-path.ts). Reduce the page, or raise ' +
        'the budget in a pull request that says why — never past the PRD 2.13 ceiling of ' +
        '300000 bytes.',
    );
  }
}

// ---------------------------------------------------------------------------
// Capture. Everything below runs against a live page; the rule above does not.
// ---------------------------------------------------------------------------

/** Only the CDP fields read here, so a protocol change fails at compile time. */
interface RequestWillBeSent {
  requestId: string;
  wallTime: number;
  type?: string;
  request: { url: string };
}
interface ResponseReceived {
  requestId: string;
  type: string;
  response: { headers: Record<string, string> };
}
interface DataReceived {
  requestId: string;
  dataLength: number;
}
interface LoadingFinished {
  requestId: string;
  encodedDataLength: number;
}
interface LoadingFailed {
  requestId: string;
}

interface Pending {
  url: string;
  resourceType: string;
  wallTimeMs: number;
  decodedBytes: number;
  contentEncoding: string | null;
  cacheControl: string | null;
}

function header(headers: Record<string, string>, name: string): string | null {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) {
      return value;
    }
  }
  return null;
}

export interface CriticalPathCapture {
  fcpMs: number;
  /** Every finished network request, before the rule is applied. */
  resources: (CapturedResource & { contentEncoding: string | null; cacheControl: string | null })[];
  /** The decoded body of the navigation's document. */
  documentHtml: string;
}

/**
 * Load `url` with a cold cache and record every request it makes.
 *
 * Nothing here waits on a clock: the page-load wait is Playwright's load state,
 * the paint wait is a performance entry appearing, and "every byte counted" is
 * an event-driven promise that resolves when the in-flight set drains.
 *
 * `startedAtMs` is CDP's wall-clock send time minus the page's
 * `performance.timeOrigin`, which puts it on the same timeline as the FCP entry.
 */
export async function captureCriticalPath(
  page: Page,
  url: string,
  network: { latencyMs: number; downloadBytesPerSecond: number | null },
): Promise<CriticalPathCapture> {
  const client: CDPSession = await page.context().newCDPSession(page);
  await client.send('Network.enable');
  await client.send('Network.setCacheDisabled', { cacheDisabled: true });
  await client.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: network.latencyMs,
    downloadThroughput: network.downloadBytesPerSecond ?? -1,
    uploadThroughput: network.downloadBytesPerSecond ?? -1,
  });

  const pending = new Map<string, Pending>();
  const finished: (Pending & { transferBytes: number })[] = [];
  let drained: (() => void) | null = null;
  const settle = (): void => {
    if (pending.size === 0 && drained !== null) {
      drained();
    }
  };

  client.on('Network.requestWillBeSent', (event: RequestWillBeSent) => {
    // `data:` and `blob:` URLs are announced but never finish; counting one
    // would leave the in-flight set permanently non-empty.
    if (!event.request.url.startsWith('http')) {
      return;
    }
    pending.set(event.requestId, {
      url: event.request.url,
      resourceType: event.type ?? 'Other',
      wallTimeMs: event.wallTime * 1000,
      decodedBytes: 0,
      contentEncoding: null,
      cacheControl: null,
    });
  });
  client.on('Network.responseReceived', (event: ResponseReceived) => {
    const entry = pending.get(event.requestId);
    if (entry !== undefined) {
      entry.resourceType = event.type;
      entry.contentEncoding = header(event.response.headers, 'content-encoding');
      entry.cacheControl = header(event.response.headers, 'cache-control');
    }
  });
  client.on('Network.dataReceived', (event: DataReceived) => {
    const entry = pending.get(event.requestId);
    if (entry !== undefined) {
      entry.decodedBytes += event.dataLength;
    }
  });
  client.on('Network.loadingFinished', (event: LoadingFinished) => {
    const entry = pending.get(event.requestId);
    if (entry !== undefined) {
      pending.delete(event.requestId);
      finished.push({ ...entry, transferBytes: event.encodedDataLength });
      settle();
    }
  });
  client.on('Network.loadingFailed', (event: LoadingFailed) => {
    pending.delete(event.requestId);
    settle();
  });

  const response = await page.goto(url, { waitUntil: 'load' });
  if (response === null || !response.ok()) {
    throw new Error(`${url} did not load: ${response === null ? 'no response' : response.status()}`);
  }
  const documentHtml = await response.text();

  await page.waitForFunction(
    () => performance.getEntriesByName('first-contentful-paint').length > 0,
  );
  const { fcpMs, timeOrigin } = await page.evaluate(() => ({
    fcpMs: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? 0,
    timeOrigin: performance.timeOrigin,
  }));

  await new Promise<void>((done) => {
    drained = done;
    settle();
  });
  await client.detach();

  return {
    fcpMs,
    documentHtml,
    resources: finished.map((entry) => ({
      url: entry.url,
      resourceType: entry.resourceType,
      startedAtMs: entry.wallTimeMs - timeOrigin,
      transferBytes: entry.transferBytes,
      decodedBytes: entry.decodedBytes,
      contentEncoding: entry.contentEncoding,
      cacheControl: entry.cacheControl,
    })),
  };
}

/**
 * The build id the SERVED app reports, read from the App Router's inline
 * flight payload (`"b":"<buildId>"`). `next dev` reports `development`; a
 * production build reports the id in `apps/web/.next/BUILD_ID`.
 */
export function servedBuildId(documentHtml: string): string {
  const match = /\\?"b\\?"\s*:\s*\\?"([A-Za-z0-9_-]+)\\?"/.exec(documentHtml);
  if (match?.[1] === undefined) {
    throw new Error('the served document carries no build id — is this a Next App Router page?');
  }
  return match[1];
}
