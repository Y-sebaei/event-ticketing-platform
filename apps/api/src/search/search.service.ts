import { Client as ElasticClient } from '@elastic/elasticsearch';
import type { QueryDslQueryContainer } from '@elastic/elasticsearch/lib/api/types';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { EVENTS_INDEX, type EventDocument } from '@ticketing/contracts';
import { withSpan } from '@ticketing/otel';
import type { Pool } from '@ticketing/platform';
import { z } from 'zod';
import { ELASTIC_CLIENT, PG_POOL } from '../common/tokens';

export const searchQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  city: z.string().trim().max(80).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  minPriceCents: z.coerce.number().int().nonnegative().optional(),
  maxPriceCents: z.coerce.number().int().nonnegative().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(12),
  sort: z.enum(['relevance', 'date', 'price']).default('relevance'),
});

export type SearchQuery = z.infer<typeof searchQuerySchema>;

export interface SearchResult {
  items: EventDocument[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  /** 'search' or 'database' — surfaced so a degraded page is visible, not silent. */
  source: 'search' | 'database';
}

/**
 * Elasticsearch caps `from + size` at 10,000 by default. Rather than let a
 * crawler walk off that cliff into a 500, page 834 is the last page there is,
 * and the API says so.
 */
const MAX_RESULT_WINDOW = 10_000;

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(
    @Inject(ELASTIC_CLIENT) private readonly elastic: ElasticClient,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  async search(query: SearchQuery): Promise<SearchResult> {
    return withSpan(
      'search.events',
      { 'search.query': query.q ?? '', 'search.city': query.city ?? '', 'search.page': query.page },
      async (span) => {
        try {
          const result = await this.searchElastic(query);
          span.setAttribute('search.source', 'search');
          span.setAttribute('search.total', result.total);
          return result;
        } catch (err) {
          // Search being down must not take browse down with it. The fallback
          // loses ranking and free-text matching, and says so in `source`, so a
          // degraded result is never mistaken for an empty one.
          this.logger.warn(`falling back to database listing: ${(err as Error).message}`);
          span.setAttribute('search.source', 'database');
          span.setAttribute('search.fallback_reason', (err as Error).message.slice(0, 120));
          return this.searchDatabase(query);
        }
      },
    );
  }

  private async searchElastic(query: SearchQuery): Promise<SearchResult> {
    const from = (query.page - 1) * query.pageSize;
    if (from + query.pageSize > MAX_RESULT_WINDOW) {
      return { items: [], total: 0, page: query.page, pageSize: query.pageSize, totalPages: 0, source: 'search' };
    }

    const filter: QueryDslQueryContainer[] = [{ term: { status: 'published' } }];
    if (query.city) filter.push({ term: { city: query.city } });
    if (query.from || query.to) {
      filter.push({
        range: { startsAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } },
      });
    }
    // Price filtering compares against the event's cheapest and dearest ticket,
    // so "under 30 euro" means "has something under 30 euro" rather than
    // "everything is under 30 euro" — which is what a customer means.
    if (query.minPriceCents !== undefined) filter.push({ range: { maxPriceCents: { gte: query.minPriceCents } } });
    if (query.maxPriceCents !== undefined) filter.push({ range: { minPriceCents: { lte: query.maxPriceCents } } });

    const must: QueryDslQueryContainer[] = query.q
      ? [
          {
            multi_match: {
              query: query.q,
              // Title matters more than description, and the venue name is a
              // legitimate way for someone to find a gig they half-remember.
              fields: ['title^3', 'venueName^2', 'description'],
              fuzziness: 'AUTO',
              operator: 'and',
            },
          },
        ]
      : [{ match_all: {} }];

    const sort =
      query.sort === 'date'
        ? [{ startsAt: 'asc' as const }]
        : query.sort === 'price'
          ? [{ minPriceCents: 'asc' as const }]
          : query.q
            ? ['_score' as const, { startsAt: 'asc' as const }]
            : [{ startsAt: 'asc' as const }];

    const response = await this.elastic.search<EventDocument>({
      index: EVENTS_INDEX,
      from,
      size: query.pageSize,
      // An accurate total is what makes "page 7 of 12" honest instead of
      // approximate, and at this catalog size it costs nothing.
      track_total_hits: true,
      query: { bool: { must, filter } },
      sort,
    });

    const total =
      typeof response.hits.total === 'number' ? response.hits.total : (response.hits.total?.value ?? 0);

    return {
      items: response.hits.hits.map((hit) => hit._source!).filter(Boolean),
      total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.max(1, Math.ceil(Math.min(total, MAX_RESULT_WINDOW) / query.pageSize)),
      source: 'search',
    };
  }

  /**
   * The degraded path. ILIKE over title and description is not full-text search
   * — no ranking, no fuzziness, no stemming — but it keeps the site browsable
   * while Elasticsearch is restarting, which on a laptop is most of the first
   * minute after `docker compose up`.
   */
  private async searchDatabase(query: SearchQuery): Promise<SearchResult> {
    const conditions: string[] = [`e.status = 'published'`];
    const params: unknown[] = [];

    if (query.q) {
      params.push(`%${query.q}%`);
      conditions.push(`(e.title ILIKE $${params.length} OR e.description ILIKE $${params.length})`);
    }
    if (query.city) {
      params.push(query.city);
      conditions.push(`v.city = $${params.length}`);
    }
    if (query.from) {
      params.push(query.from);
      conditions.push(`e.starts_at >= $${params.length}`);
    }
    if (query.to) {
      params.push(query.to);
      conditions.push(`e.starts_at <= $${params.length}`);
    }

    const where = conditions.join(' AND ');
    const countResult = await this.pool.query<{ count: string }>(
      `SELECT count(DISTINCT e.id)::text AS count
         FROM catalog.event e JOIN catalog.venue v ON v.id = e.venue_id
        WHERE ${where}`,
      params,
    );
    const total = Number(countResult.rows[0]?.count ?? 0);

    params.push(query.pageSize, (query.page - 1) * query.pageSize);
    const { rows } = await this.pool.query(
      `SELECT e.id, e.slug, e.title, e.description, e.starts_at, e.status, e.currency,
              v.id AS venue_id, v.name AS venue_name, v.city, v.country,
              COALESCE(MIN(t.price_cents), 0) AS min_price_cents,
              COALESCE(MAX(t.price_cents), 0) AS max_price_cents
         FROM catalog.event e
         JOIN catalog.venue v ON v.id = e.venue_id
         LEFT JOIN catalog.ticket_type t ON t.event_id = e.id
        WHERE ${where}
        GROUP BY e.id, v.id
        ORDER BY e.starts_at ASC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return {
      items: rows.map((r) => ({
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
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      source: 'database',
    };
  }

  /** Distinct cities, for the filter dropdown. Cheap enough to read from Postgres. */
  async cities(): Promise<string[]> {
    const { rows } = await this.pool.query<{ city: string }>(
      `SELECT DISTINCT v.city
         FROM catalog.venue v JOIN catalog.event e ON e.venue_id = v.id
        WHERE e.status = 'published'
        ORDER BY v.city`,
    );
    return rows.map((r) => r.city);
  }
}
