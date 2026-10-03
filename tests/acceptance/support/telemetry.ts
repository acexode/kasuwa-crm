import { resolve } from 'node:path';

/**
 * The telemetry contract the T-0005 acceptance suites are written against.
 * Shared by `platform/observability-pii.acceptance.test.ts` and
 * `platform/observability.acceptance.test.ts`, so the two cannot drift.
 *
 * THE CONTRACT for Agent 13. Internals are yours; these are not:
 *
 *   `packages/testing/src/telemetry.ts`, exported from `@kasuwa/testing`:
 *     collectTelemetry(fn): Promise<{
 *       spans: { name: string; traceId: string; attributes: Record<string, unknown> }[];
 *       logs:  Record<string, unknown>[];
 *     }>
 *
 *   It installs an in-memory span exporter and log sink for the duration of
 *   `fn` and restores whatever was there before. It lives in `@kasuwa/testing`
 *   because that package is already lint-fenced out of application code.
 *
 *   `traceId` is the span's own trace id as the SDK recorded it
 *   (`spanContext().traceId`, 32 lowercase hex characters).
 *
 *   An INBOUND API span is identified the way OpenTelemetry's HTTP semantic
 *   conventions identify one: it carries an `http.route` attribute. Client
 *   spans (supertest runs in-process, so its outgoing request may be
 *   instrumented too) do not, and are not held to the tenancy attributes.
 */

/** A recorded span, reduced to the things these assertions care about. */
export interface RecordedSpan {
  name: string;
  traceId: string;
  attributes: Record<string, unknown>;
}

export interface Telemetry {
  spans: RecordedSpan[];
  logs: Record<string, unknown>[];
}

const repoRoot = resolve(__dirname, '..', '..', '..');

/**
 * Loaded by path rather than by package name, so the suites typecheck before
 * `collectTelemetry` exists and fail at runtime instead — failing the
 * typecheck gate for everyone else is not the same thing as a failing test.
 *
 * Agent 13 may replace this indirection with a direct import from
 * '@kasuwa/testing' once the export lands.
 */
export async function collectTelemetry(fn: () => Promise<void>): Promise<Telemetry> {
  const module: { collectTelemetry?: (fn: () => Promise<void>) => Promise<Telemetry> } =
    await import(resolve(repoRoot, 'packages/testing/src/telemetry.ts'));

  if (typeof module.collectTelemetry !== 'function') {
    throw new Error('T-0005: packages/testing/src/telemetry.ts must export collectTelemetry()');
  }

  return module.collectTelemetry(fn);
}

/** True for a span recording an inbound API request (see the contract above). */
export function isInboundApiSpan(span: RecordedSpan): boolean {
  return 'http.route' in span.attributes;
}
