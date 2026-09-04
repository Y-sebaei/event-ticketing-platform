import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { TOPICS } from '@ticketing/contracts';
import { withSpan } from '@ticketing/otel';
import { enqueueOutbox, withTransaction, type Pool } from '@ticketing/platform';
import { PG_POOL } from '../common/infra.module';
import { InventoryClient } from '../common/inventory.client';
import type { CreateEventInput } from './catalog.dto';

export interface EventSummary {
  id: string;
  slug: string;
  title: string;
  description: string;
  startsAt: string;
  status: string;
  currency: string;
  serviceFeeBps: number;
  venue: { id: string; name: string; city: string; country: string; addressLine: string };
  minPriceCents: number;
  maxPriceCents: number;
}

export interface TicketTypeView {
  id: string;
  name: string;
  priceCents: number;
  maxPerOrder: number;
  salesStartAt: string;
  salesEndAt: string;
  quantityTotal: number;
  quantityAvailable: number;
}

const EVENT_SELECT = `
  SELECT e.id, e.slug, e.title, e.description, e.starts_at, e.status, e.currency, e.service_fee_bps,
         v.id AS venue_id, v.name AS venue_name, v.city, v.country, v.address_line,
         COALESCE(MIN(t.price_cents), 0) AS min_price_cents,
         COALESCE(MAX(t.price_cents), 0) AS max_price_cents
    FROM catalog.event e
    JOIN catalog.venue v ON v.id = e.venue_id
    LEFT JOIN catalog.ticket_type t ON t.event_id = e.id
`;

