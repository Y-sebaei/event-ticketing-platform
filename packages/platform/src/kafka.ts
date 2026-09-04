import { SpanKind, context as otelContext, propagation, trace } from '@opentelemetry/api';
import {
  captureTraceContext,
  messagesConsumed,
  messagesProduced,
  restoreTraceContext,
  tracer,
} from '@ticketing/otel';
import { Kafka, logLevel, type Consumer, type EachMessagePayload, type Producer } from 'kafkajs';

export { Kafka, type Consumer, type Producer };

export function createKafka(clientId: string): Kafka {
  return new Kafka({
    clientId,
    brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(','),
    logLevel: logLevel.WARN,
    // A single broker starting up alongside everything else will refuse a few
    // connections before it is ready; without generous retries the whole stack
    // fails on the first `docker compose up` and looks broken when it is not.
    retry: { initialRetryTime: 300, retries: 20 },
  });
}

export interface PublishInput {
  topic: string;
  key: string;
  /** The full envelope, already containing id/type/occurredAt/payload. */
  value: Record<string, unknown>;
  /** Trace context captured when the message was written to the outbox. */
  traceContext?: { traceparent?: string; tracestate?: string } | null;
}

/**
 * Publishes with W3C trace context in the message headers.
 *
 * Two contexts are in play, and conflating them loses the trace. The one that
 * matters is the context captured when the row was written to the outbox —
 * that is the customer's checkout. The relay's own loop has a different,
 * uninteresting context. So the stored carrier wins and the relay's context is
 * only a fallback.
 */
export async function publish(producer: Producer, input: PublishInput): Promise<void> {
  const carrier = input.traceContext?.traceparent ? input.traceContext : captureTraceContext();
  const headers: Record<string, string> = {};
  if (carrier.traceparent) headers.traceparent = carrier.traceparent;
  if (carrier.tracestate) headers.tracestate = carrier.tracestate;

  await producer.send({
    topic: input.topic,
    messages: [{ key: input.key, value: JSON.stringify(input.value), headers }],
  });

  messagesProduced.add(1, { topic: input.topic });
}

export interface ConsumedMessage {
  topic: string;
  partition: number;
  offset: string;
  messageId: string;
  key: string | null;
  envelope: Record<string, unknown>;
  traceContext: { traceparent?: string; tracestate?: string };
}

export interface ConsumerOptions {
  kafka: Kafka;
  groupId: string;
  topics: string[];
  /**
   * Must be idempotent. It is called at least once per message, and after a
   * crash it is called again for anything whose offset was not committed.
   */
  handle: (message: ConsumedMessage) => Promise<void>;
  /** Where a message goes after `maxAttempts` failures. */
  dlqTopic?: string;
  maxAttempts?: number;
  producer?: Producer;
  fromBeginning?: boolean;
}

/**
 * Creates any of `topics` that do not exist yet, and waits for their leaders.
 *
 * Auto-creation is enabled on the broker, but it happens lazily on the *first
 * produce*, not on subscribe. A consumer that starts before anything has been
 * published therefore subscribes to a topic the broker does not host yet, and
 * kafkajs surfaces that as an unhandled KafkaJSProtocolError that takes the
 * process down. On a cold `docker compose up` that is the normal case, not an
 * edge case: the API's realtime consumer starts long before the first ticket is
 * sold.
 *
 * Declaring the topics up front also means partition counts are ours to choose
 * rather than whatever the broker default happens to be.
 */
