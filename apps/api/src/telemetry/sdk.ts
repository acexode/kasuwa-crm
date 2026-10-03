import { context, trace } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  ConsoleLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import {
  BasicTracerProvider,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

export type TelemetryExporter = 'none' | 'console';

/**
 * Installs the process-wide OpenTelemetry providers for the API (`main.ts`).
 *
 * Deliberately NOT the auto-instrumenting NodeSDK. Auto-instrumentation for
 * http, express and pg records `url.full`, `http.target`, `user-agent`, client
 * addresses and, for pg, statement text — every one of which can carry personal
 * data, and none of which is under this repository's allow-list. The only spans
 * the API emits are the ones `RequestTelemetryMiddleware` builds.
 *
 * `none` installs nothing: the API calls are then no-ops. There is no OTLP
 * exporter yet because there is no collector to send to (D-A4). Both
 * processors are the synchronous `Simple` kind, so there is nothing buffered to
 * flush at shutdown; a batching exporter will need a shutdown hook.
 */
export function startTelemetry(exporter: TelemetryExporter): void {
  if (exporter === 'none') return;

  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(new ConsoleSpanExporter())],
  });
  trace.setGlobalTracerProvider(tracerProvider);

  const loggerProvider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor({ exporter: new ConsoleLogRecordExporter() })],
  });
  logs.setGlobalLoggerProvider(loggerProvider);
}
