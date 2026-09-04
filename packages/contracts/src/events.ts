import { z } from 'zod';

/**
 * Kafka contracts live here, next to the .proto, so there is exactly one place
 * to look for "what crosses a boundary".
 *
 * These are JSON with zod validation rather than Avro with a schema registry.
 * The trade-off is deliberate: a registry is a further container, a further
 * failure mode during `docker compose up`, and it would not demonstrate
 * anything this project is trying to show. zod gives us validation at the
 * consumer edge and a TypeScript type from the same declaration, which is the
 * part that actually prevents bugs. A production system with more than one
 * team writing producers should use a registry.
 */

export const TOPICS = {
  ORDER_PAID: 'order.paid',
  ORDER_FULFILLED: 'order.fulfilled',
  EVENT_PUBLISHED: 'catalog.event.published',
  INVENTORY_CHANGED: 'inventory.changed',
  ORDER_FULFILMENT_DLQ: 'order.fulfilment.dlq',
  SEARCH_INDEX_DLQ: 'search.index.dlq',
} as const;

export type TopicName = (typeof TOPICS)[keyof typeof TOPICS];

/**
 * Consumer groups are named constants because they are also the scope of the
 * inbox dedupe key: change one carelessly and every message is reprocessed.
 */
export const CONSUMER_GROUPS = {
  FULFILMENT: 'fulfilment-v1',
  SEARCH_INDEXER: 'search-indexer-v1',
  /**
   * The realtime fan-out group is suffixed per process at runtime. Every API
   * instance must receive every inventory change in order to push it to the
   * browsers connected to that instance, which is the opposite of the usual
   * "share the partitions" arrangement.
   */
  REALTIME_FANOUT_PREFIX: 'realtime-fanout',
} as const;

/**
 * Every message carries W3C trace context. This is the single field that makes
 * a checkout traceable across the async boundary: the producer copies the
 * active `traceparent` in at outbox-write time, the consumer restores it before
 * doing any work, and Tempo stitches the two halves into one trace.
 */
export const envelopeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  occurredAt: z.string().datetime({ offset: true }),
  traceparent: z.string().optional(),
  tracestate: z.string().optional(),
});

export type Envelope = z.infer<typeof envelopeSchema>;

export const orderPaidSchema = envelopeSchema.extend({
  type: z.literal('order.paid'),
  payload: z.object({
    orderId: z.string().uuid(),
    eventId: z.string().uuid(),
    customerEmail: z.string().email(),
    customerName: z.string().min(1),
    currency: z.string().length(3),
    totalCents: z.number().int().nonnegative(),
    paymentReference: z.string().min(1),
    items: z
      .array(
        z.object({
          ticketTypeId: z.string().uuid(),
          name: z.string().min(1),
          quantity: z.number().int().positive(),
          unitPriceCents: z.number().int().nonnegative(),
        }),
      )
      .min(1),
  }),
});
export type OrderPaidMessage = z.infer<typeof orderPaidSchema>;

export const eventPublishedSchema = envelopeSchema.extend({
  type: z.literal('catalog.event.published'),
  payload: z.object({
    eventId: z.string().uuid(),
    title: z.string().min(1),
    description: z.string(),
    startsAt: z.string().datetime({ offset: true }),
    status: z.enum(['draft', 'published', 'cancelled']),
    currency: z.string().length(3),
    venue: z.object({
      id: z.string().uuid(),
      name: z.string().min(1),
      city: z.string().min(1),
      country: z.string().min(1),
    }),
    minPriceCents: z.number().int().nonnegative(),
    maxPriceCents: z.number().int().nonnegative(),
  }),
});
export type EventPublishedMessage = z.infer<typeof eventPublishedSchema>;

export const inventoryChangedSchema = envelopeSchema.extend({
  type: z.literal('inventory.changed'),
  payload: z.object({
    eventId: z.string().uuid(),
    reason: z.enum(['hold', 'commit', 'release', 'register']),
    items: z
      .array(
        z.object({
          ticketTypeId: z.string().uuid(),
          quantityAvailable: z.number().int().nonnegative(),
          quantityTotal: z.number().int().nonnegative(),
        }),
      )
      .min(1),
  }),
});
export type InventoryChangedMessage = z.infer<typeof inventoryChangedSchema>;

export const MESSAGE_SCHEMAS = {
  [TOPICS.ORDER_PAID]: orderPaidSchema,
  [TOPICS.EVENT_PUBLISHED]: eventPublishedSchema,
  [TOPICS.INVENTORY_CHANGED]: inventoryChangedSchema,
} as const;

export const orderFulfilledSchema = envelopeSchema.extend({
  type: z.literal('order.fulfilled'),
  payload: z.object({
    orderId: z.string().uuid(),
    eventId: z.string().uuid(),
    ticketCount: z.number().int().positive(),
    serials: z.array(z.string()).min(1),
  }),
});
export type OrderFulfilledMessage = z.infer<typeof orderFulfilledSchema>;
