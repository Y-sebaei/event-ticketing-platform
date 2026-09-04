import { Client as ElasticClient } from '@elastic/elasticsearch';
import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import {
  CONSUMER_GROUPS,
  EVENTS_INDEX,
  EVENTS_INDEX_MAPPING,
  TOPICS,
  eventPublishedSchema,
  type EventDocument,
} from '@ticketing/contracts';
import { searchIndexFailures, withSpan } from '@ticketing/otel';
import { createKafka, startConsumer, type Consumer, type Pool, type Producer } from '@ticketing/platform';
import { ELASTIC_CLIENT, KAFKA_PRODUCER, PG_POOL } from '../tokens';

/**
 * The indexing path, and the answer to "what happens when indexing fails".
 *
 * Event creation never writes to Elasticsearch. It writes a row to the outbox
 * in the same transaction that publishes the event, and returns. This consumer
 * picks that row up and indexes it. So:
 *
 *   - Elasticsearch down at creation time: the event is created, the message
 *     waits in Kafka, and it is indexed when Elasticsearch comes back. Nobody
 *     loses an event because search was restarting.
 *   - Indexing fails repeatedly: after five attempts the message goes to
 *     `search.index.dlq` with the error attached, and the offset advances so
 *     one poisoned document cannot block every event behind it.
 *   - Index lost entirely: `reindexAll` rebuilds it from Postgres, which stays
 *     the source of truth.
 *
 * The cost is that a newly created event is searchable a second or two later
 * rather than instantly, which for a ticketing catalog is not a cost at all.
 */
@Injectable()
export class SearchIndexerConsumer implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(SearchIndexerConsumer.name);
  private consumer?: Consumer;

  constructor(
    @Inject(ELASTIC_CLIENT) private readonly elastic: ElasticClient,
    @Inject(KAFKA_PRODUCER) private readonly producer: Producer,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureIndex();

    this.consumer = await startConsumer({
      kafka: createKafka('worker-search'),
      groupId: CONSUMER_GROUPS.SEARCH_INDEXER,
      topics: [TOPICS.EVENT_PUBLISHED],
      dlqTopic: TOPICS.SEARCH_INDEX_DLQ,
      producer: this.producer,
      maxAttempts: 5,
      handle: (message) => this.index(message.envelope),
    });

    this.logger.log(`consuming ${TOPICS.EVENT_PUBLISHED} as ${CONSUMER_GROUPS.SEARCH_INDEXER}`);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.consumer?.disconnect().catch(() => {});
  }

  /** Creates the index with its mapping if it is missing. Safe to call repeatedly. */
  private async ensureIndex(): Promise<void> {
    for (let attempt = 1; attempt <= 30; attempt++) {
      try {
        const exists = await this.elastic.indices.exists({ index: EVENTS_INDEX });
        if (!exists) {
          await this.elastic.indices.create({
            index: EVENTS_INDEX,
            ...(EVENTS_INDEX_MAPPING as object),
          });
          this.logger.log(`created index ${EVENTS_INDEX}`);
        }
        return;
      } catch (err) {
        if (attempt === 30) {
          // Not fatal. The consumer still starts, indexing fails, messages
          // retry, and the API serves its database fallback in the meantime.
          this.logger.error(`could not prepare index after 30 attempts: ${(err as Error).message}`);
          return;
        }
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
  }

  async index(envelope: unknown): Promise<void> {
    const message = eventPublishedSchema.parse(envelope);
    const payload = message.payload;

    await withSpan('search.index', { 'event.id': payload.eventId }, async () => {
      const document: EventDocument = {
        eventId: payload.eventId,
        slug: await this.slugFor(payload.eventId),
        title: payload.title,
        description: payload.description,
        startsAt: payload.startsAt,
        status: payload.status,
        currency: payload.currency,
        venueId: payload.venue.id,
        venueName: payload.venue.name,
        city: payload.venue.city,
        country: payload.venue.country,
        minPriceCents: payload.minPriceCents,
        maxPriceCents: payload.maxPriceCents,
        indexedAt: new Date().toISOString(),
      };

      try {
        await this.elastic.index({
          index: EVENTS_INDEX,
          // The event id is the document id, so re-indexing the same event
          // overwrites rather than duplicating — this consumer is idempotent
          // without needing the inbox table.
          id: payload.eventId,
          document,
          refresh: 'wait_for',
        });
      } catch (err) {
        searchIndexFailures.add(1, { reason: (err as Error).name });
        throw err;
      }
    });
  }

  private async slugFor(eventId: string): Promise<string> {
    const { rows } = await this.pool.query<{ slug: string }>(
      `SELECT slug FROM catalog.event WHERE id = $1`,
      [eventId],
    );
    return rows[0]?.slug ?? eventId;
  }

  /** Rebuilds the whole index from Postgres. Exposed for the reindex script. */
  async reindexAll(): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT e.id, e.slug, e.title, e.description, e.starts_at, e.status, e.currency,
              v.id AS venue_id, v.name AS venue_name, v.city, v.country,
              COALESCE(MIN(t.price_cents), 0) AS min_price_cents,
              COALESCE(MAX(t.price_cents), 0) AS max_price_cents
         FROM catalog.event e
         JOIN catalog.venue v ON v.id = e.venue_id
         LEFT JOIN catalog.ticket_type t ON t.event_id = e.id
        WHERE e.status = 'published'
        GROUP BY e.id, v.id`,
    );

    if (rows.length === 0) return 0;

    await this.elastic.bulk({
      refresh: true,
      operations: rows.flatMap((r) => [
        { index: { _index: EVENTS_INDEX, _id: r.id } },
        {
          eventId: r.id,
          slug: r.slug,
          title: r.title,
          description: r.description,
          startsAt: new Date(r.starts_at).toISOString(),
          status: r.status,
          currency: r.currency,
          venueId: r.venue_id,
          venueName: r.venue_name,
          city: r.city,
          country: r.country,
          minPriceCents: Number(r.min_price_cents),
          maxPriceCents: Number(r.max_price_cents),
          indexedAt: new Date().toISOString(),
        },
      ]),
    });

    this.logger.log(`reindexed ${rows.length} event(s)`);
    return rows.length;
  }
}
