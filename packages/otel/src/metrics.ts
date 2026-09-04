import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('ticketing');

/**
 * RED — Rate, Errors, Duration — from a single histogram. Rate is the count of
 * observations, errors are the subset with a 5xx/4xx status attribute, and
 * duration is the distribution itself. One instrument, three panels, no
 * double-counting between them.
 *
 * The route label is always the *route template* (`/events/:id`), never the
 * raw path. Labelling by raw path would mint a new time series per event id
 * and take Prometheus down within an hour of real traffic.
 */
export const httpServerDuration = meter.createHistogram('http.server.request.duration', {
  description: 'Duration of inbound HTTP requests',
  unit: 'ms',
});

export const grpcClientDuration = meter.createHistogram('rpc.client.duration', {
  description: 'Duration of outbound gRPC calls to the inventory service',
  unit: 'ms',
});

export const messagesConsumed = meter.createCounter('messaging.consumed', {
  description: 'Kafka messages consumed, by topic, consumer group and outcome',
});

export const messagesProduced = meter.createCounter('messaging.produced', {
  description: 'Kafka messages published, by topic',
});

/**
 * Outbox depth is the health signal for the whole async path: if it climbs,
 * either the relay is down or Kafka is unreachable, and orders are paid for
 * but not fulfilled. It is the one gauge worth waking someone up for.
 */
export const outboxPending = meter.createObservableGauge('outbox.pending', {
  description: 'Rows in the transactional outbox not yet published to Kafka',
});

export const ordersCreated = meter.createCounter('orders.created', {
  description: 'Checkout sessions created',
});

export const ordersPaid = meter.createCounter('orders.paid', {
  description: 'Orders marked paid by a verified payment webhook',
});

export const ticketsIssued = meter.createCounter('tickets.issued', {
  description: 'Tickets written by the fulfilment consumer',
});

export const duplicatesSuppressed = meter.createCounter('idempotency.suppressed', {
  description: 'Replays stopped by an idempotency guard, by guard name',
});

export const searchIndexFailures = meter.createCounter('search.index.failures', {
  description: 'Elasticsearch index writes that failed and were retried or dead-lettered',
});

export const websocketConnections = meter.createUpDownCounter('realtime.connections', {
  description: 'Currently connected realtime clients',
});
