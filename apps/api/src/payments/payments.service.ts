import { Inject, Injectable, Logger } from '@nestjs/common';
import { TOPICS } from '@ticketing/contracts';
import { transition, type OrderStatus } from '@ticketing/domain';
import { duplicatesSuppressed, ordersPaid, withSpan } from '@ticketing/otel';
import { enqueueOutbox, withTransaction, type Pool } from '@ticketing/platform';
import { PG_POOL } from '../common/tokens';
import { InventoryClient } from '../common/inventory.client';
import type { PaymentEvent } from './payment-gateway';

interface OrderRow {
  id: string;
  event_id: string;
  status: OrderStatus;
  total_cents: number;
  currency: string;
  email: string;
  name: string;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly inventory: InventoryClient,
  ) {}

  /**
   * Handles one verified payment event.
   *
   * Guard 2 of three lives here: the provider event id is the primary key of
   * `ordering.webhook_event`, so a replayed webhook — and Stripe will replay,
   * for days, until it gets a 2xx — inserts nothing and does nothing. It still
   * returns 200, because answering a replay with an error would make the
   * provider retry it forever.
   */
  async handle(event: PaymentEvent): Promise<{ duplicate: boolean; orderId?: string }> {
    return withSpan(
      'payments.handleWebhook',
      { 'payment.event.id': event.id, 'payment.event.type': event.type },
      async (span) => {
        const claimed = await this.pool.query(
          `INSERT INTO ordering.webhook_event (provider_event_id, provider, type, payload)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (provider_event_id) DO NOTHING`,
          [event.id, 'gateway', event.type, JSON.stringify(event)],
        );

        if ((claimed.rowCount ?? 0) === 0) {
          duplicatesSuppressed.add(1, { guard: 'webhook', type: event.type });
          span.setAttribute('payment.replayed', true);
          this.logger.log(`ignoring replayed webhook ${event.id}`);
          return { duplicate: true };
        }

        const order = await this.findOrder(event);
        if (!order) {
          this.logger.warn(`webhook ${event.id} references unknown session ${event.sessionId}`);
          await this.markHandled(event.id, 'order_not_found');
          return { duplicate: false };
        }

        span.setAttribute('order.id', order.id);

        switch (event.type) {
          case 'payment.succeeded':
            await this.markPaid(order, event);
            break;
          case 'payment.failed':
            await this.finish(order, 'failed', event.detail ?? 'declined');
            break;
          case 'session.expired':
            await this.finish(order, 'expired', 'session_expired');
            break;
        }

        await this.markHandled(event.id, null);
        return { duplicate: false, orderId: order.id };
      },
    );
  }

  private async findOrder(event: PaymentEvent): Promise<OrderRow | null> {
    const { rows } = await this.pool.query<OrderRow>(
      `SELECT o.id, o.event_id, o.status, o.total_cents, o.currency, c.email, c.name
         FROM ordering.customer_order o
         JOIN ordering.customer c ON c.id = o.customer_id
        WHERE o.payment_session_id = $1 OR o.id = $2::uuid
        LIMIT 1`,
      [event.sessionId, event.orderId ?? null],
    );
    return rows[0] ?? null;
  }

  private async markHandled(eventId: string, error: string | null): Promise<void> {
    await this.pool.query(
      `UPDATE ordering.webhook_event SET handled_at = now(), error = $2 WHERE provider_event_id = $1`,
      [eventId, error],
    );
  }

  /**
   * Marks the order paid and enqueues `order.paid` — in one transaction.
   *
   * This is the most important transaction in the codebase. If the status
   * update committed without the outbox row, the customer would be charged and
   * never receive tickets. If the outbox row committed without the status
   * update, tickets would be issued for an unpaid order. Both are ordinary
   * statements against the same database, so one transaction makes the pair
   * atomic with no distributed-transaction machinery at all.
   */
  private async markPaid(order: OrderRow, event: PaymentEvent): Promise<void> {
    const changed = await withTransaction(this.pool, async (client) => {
      const locked = await client.query<{ status: OrderStatus }>(
        `SELECT status FROM ordering.customer_order WHERE id = $1 FOR UPDATE`,
        [order.id],
      );
      const next = transition(locked.rows[0]!.status, 'paid');
      if (!next.changed) return false;

      await client.query(
        `UPDATE ordering.customer_order
            SET status = 'paid', paid_at = now(), updated_at = now(),
                payment_intent_id = COALESCE($2, payment_intent_id),
                payment_status_detail = $3
          WHERE id = $1`,
        [order.id, event.paymentIntentId ?? null, event.detail ?? 'paid'],
      );

      const items = await client.query<{
        ticket_type_id: string;
        name_snapshot: string;
        quantity: number;
        unit_price_cents: number;
      }>(
        `SELECT ticket_type_id, name_snapshot, quantity, unit_price_cents
           FROM ordering.order_item WHERE order_id = $1 ORDER BY ticket_type_id`,
        [order.id],
      );

      await enqueueOutbox(client, {
        schema: 'ordering',
        aggregateType: 'order',
        aggregateId: order.id,
        topic: TOPICS.ORDER_PAID,
        // Keying by order id puts every message for one order on one partition,
        // so they are consumed in the order they were produced.
        messageKey: order.id,
        type: 'order.paid',
        payload: {
          orderId: order.id,
          eventId: order.event_id,
          customerEmail: order.email,
          customerName: order.name,
          currency: order.currency,
          totalCents: order.total_cents,
          paymentReference: event.paymentIntentId ?? event.sessionId,
          items: items.rows.map((i) => ({
            ticketTypeId: i.ticket_type_id,
            name: i.name_snapshot,
            quantity: i.quantity,
            unitPriceCents: i.unit_price_cents,
          })),
        },
      });

      return true;
    });

    if (changed) {
      ordersPaid.add(1, { currency: order.currency });
      this.logger.log(`order ${order.id} paid; order.paid enqueued`);
    }
  }

  /**
   * Declined or expired. The status change is transactional; releasing the hold
   * is a separate gRPC call that is allowed to fail — the reservation has a TTL
   * and the inventory sweeper collects it either way. Making the release
   * best-effort stops a flaky inventory service from turning a declined card
   * into a 500 that the provider then retries for days.
   */
  private async finish(order: OrderRow, status: 'failed' | 'expired', detail: string): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const locked = await client.query<{ status: OrderStatus }>(
        `SELECT status FROM ordering.customer_order WHERE id = $1 FOR UPDATE`,
        [order.id],
      );
      const next = transition(locked.rows[0]!.status, status);
      if (!next.changed) return;

      await client.query(
        `UPDATE ordering.customer_order
            SET status = $2, payment_status_detail = $3, updated_at = now()
          WHERE id = $1`,
        [order.id, status, detail],
      );
    });

    try {
      await this.inventory.release(order.id, status === 'expired' ? 'expired' : 'payment_failed');
    } catch (err) {
      this.logger.warn(
        `could not release hold for ${order.id} (${(err as Error).message}); the TTL sweeper will`,
      );
    }
  }
}