export async function ensureTopics(kafka: Kafka, topics: string[], numPartitions = 3): Promise<void> {
  const wanted = topics.filter(Boolean);
  if (wanted.length === 0) return;

  const admin = kafka.admin();
  await admin.connect();
  try {
    const existing = new Set(await admin.listTopics());
    const missing = wanted.filter((topic) => !existing.has(topic));
    if (missing.length > 0) {
      await admin.createTopics({
        topics: missing.map((topic) => ({ topic, numPartitions, replicationFactor: 1 })),
        // Not kafkajs's own leader wait. That polls metadata and rethrows the
        // retriable UNKNOWN_TOPIC_OR_PARTITION straight out of the promise
        // while a freshly created topic is still propagating, which kills the
        // process. We wait below instead, where a retriable error is actually
        // treated as retriable.
        waitForLeaders: false,
      });
    }

    // Every partition must report a leader before a consumer subscribes,
    // otherwise the subscribe hits the same race one layer down.
    for (let attempt = 1; attempt <= 40; attempt++) {
      try {
        const metadata = await admin.fetchTopicMetadata({ topics: wanted });
        const ready =
          metadata.topics.length === wanted.length &&
          metadata.topics.every(
            (topic) =>
              topic.partitions.length > 0 && topic.partitions.every((partition) => partition.leader >= 0),
          );
        if (ready) return;
      } catch {
        // The topic is not visible on this broker yet. That is the expected
        // state for the first second or so after creation.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } finally {
    await admin.disconnect();
  }
}

/** Injects the active context into a plain carrier, for non-Kafka hand-offs. */
export function injectTraceHeaders(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(otelContext.active(), carrier);
  return carrier;
}

/**
 * Starts a consumer with **manual offset commits**.
 *
 * This is the mechanism behind "survives being killed mid-batch without losing
 * or double-processing an order":
 *
 *   1. autoCommit is off, so Kafka never advances the offset on its own.
 *   2. The handler does its work in one Postgres transaction that also inserts
 *      the message id into the inbox table.
 *   3. Only after that transaction commits do we commit the offset.
 *
 * Kill the process anywhere in that sequence and the offset still points at
 * this message, so Kafka redelivers it; the redelivery hits the inbox row and
 * does nothing. Delivery is at-least-once and the effect is exactly-once. We do
 * not claim exactly-once delivery, because a Kafka transaction cannot span
 * Postgres and saying otherwise in a README would be untrue.
 */
export async function startConsumer(options: ConsumerOptions): Promise<Consumer> {
  const { kafka, groupId, topics, handle, dlqTopic, producer } = options;
  const maxAttempts = options.maxAttempts ?? 5;

  const consumer = kafka.consumer({
    groupId,
    // Kept at the kafkajs default rather than raised. A longer session timeout
    // sounds safer, but it is also how long a crashed member keeps its slot in
    // the group: raise it and every restart spends that long failing to
    // rejoin, with SyncGroup timing out and the consumer looping. Fulfilment
    // work is short — the slow calls live in the API, not here.
    sessionTimeout: 30_000,
    heartbeatInterval: 3_000,
  });

  // Must happen before connect/subscribe; see ensureTopics above.
  await ensureTopics(kafka, dlqTopic ? [...topics, dlqTopic] : topics);

  await consumer.connect();
  for (const topic of topics) {
    await consumer.subscribe({ topic, fromBeginning: options.fromBeginning ?? true });
  }

  await consumer.run({
    autoCommit: false,
    eachMessage: async ({ topic, partition, message }: EachMessagePayload) => {
      const raw = message.value?.toString('utf8') ?? '{}';
      const traceContext = {
        traceparent: message.headers?.traceparent?.toString(),
        tracestate: message.headers?.tracestate?.toString(),
      };

      // Restoring the producer's context here is what makes these spans
      // children of the original checkout rather than an orphan trace.
      const parent = restoreTraceContext(traceContext);

      await otelContext.with(parent, async () => {
        const span = tracer.startSpan(`${topic} process`, {
          kind: SpanKind.CONSUMER,
          attributes: {
            'messaging.system': 'kafka',
            'messaging.operation': 'process',
            'messaging.destination.name': topic,
            'messaging.kafka.consumer.group': groupId,
            'messaging.kafka.partition': partition,
            'messaging.kafka.message.offset': message.offset,
          },
        });

        await otelContext.with(trace.setSpan(otelContext.active(), span), async () => {
          try {
            const envelope = JSON.parse(raw) as Record<string, unknown>;
            const messageId = String(envelope.id ?? `${topic}-${partition}-${message.offset}`);
            span.setAttribute('messaging.message.id', messageId);

            await handle({
              topic,
              partition,
              offset: message.offset,
              messageId,
              key: message.key?.toString() ?? null,
              envelope,
              traceContext,
            });
            messagesConsumed.add(1, { topic, group: groupId, outcome: 'processed' });
          } catch (err) {
            span.recordException(err as Error);
            const attempt = Number(message.headers?.['x-attempt']?.toString() ?? '0') + 1;

            if (dlqTopic && producer && attempt >= maxAttempts) {
              await producer.send({
                topic: dlqTopic,
                messages: [
                  {
                    key: message.key ?? undefined,
                    value: raw,
                    headers: {
                      ...(traceContext.traceparent ? { traceparent: traceContext.traceparent } : {}),
                      'x-attempt': String(attempt),
                      'x-error': (err as Error).message.slice(0, 400),
                      'x-origin-topic': topic,
                    },
                  },
                ],
              });
              messagesConsumed.add(1, { topic, group: groupId, outcome: 'dead-lettered' });
            } else {
              // Not dead-lettered: rethrow so the offset stays uncommitted and
              // Kafka redelivers this message after the retry backoff.
              messagesConsumed.add(1, { topic, group: groupId, outcome: 'failed' });
              span.end();
              throw err;
            }
          }
          span.end();
        });
      });

      // Committing after the work, never before, is the whole guarantee.
      await consumer.commitOffsets([
        { topic, partition, offset: (BigInt(message.offset) + 1n).toString() },
      ]);
    },
  });

  return consumer;
}
