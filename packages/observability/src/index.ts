/**
 * OpenTelemetry for Ledgerline. Two entry points:
 * - `@ledgerline/observability/register`: loaded with `node --import` so the SDK and the ESM hook
 *   are in place before any application module (pg, ioredis, fastify) is imported.
 * - this module: helpers the code uses at runtime (tracer, meter, trace-context carriers, log mixin).
 *
 * Without the register entry (unit tests, scripts) everything here is a no-op through the API.
 */
import {
  SpanKind,
  SpanStatusCode,
  context,
  metrics,
  propagation,
  trace,
  type Attributes,
  type Context,
  type Span,
} from "@opentelemetry/api";

export { SpanKind, SpanStatusCode, context, trace, type Span };

export const SCOPE = "ledgerline";
export const tracer = () => trace.getTracer(SCOPE);
export const meter = () => metrics.getMeter(SCOPE);

/** W3C trace context as a plain object that survives JSON (BullMQ job data, outbox payloads). */
export type TraceCarrier = Record<string, string>;

export function injectTraceContext(ctx: Context = context.active()): TraceCarrier {
  const carrier: TraceCarrier = {};
  propagation.inject(ctx, carrier);
  return carrier;
}

export function extractTraceContext(carrier: TraceCarrier | undefined): Context {
  return carrier ? propagation.extract(context.active(), carrier) : context.active();
}

/** Run `fn` in a new span, recording exceptions and status. The span ends when `fn` settles. */
export async function inSpan<T>(
  name: string,
  opts: { kind?: SpanKind | undefined; attributes?: Attributes | undefined; parent?: Context },
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const parent = opts.parent ?? context.active();
  const span = tracer().startSpan(
    name,
    { kind: opts.kind ?? SpanKind.INTERNAL, attributes: opts.attributes ?? {} },
    parent,
  );
  try {
    return await context.with(trace.setSpan(parent, span), () => fn(span));
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).name });
    throw err;
  } finally {
    span.end();
  }
}

/** pino `mixin`: puts trace_id/span_id on every log line written inside a span. */
export function traceLogMixin(): Record<string, string> {
  const sc = trace.getSpan(context.active())?.spanContext();
  return sc && sc.traceFlags !== undefined && sc.traceId !== "00000000000000000000000000000000"
    ? { trace_id: sc.traceId, span_id: sc.spanId }
    : {};
}
