import { duplicatesSuppressed } from '@ticketing/otel';
import type { PoolClient } from 'pg';

/**
 * The consumer inbox.
 *
 * Called inside the same transaction as the work it guards. Returns false when
 * this consumer group has already processed this message, in which case the
 * caller must do nothing and still commit — committing is what lets the offset
 * advance past a duplicate instead of retrying it forever.
 */
export async function claimMessage(
  client: PoolClient,
  input: { consumerGroup: string; messageId: string; topic: string },
): Promise<boolean> {
  const { rowCount } = await client.query(
    `INSERT INTO ordering.processed_message (consumer_group, message_id, topic)
     VALUES ($1, $2, $3)
     ON CONFLICT (consumer_group, message_id) DO NOTHING`,
    [input.consumerGroup, input.messageId, input.topic],
  );

  const claimed = (rowCount ?? 0) > 0;
  if (!claimed) {
    duplicatesSuppressed.add(1, { guard: 'inbox', group: input.consumerGroup, topic: input.topic });
  }
  return claimed;
}
