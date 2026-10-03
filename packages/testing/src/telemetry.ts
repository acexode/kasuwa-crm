import { ProxyTracerProvider, context, trace, type TracerProvider } from '@opentelemetry/api';
import { logs, type LoggerProvider as ApiLoggerProvider } from '@opentelemetry/api-logs';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

/**
 * Everything the process emitted through OpenTelemetry while `fn` ran
 * (T-0005). The contract is stated in `tests/acceptance/support/telemetry.ts`.
 *
 * It lives in `@kasuwa/testing` because this package is lint-fenced out of
 * application code: it replaces the process-wide providers, which nothing in a
 * running API should ever be able to do.
 */

export interface CollectedSpan {
  name: string;
  /** `spanContext().traceId` as the SDK recorded it: 32 lowercase hex. */
  traceId: string;
  attributes: Record<string, unknown>;
}

export interface CollectedTelemetry {
  spans: CollectedSpan[];
  /** One flat record per log: its attributes plus body, severity and trace ids. */
  logs: Record<string, unknown>[];
}

/** The API's fallback when nothing is registered: the no-op tracer provider. */
const NOOP_TRACER_PROVIDER = new ProxyTracerProvider().getDelegate();

/**
 * Installs an in-memory span exporter and log sink for the duration of `fn`,
 * then restores whatever providers were registered before.
 */
export async function collectTelemetry(fn: () => Promise<void>): Promise<CollectedTelemetry> {
  const spanExporter = new InMemorySpanExporter();
  const logExporter = new InMemoryLogRecordExporter();
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });
  const loggerProvider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor({ exporter: logExporter })],
  });

  const previousTracer = registeredTracerProvider();
  const previousLogger = registeredLoggerProvider();

  // A context manager is needed for anything below the request span to be
  // parented to it. Only installed if none is, and only removed if ours.
  const contextManager = new AsyncLocalStorageContextManager().enable();
  const ownsContext = context.setGlobalContextManager(contextManager);
  if (!ownsContext) contextManager.disable();

  trace.disable();
  trace.setGlobalTracerProvider(tracerProvider);
  logs.disable();
  logs.setGlobalLoggerProvider(loggerProvider);

  try {
    await fn();
    // A response is complete for the client a moment before the server's
    // `finish` event, which is where the request span ends. Let that run.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await tracerProvider.forceFlush();
    await loggerProvider.forceFlush();

    return {
      spans: spanExporter.getFinishedSpans().map((span) => ({
        name: span.name,
        traceId: span.spanContext().traceId,
        attributes: { ...span.attributes },
      })),
      logs: logExporter.getFinishedLogRecords().map((record) => ({
        ...record.attributes,
        body: record.body,
        severityText: record.severityText,
        severityNumber: record.severityNumber,
        traceId: record.spanContext?.traceId,
        spanId: record.spanContext?.spanId,
      })),
    };
  } finally {
    trace.disable();
    if (previousTracer !== null) trace.setGlobalTracerProvider(previousTracer);
    logs.disable();
    if (previousLogger !== null) logs.setGlobalLoggerProvider(previousLogger);
    if (ownsContext) context.disable();
    await Promise.all([tracerProvider.shutdown(), loggerProvider.shutdown()]);
  }
}

/** The registered tracer provider, or null when the API is on its no-op fallback. */
function registeredTracerProvider(): TracerProvider | null {
  const current = trace.getTracerProvider();
  const delegate = current instanceof ProxyTracerProvider ? current.getDelegate() : current;
  return delegate === NOOP_TRACER_PROVIDER ? null : delegate;
}

/**
 * The registered logger provider, or null. With nothing registered the logs API
 * hands back its own internal proxy, which is not exported, so it is recognised
 * by class name.
 */
function registeredLoggerProvider(): ApiLoggerProvider | null {
  const current = logs.getLoggerProvider();
  return current.constructor.name === 'ProxyLoggerProvider' ? null : current;
}
