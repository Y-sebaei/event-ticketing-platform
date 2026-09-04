import {
  Attributes,
  Context,
  SpanKind,
  SpanStatusCode,
  context as otelContext,
  propagation,
  trace,
} from '@opentelemetry/api';

export const tracer = trace.getTracer('ticketing');

/**
 * Wraps a unit of work in a span and records failures on it. Business spans
 * are added by hand precisely where a reviewer would want to look — "how long
 * did the inventory hold take", "how long did Stripe take" — while everything
 * mechanical (HTTP, pg, gRPC, Kafka) comes from auto-instrumentation.
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: ReturnType<typeof tracer.startSpan>) => Promise<T>,
  kind: SpanKind = SpanKind.INTERNAL,
): Promise<T> {
  return tracer.startActiveSpan(name, { kind, attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      // Error codes are a first-class span attribute so a TraceQL query like
      // { .error.code = "INSUFFICIENT_INVENTORY" } finds every oversell attempt.
      const code = (err as { code?: string }).code;
      if (code) span.setAttribute('error.code', code);
      throw err;
    } finally {
      span.end();
    }
  });
}

export interface TraceCarrier {
  traceparent?: string;
  tracestate?: string;
}

/**
 * Captures the currently active trace context as a plain object.
 *
 * This is the hinge of the whole observability story. A checkout's HTTP span
 * ends the moment the webhook handler returns 200, but fulfilment happens
 * minutes later in another process. Writing the carrier into the outbox row
 * inside the same transaction as the state change means the async half of the
 * work is guaranteed to inherit the trace, with no extra call and no chance of
 * the two committing separately.
 */
export function captureTraceContext(): TraceCarrier {
  const carrier: TraceCarrier = {};
  propagation.inject(otelContext.active(), carrier);
  return carrier;
}

/** Rebuilds a parent context from a carrier read off a Kafka message. */
export function restoreTraceContext(carrier: TraceCarrier | null | undefined): Context {
  if (!carrier?.traceparent) return otelContext.active();
  return propagation.extract(otelContext.active(), carrier);
}

/** Runs `fn` with the restored remote context active, so new spans link up. */
export function withRestoredContext<T>(carrier: TraceCarrier | null | undefined, fn: () => T): T {
  return otelContext.with(restoreTraceContext(carrier), fn);
}

/** The trace id of the current span, for logging and for the demo script. */
export function currentTraceId(): string | undefined {
  const spanContext = trace.getActiveSpan()?.spanContext();
  return spanContext && spanContext.traceId !== '00000000000000000000000000000000'
    ? spanContext.traceId
    : undefined;
}

export { SpanKind, SpanStatusCode };
