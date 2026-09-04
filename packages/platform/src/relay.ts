import { outboxPending } from '@ticketing/otel';
import type { Pool } from 'pg';
import { publish, type Producer } from './kafka';
import { claimOutboxBatch, countPendingOutbox, markOutboxFailed, markOutboxPublished } from './outbox';
import { withTransaction } from './pool';

export interface RelayOptions {
  pool: Pool;
  producer: Producer;
  schema: 'ordering' | 'inventory';
  intervalMs?: number;
  batchSize?: number;
  onError?: (err: Error) => void;
}

/**
 * Polls the outbox and publishes to Kafka.
 *
 * Polling rather than logical replication is a deliberate simplification: it is
 * one file with no Debezium container, and at this scale the added latency is a
 * few hundred milliseconds. The properties that matter — nothing published for
 * a rolled-back transaction, nothing lost when the relay dies — come from the
 * outbox table itself, not from how it is read.
 *
 * A publish that succeeds but whose `published_at` update then fails will
 * republish on the next tick. That is fine: every consumer is idempotent, which
 * is exactly the assumption this design is built on.
 */
export class OutboxRelay {
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;

  constructor(private readonly options: RelayOptions) {}

  start(): void {
    const interval = this.options.intervalMs ?? 500;
    const pool = this.options.pool;
    const schema = this.options.schema;

    // Reports backlog depth even while the relay is idle, so a stalled relay is
    // visible on the dashboard rather than inferred from missing orders.
    outboxPending.addCallback(async (result) => {
      try {
        const pending = await countPendingOutbox(pool, schema);
        result.observe(pending, { schema });
      } catch {
        /* the readiness probe already covers a dead database */
      }
    });

    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    // Let an in-flight tick finish so a shutdown does not strand a claimed row.
    for (let i = 0; i < 50 && this.running; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async tick(): Promise<number> {
    if (this.running || this.stopped) return 0;
    this.running = true;
    try {
      return await withTransaction(this.options.pool, async (client) => {
        const rows = await claimOutboxBatch(client, this.options.schema, this.options.batchSize ?? 100);
        if (rows.length === 0) return 0;

        const published: string[] = [];
        for (const row of rows) {
          try {
            const envelope = row.payload;
            await publish(this.options.producer, {
              topic: row.topic,
              key: row.message_key,
              value: envelope,
              traceContext: {
                traceparent: envelope.traceparent as string | undefined,
                tracestate: envelope.tracestate as string | undefined,
              },
            });
            published.push(row.id);
          } catch (err) {
            await markOutboxFailed(client, this.options.schema, row.id, (err as Error).message);
            this.options.onError?.(err as Error);
            // Stop at the first failure so ordering per aggregate is preserved.
            break;
          }
        }

        await markOutboxPublished(client, this.options.schema, published);
        return published.length;
      });
    } catch (err) {
      this.options.onError?.(err as Error);
      return 0;
    } finally {
      this.running = false;
    }
  }
}
