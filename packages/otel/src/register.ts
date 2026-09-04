/**
 * Loaded through `node --require` (see the Dockerfile) so the SDK patches
 * http, pg, grpc and kafkajs *before* the application imports them. Calling
 * this from inside main.ts is the single most common reason a service produces
 * a trace with one span in it and nothing underneath.
 *
 * Service identity comes from OTEL_SERVICE_NAME, which docker-compose sets per
 * service. Nothing here needs to know the topology.
 */
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';

const level = (process.env.OTEL_LOG_LEVEL ?? 'error').toUpperCase();
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel[level as keyof typeof DiagLogLevel] ?? DiagLogLevel.ERROR);

const endpoint = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318').replace(/\/$/, '');

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
    // Short enough that a reviewer sees the dashboard move within seconds of
    // running the demo, long enough not to dominate the collector's workload.
    exportIntervalMillis: 5_000,
  }),
  instrumentations: [
    getNodeAutoInstrumentations({
      // Noise with no diagnostic value; it buries the spans that matter.
      '@opentelemetry/instrumentation-fs': { enabled: false },
      '@opentelemetry/instrumentation-net': { enabled: false },
      '@opentelemetry/instrumentation-dns': { enabled: false },
      '@opentelemetry/instrumentation-http': {
        // Health probes fire every ten seconds per service and would otherwise
        // be 90% of all spans.
        ignoreIncomingRequestHook: (req) => (req.url ?? '').startsWith('/health'),
      },
      '@opentelemetry/instrumentation-pg': {
        // The statement is what makes a slow database span actionable. Safe
        // here because this codebase only ever sends parameterised SQL, so no
        // customer data reaches the span attributes.
        enhancedDatabaseReporting: true,
      },
    }),
  ],
});

sdk.start();

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    // Flush before exit, otherwise the last few seconds of a demo run — often
    // the interesting part — never reach the collector.
    await sdk.shutdown();
  } catch (err) {
    console.error('[otel] shutdown failed', err);
  } finally {
    process.exit(signal === 'SIGTERM' || signal === 'SIGINT' ? 0 : 1);
  }
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
