import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { CONSUMER_GROUPS, TOPICS, orderPaidSchema } from '@ticketing/contracts';
import { ticketSerial, transition, type OrderStatus } from '@ticketing/domain';
import { ticketsIssued, withSpan } from '@ticketing/otel';
import {
  claimMessage,
  createKafka,
  enqueueOutbox,
  startConsumer,
  withTransaction,
  type Consumer,
  type Pool,
  type Producer,
} from '@ticketing/platform';
import { KAFKA_PRODUCER, PG_POOL } from '../tokens';
import { InventoryClient } from '../inventory.client';
import { Mailer } from '../mailer';

/**
 * Turns a paid order into tickets.
 *
 * The ordering of the three steps is the whole design, and it is not
 * interchangeable:
 *
 *   1. Commit the inventory hold over gRPC.
 *   2. In one Postgres transaction: claim the message in the inbox, insert the
 *      tickets, mark the order fulfilled, and enqueue `order.fulfilled`.
 *   3. Only then commit the Kafka offset (done by the consumer runner).
 *
 * Step 1 has to come first. If the inbox claim happened before the inventory
 * commit, then a crash in between would leave a message marked processed whose
 * inventory was never committed — and the redelivery would skip it forever.
 * Committing inventory first is safe precisely because that call is idempotent:
 * running it twice produces the same numbers.
 *
 * Kill this process at any point and Kafka redelivers, because the offset is
 * only advanced after step 2 commits. The redelivery either repeats a no-op
 * gRPC call and then finds the inbox row already present, or it finds nothing
 * done and does all of it. There is no ordering of a crash that issues a ticket
 * twice or drops one.
 */
@Injectable()
export class FulfilmentConsumer implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(FulfilmentConsumer.name);
  private consumer?: Consumer;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(KAFKA_PRODUCER) private readonly producer: Producer,
    private readonly inventory: InventoryClient,
    private readonly mailer: Mailer,
  ) {}

  async onModuleInit(): Promise<void> {
    this.consumer = await startConsumer({
      kafka: createKafka('worker-fulfilment'),
      groupId: CONSUMER_GROUPS.FULFILMENT,
      topics: [TOPICS.ORDER_PAID],
      dlqTopic: TOPICS.ORDER_FULFILMENT_DLQ,
      producer: this.producer,
      maxAttempts: 5,
      handle: (message) => this.handle(message.envelope),
    });
    this.logger.log(`consuming ${TOPICS.ORDER_PAID} as ${CONSUMER_GROUPS.FULFILMENT}`);
  }

  async onApplicationShutdown(): Promise<void> {
    // Lets an in-flight message finish before the process exits, so a normal
    // restart does not rely on the redelivery path.
    await this.consumer?.disconnect().catch(() => {});
  }

  async handle(envelope: unknown): Promise<void> {
    const message = orderPaidSchema.parse(envelope);
    const { orderId, eventId, items } = message.payload;

    await withSpan(
      'fulfilment.issueTickets',
      { 'order.id': orderId, 'event.id': eventId, 'messaging.message.id': message.id },
      async (span) => {
        // Step 1: idempotent, and it must happen before the inbox claim.
        await this.inventory.commit(orderId);

        const issued = await withTransaction(this.pool, async (client) => {
          // Step 2, guard 3 of three.
          const claimed = await claimMessage(client, {
            consumerGroup: CONSUMER_GROUPS.FULFILMENT,
            messageId: message.id,
            topic: TOPICS.ORDER_PAID,
          });

          if (!claimed) {
            span.setAttribute('fulfilment.replayed', true);
            this.logger.log(`order ${orderId} already fulfilled; skipping replay ${message.id}`);
            return null;
          }

          const serials: string[] = [];
          for (const item of items) {
            for (let seq = 1; seq <= item.quantity; seq++) {
              const serial = ticketSerial(orderId, item.ticketTypeId, seq);
              const qrToken = createHash('sha256').update(`${serial}:${orderId}`).digest('base64url');

              // Deterministic serials plus ON CONFLICT DO NOTHING mean this
              // insert is safe even if every guard above were removed. The
              // unique index is the thing that actually enforces it.
              await client.query(
                `INSERT INTO ordering.ticket (order_id, ticket_type_id, seq, serial, qr_token)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (order_id, ticket_type_id, seq) DO NOTHING`,
                [orderId, item.ticketTypeId, seq, serial, qrToken],
              );
              serials.push(serial);
            }
          }

          const current = await client.query<{ status: OrderStatus }>(
            `SELECT status FROM ordering.customer_order WHERE id = $1 FOR UPDATE`,
            [orderId],
          );
          const next = transition(current.rows[0]!.status, 'fulfilled');
          if (next.changed) {
            await client.query(
              `UPDATE ordering.customer_order
                  SET status = 'fulfilled', fulfilled_at = now(), updated_at = now()
                WHERE id = $1`,
              [orderId],
            );
          }

          // Announced through the outbox in the same transaction, so the
          // confirmation page's WebSocket update cannot arrive for tickets that
          // were rolled back.
          await enqueueOutbox(client, {
            schema: 'ordering',
            aggregateType: 'order',
            aggregateId: orderId,
            topic: TOPICS.ORDER_FULFILLED,
            messageKey: orderId,
            type: 'order.fulfilled',
            payload: { orderId, eventId, ticketCount: serials.length, serials },
          });

          return serials;
        });

        if (!issued) return;

        ticketsIssued.add(issued.length, { event_id: eventId });
        span.setAttribute('tickets.issued', issued.length);
        this.logger.log(`issued ${issued.length} ticket(s) for order ${orderId}`);

        // Step 3 is the offset commit, handled by the consumer runner once this
        // returns. Email comes after the transaction and never blocks it.
        await this.mailer.sendConfirmation({
          to: message.payload.customerEmail,
          name: message.payload.customerName,
          orderId,
          // Fallback covers messages produced before eventTitle was added.
          eventTitle: message.payload.eventTitle ?? 'your event',
          serials: issued,
          totalCents: message.payload.totalCents,
          currency: message.payload.currency,
        });
      },
    );
  }
}
