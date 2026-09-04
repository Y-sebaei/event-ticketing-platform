import { randomUUID } from 'node:crypto';
import { captureTraceContext } from '@ticketing/otel';
import type { PoolClient } from 'pg';

export interface OutboxWrite {
  /** 'ordering' or 'inventory' — each service relays only its own schema. */
  schema: 'ordering' | 'inventory';
  aggregateType: string;
  aggregateId: string;
  topic: string;
  messageKey: string;
  payload: Record<string, unknown>;
  /** Supply for idempotent producers; defaults to a fresh uuid. */
  messageId?: string;
  type: string;
}

/**
 * Writes a message into the outbox using the caller's transaction client.
 *
 * The `client` parameter is not a convenience — it is the entire point. The
 * message is inserted in the same transaction as the state change it describes,
 * so there is no window in which an order is marked paid but the fulfilment
 * message was lost, and none in which a message is published for a transaction
 * that later rolled back.
 *
 * The active trace context is captured here, at write time, so the consumer
 * that picks this up minutes later becomes part of the same distributed trace.
 */
export async function enqueueOutbox(client: PoolClient, write: OutboxWrite): Promise<string> {
  const messageId = write.messageId ?? randomUUID();
  const envelope = {
    id: messageId,
    type: write.type,
    occurredAt: new Date().toISOString(),
    ...captureTraceContext(),
    payload: write.payload,
  };

  await client.query(
    `INSERT INTO ${write.schema}.outbox
       (aggregate_type, aggregate_id, topic, message_key, message_id, payload, trace_context)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (message_id) DO NOTHING`,
    [
      write.aggregateType,
      write.aggregateId,
      write.topic,
      write.messageKey,
      messageId,
      JSON.stringify(envelope),
      JSON.stringify(captureTraceContext()),
    ],
  );

  return messageId;
}

export interface OutboxRow {
  id: string;
  topic: string;
  message_key: string;
  message_id: string;
  payload: Record<string, unknown>;
  attempts: number;
}

/**
 * Claims a batch of unpublished rows. `FOR UPDATE SKIP LOCKED` means several
 * relay instances can run at once without ever handing the same row to two of
 * them, which is what lets this scale past one replica unchanged.
 */
export async function claimOutboxBatch(
  client: PoolClient,
  schema: 'ordering' | 'inventory',
  limit: number,
): Promise<OutboxRow[]> {
  const { rows } = await client.query<OutboxRow>(
    `SELECT id, topic, message_key, message_id, payload, attempts
       FROM ${schema}.outbox
      WHERE published_at IS NULL
      ORDER BY id
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [limit],
  );
  return rows;
}

export async function markOutboxPublished(
  client: PoolClient,
  schema: 'ordering' | 'inventory',
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  await client.query(
    `UPDATE ${schema}.outbox SET published_at = now() WHERE id = ANY($1::bigint[])`,
    [ids],
  );
}

export async function markOutboxFailed(
  client: PoolClient,
  schema: 'ordering' | 'inventory',
  id: string,
  error: string,
): Promise<void> {
  await client.query(
    `UPDATE ${schema}.outbox
        SET attempts = attempts + 1, last_error = $2
      WHERE id = $1`,
    [id, error.slice(0, 500)],
  );
}

export async function countPendingOutbox(
  client: { query: PoolClient['query'] },
  schema: 'ordering' | 'inventory',
): Promise<number> {
  const { rows } = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${schema}.outbox WHERE published_at IS NULL`,
  );
  return Number(rows[0]?.count ?? 0);
}