/* eslint-disable @typescript-eslint/no-explicit-any */
function toSummary(row: any): EventSummary {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    startsAt: new Date(row.starts_at).toISOString(),
    status: row.status,
    currency: row.currency,
    serviceFeeBps: row.service_fee_bps,
    venue: {
      id: row.venue_id,
      name: row.venue_name,
      city: row.city,
      country: row.country,
      addressLine: row.address_line,
    },
    minPriceCents: Number(row.min_price_cents),
    maxPriceCents: Number(row.max_price_cents),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly inventory: InventoryClient,
  ) {}

  /** The database-backed listing. Also the fallback when search is degraded. */
  async listEvents(limit = 24): Promise<EventSummary[]> {
    const { rows } = await this.pool.query(
      `${EVENT_SELECT}
        WHERE e.status = 'published'
        GROUP BY e.id, v.id
        ORDER BY e.starts_at ASC
        LIMIT $1`,
      [limit],
    );
    return rows.map(toSummary);
  }

  async getEventBySlug(slug: string): Promise<EventSummary & { ticketTypes: TicketTypeView[] }> {
    const { rows } = await this.pool.query(
      `${EVENT_SELECT} WHERE e.slug = $1 GROUP BY e.id, v.id`,
      [slug],
    );
    const row = rows[0];
    if (!row) throw new NotFoundException({ error: 'EVENT_NOT_FOUND', slug });

    const event = toSummary(row);
    const ticketTypes = await this.ticketTypesFor(event.id);
    return { ...event, ticketTypes };
  }

  /**
   * Ticket type rows come from the catalog; the counts come from the inventory
   * service over gRPC. The catalog deliberately does not keep its own copy of
   * "how many are left" — one writer, one truth.
   *
   * If inventory is unreachable the page still renders with the counts blanked
   * rather than 500-ing, because a browse page that cannot show availability is
   * still more useful than an error.
   */
  async ticketTypesFor(eventId: string): Promise<TicketTypeView[]> {
    const { rows } = await this.pool.query(
      `SELECT id, name, price_cents, max_per_order, sales_start_at, sales_end_at, quantity_total
         FROM catalog.ticket_type WHERE event_id = $1 ORDER BY price_cents ASC`,
      [eventId],
    );

    let availability = new Map<string, number>();
    try {
      const response = await this.inventory.availabilityForEvent(eventId);
      availability = new Map(response.items.map((i) => [i.ticketTypeId, i.quantityAvailable]));
    } catch (err) {
      this.logger.warn(`inventory unavailable for event ${eventId}: ${(err as Error).message}`);
    }

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      priceCents: r.price_cents,
      maxPerOrder: r.max_per_order,
      salesStartAt: new Date(r.sales_start_at).toISOString(),
      salesEndAt: new Date(r.sales_end_at).toISOString(),
      quantityTotal: r.quantity_total,
      quantityAvailable: availability.get(r.id) ?? r.quantity_total,
    }));
  }

  /**
   * Creates an event and puts it on sale.
   *
   * The sequence matters and is not arbitrary:
   *
   *   1. Write the catalog rows in one transaction, as `draft`. Ids are
   *      generated here rather than by the database so step 2 can use them.
   *   2. Register the ticket types with the inventory service over gRPC. This
   *      is the one cross-service call allowed to fail the whole operation:
   *      publishing an event whose inventory nobody is tracking would let it
   *      oversell without limit. A failure here leaves a draft, which is
   *      recoverable, rather than a live event that cannot be sold safely.
   *   3. Flip to `published` and write the search-index message to the outbox,
   *      in one transaction.
   *
   * Note what step 3 does *not* do: it does not talk to Elasticsearch. Indexing
   * happens later, in the worker, off the back of the outbox row. That is what
   * makes a failed index write unable to fail event creation.
   */
  async createEvent(input: CreateEventInput): Promise<EventSummary> {
    return withSpan('catalog.createEvent', { 'event.slug': input.slug }, async (span) => {
      // Creation is idempotent on the slug so the seed script can be re-run and
      // the end-to-end tests can create their fixtures without cleaning up
      // first. Returning the existing event beats a 409 nobody handles.
      const existing = await this.pool.query(`${EVENT_SELECT} WHERE e.slug = $1 GROUP BY e.id, v.id`, [
        input.slug,
      ]);
      if (existing.rows.length > 0) {
        span.setAttribute('catalog.create.replayed', true);
        return toSummary(existing.rows[0]);
      }

      const eventId = randomUUID();
      const ticketTypeIds = input.ticketTypes.map(() => randomUUID());

      await withTransaction(this.pool, async (client) => {
        const venue = await client.query<{ id: string }>(
          `INSERT INTO catalog.venue (slug, name, address_line, city, country, latitude, longitude, capacity)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
          [
            input.venue.slug,
            input.venue.name,
            input.venue.addressLine,
            input.venue.city,
            input.venue.country,
            input.venue.latitude ?? null,
            input.venue.longitude ?? null,
            input.venue.capacity,
          ],
        );
        const venueId = venue.rows[0]!.id;

        await client.query(
          `INSERT INTO catalog.event
             (id, venue_id, slug, title, description, starts_at, doors_at, status, service_fee_bps, currency)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', $8, $9)
           ON CONFLICT (slug) DO NOTHING`,
          [
            eventId,
            venueId,
            input.slug,
            input.title,
            input.description,
            input.startsAt,
            input.doorsAt ?? null,
            input.serviceFeeBps,
            input.currency,
          ],
        );

        for (const [index, ticketType] of input.ticketTypes.entries()) {
          await client.query(
            `INSERT INTO catalog.ticket_type
               (id, event_id, name, price_cents, quantity_total, max_per_order, sales_start_at, sales_end_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (event_id, name) DO NOTHING`,
            [
              ticketTypeIds[index],
              eventId,
              ticketType.name,
              ticketType.priceCents,
              ticketType.quantityTotal,
              ticketType.maxPerOrder,
              ticketType.salesStartAt,
              ticketType.salesEndAt,
            ],
          );
        }
      });

      for (const [index, ticketType] of input.ticketTypes.entries()) {
        await this.inventory.registerTicketType({
          ticketTypeId: ticketTypeIds[index]!,
          eventId,
          quantityTotal: ticketType.quantityTotal,
        });
      }

      const published = await withTransaction(this.pool, async (client) => {
        await client.query(
          `UPDATE catalog.event SET status = 'published', updated_at = now() WHERE id = $1`,
          [eventId],
        );
        const { rows } = await client.query(`${EVENT_SELECT} WHERE e.id = $1 GROUP BY e.id, v.id`, [
          eventId,
        ]);
        const summary = toSummary(rows[0]);

        await enqueueOutbox(client, {
          schema: 'ordering',
          aggregateType: 'event',
          aggregateId: eventId,
          topic: TOPICS.EVENT_PUBLISHED,
          messageKey: eventId,
          type: 'catalog.event.published',
          payload: {
            eventId: summary.id,
            title: summary.title,
            description: summary.description,
            startsAt: summary.startsAt,
            status: 'published',
            currency: summary.currency,
            venue: {
              id: summary.venue.id,
              name: summary.venue.name,
              city: summary.venue.city,
              country: summary.venue.country,
            },
            minPriceCents: summary.minPriceCents,
            maxPriceCents: summary.maxPriceCents,
          },
        });

        return summary;
      });

      span.setAttribute('event.id', eventId);
      return published;
    });
  }
}
