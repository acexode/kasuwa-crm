import { trace } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';
import { collectTelemetry } from './telemetry';

describe('collectTelemetry span events (T-0036)', () => {
  it('returns every event on a span, in order, with a copy of its attributes', async () => {
    const telemetry = await collectTelemetry(async () => {
      const span = trace.getTracer('t0036-unit').startSpan('with-events');
      span.addEvent('first');
      span.addEvent('exception', { 'exception.type': 'ProbeError' });
      span.end();
      await Promise.resolve();
    });

    const span = telemetry.spans.find((candidate) => candidate.name === 'with-events');
    expect(span?.events).toEqual([
      { name: 'first', attributes: {} },
      { name: 'exception', attributes: { 'exception.type': 'ProbeError' } },
    ]);
  });

  it('gives a span with no events an empty array, not a missing field', async () => {
    const telemetry = await collectTelemetry(async () => {
      trace.getTracer('t0036-unit').startSpan('no-events').end();
      await Promise.resolve();
    });

    expect(telemetry.spans.find((span) => span.name === 'no-events')?.events).toEqual([]);
  });

  it('makes recordException visible, which is what the PII grep relies on', async () => {
    const telemetry = await collectTelemetry(async () => {
      const span = trace.getTracer('t0036-unit').startSpan('recorded');
      span.recordException(new Error('probe-message-t0036'));
      span.end();
      await Promise.resolve();
    });

    expect(JSON.stringify(telemetry.spans.map((span) => span.events))).toContain(
      'probe-message-t0036',
    );
  });
});
