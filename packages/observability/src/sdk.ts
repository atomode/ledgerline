import { context, metrics, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { IORedisInstrumentation } from "@opentelemetry/instrumentation-ioredis";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { FastifyOtelInstrumentation } from "@fastify/otel";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor, TracerProvider, type SpanExporter } from "@opentelemetry/sdk-trace";

export interface TelemetryOptions {
  serviceName: string;
  serviceVersion?: string | undefined;
  environment?: string | undefined;
  /** Base OTLP/HTTP endpoint (the collector), e.g. http://localhost:4318. */
  endpoint?: string | undefined;
  /** Test hook: export spans here instead of OTLP. */
  spanExporter?: SpanExporter;
  metricIntervalMs?: number;
  /** false: tracing only (tests). */
  metrics?: boolean;
}

export interface Telemetry {
  /** Export everything buffered so far (tests, and before a short-lived process exits). */
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

const HEALTH_PATHS = new Set(["/healthz", "/readyz"]);

/**
 * Configure tracing and metrics globally. Idempotent per process; returns a shutdown function
 * that flushes both pipelines (call it from the SIGTERM handler).
 */
export function startTelemetry(opts: TelemetryOptions): Telemetry {
  const endpoint = (opts.endpoint ?? "http://localhost:4318").replace(/\/$/, "");
  const resource = resourceFromAttributes({
    "service.name": opts.serviceName,
    "service.version": opts.serviceVersion ?? "dev",
    "deployment.environment.name": opts.environment ?? "development",
  });

  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(
    new CompositePropagator({
      propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
    }),
  );

  const tracerProvider = new TracerProvider({
    resource,
    spanProcessors: [
      new BatchSpanProcessor({
        exporter: opts.spanExporter ?? new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
      }),
    ],
  });
  trace.setGlobalTracerProvider(tracerProvider);

  const meterProvider = new MeterProvider({
    resource,
    readers:
      opts.metrics === false
        ? []
        : [
            new PeriodicExportingMetricReader({
              exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
              exportIntervalMillis: opts.metricIntervalMs ?? 15_000,
            }),
          ],
  });
  metrics.setGlobalMeterProvider(meterProvider);

  registerInstrumentations({
    tracerProvider,
    meterProvider,
    instrumentations: [
      new HttpInstrumentation({
        // Probes would be most of the traffic and none of the signal.
        ignoreIncomingRequestHook: (req) => HEALTH_PATHS.has((req.url ?? "").split("?")[0] ?? ""),
      }),
      new FastifyOtelInstrumentation({
        registerOnInitialization: true,
        ignorePaths: (opts) => HEALTH_PATHS.has(opts.url),
      }),
      // requireParentSpan: BullMQ polls Redis constantly; only commands made inside a request or
      // a job are worth a span.
      new PgInstrumentation({ requireParentSpan: true, enhancedDatabaseReporting: false }),
      new IORedisInstrumentation({ requireParentSpan: true }),
    ],
  });

  return {
    async flush() {
      await Promise.allSettled([tracerProvider.forceFlush(), meterProvider.forceFlush()]);
    },
    async shutdown() {
      await Promise.allSettled([tracerProvider.shutdown(), meterProvider.shutdown()]);
    },
  };
}
