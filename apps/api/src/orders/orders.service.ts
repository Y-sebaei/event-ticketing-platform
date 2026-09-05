import { randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  HOLD_TTL_MS,
  priceOrder,
  resolveIdempotencyKey,
  type Currency,
  type TicketTypeSnapshot,
} from '@ticketing/domain';
import { captureTraceContext, ordersCreated, withSpan } from '@ticketing/otel';
import { withTransaction, type Pool } from '@ticketing/platform';
import { PG_POOL } from '../common/tokens';
import { InventoryClient } from '../common/inventory.client';
import { PAYMENT_GATEWAY, type PaymentGateway } from '../payments/payment-gateway';
import type { CheckoutInput } from './orders.dto';

export interface CheckoutResult {
  orderId: string;
  accessToken: string;
  paymentUrl: string;
  totalCents: number;
  subtotalCents: number;
  feeCents: number;
  currency: string;
  expiresAt: string;
  /** true when this request was recognised as a retry of an earlier one. */
  replayed: boolean;
}

interface EventForCheckout {
  id: string;
  slug: string;
  title: string;
  currency: string;
  serviceFeeBps: number;
  ticketTypes: TicketTypeSnapshot[];
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  /**
   * How long seats are held while the customer pays.
   *
   * Defaults to the domain constant, which deliberately matches the payment
   * session lifetime so the two cannot disagree about when an order stops being
   * live. Overridable only so the end-to-end suite can exercise hold expiry in
   * seconds rather than waiting a quarter of an hour; nothing in production
   * sets it.
   */
  private readonly holdTtlMs =
    Number(process.env.CHECKOUT_HOLD_TTL_SECONDS) > 0
      ? Number(process.env.CHECKOUT_HOLD_TTL_SECONDS) * 1000
      : HOLD_TTL_MS;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly inventory: InventoryClient,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  private async loadEvent(slug: string): Promise<EventForCheckout> {
    const { rows } = await this.pool.query(
      `SELECT e.id, e.slug, e.title, e.currency, e.service_fee_bps,
              t.id AS ticket_type_id, t.name, t.price_cents, t.max_per_order,
              t.sales_start_at, t.sales_end_at
         FROM catalog.event e
         JOIN catalog.ticket_type t ON t.event_id = e.id
        WHERE e.slug = $1 AND e.status = 'published'`,
      [slug],
    );

    if (rows.length === 0) throw new NotFoundException({ error: 'EVENT_NOT_FOUND', slug });

    return {
      id: rows[0].id,
      slug: rows[0].slug,
      title: rows[0].title,
      currency: rows[0].currency,
      serviceFeeBps: rows[0].service_fee_bps,
      ticketTypes: rows.map((r) => ({
        ticketTypeId: r.ticket_type_id,
        name: r.name,
        unitPriceCents: r.price_cents,
        maxPerOrder: r.max_per_order,
        salesStartAt: new Date(r.sales_start_at),
        salesEndAt: new Date(r.sales_end_at),
      })),
    };
  }

  private async findByIdempotencyKey(key: string): Promise<CheckoutResult | null> {
    const { rows } = await this.pool.query(
      `SELECT id, access_token, payment_session_url, total_cents, subtotal_cents, fee_cents,
              currency, expires_at
         FROM ordering.customer_order
        WHERE idempotency_key = $1`,
      [key],
    );
    const row = rows[0];
    if (!row) return null;

    return {
      orderId: row.id,
      accessToken: row.access_token,
      paymentUrl: row.payment_session_url ?? '',
      totalCents: row.total_cents,
      subtotalCents: row.subtotal_cents,
      feeCents: row.fee_cents,
      currency: row.currency,
      expiresAt: new Date(row.expires_at).toISOString(),
      replayed: true,
    };
  }

  /**
   * Checkout, in the order the steps have to happen:
   *
   *   1. Price the order from the catalog. The client sends quantities, never
   *      prices; a client that could send prices could send its own.
   *   2. Guard 1 of three: an idempotency key — the client's, or a fingerprint
   *      of the request. A retry returns the first order rather than a second.
   *   3. Persist the order as `pending` with a 15-minute expiry.
   *   4. Hold the seats over gRPC, making them unavailable to everyone else for
   *      the duration of the redirect to the payment page.
   *   5. Create the payment session, whose lifetime matches the hold's, so the
   *      two can never disagree about when this order stops being live.
   *
   * Steps 3-5 are not one transaction and cannot be, since two of them are
   * calls to other systems. What makes that safe is that each is idempotent on
   * the order id, and the hold expires by itself if the sequence is abandoned
   * halfway through.
   */
  async checkout(input: CheckoutInput, providedKey?: string): Promise<CheckoutResult> {
    return withSpan(
      'orders.checkout',
      { 'event.slug': input.eventSlug, 'order.line_count': input.items.length },
      async (span) => {
        const event = await this.loadEvent(input.eventSlug);
        span.setAttribute('event.id', event.id);

        const idempotencyKey = resolveIdempotencyKey(providedKey, {
          customerEmail: input.customer.email,
          eventId: event.id,
          lines: input.items.map((i) => ({ ticketTypeId: i.ticketTypeId, quantity: i.quantity })),
        });

        const existing = await this.findByIdempotencyKey(idempotencyKey);
        if (existing) {
          span.setAttribute('order.replayed', true);
          this.logger.log(`checkout replay for order ${existing.orderId}`);
          return existing;
        }

        const pricing = priceOrder({
          requested: input.items.map((i) => ({
            ticketTypeId: i.ticketTypeId,
            quantity: i.quantity,
          })),
          ticketTypes: event.ticketTypes,
          serviceFeeBps: event.serviceFeeBps,
          currency: event.currency as Currency,
          now: new Date(),
        });

        const orderId = randomUUID();
        const accessToken = randomBytes(24).toString('base64url');
        const expiresAt = new Date(Date.now() + this.holdTtlMs);

        await withTransaction(this.pool, async (client) => {
          const customer = await client.query<{ id: string }>(
            `INSERT INTO ordering.customer (email, name)
             VALUES ($1, $2)
             ON CONFLICT (lower(email)) DO UPDATE SET name = EXCLUDED.name
             RETURNING id`,
            [input.customer.email, input.customer.name],
          );

          await client.query(
            `INSERT INTO ordering.customer_order
               (id, customer_id, event_id, status, subtotal_cents, fee_cents, total_cents,
                currency, idempotency_key, access_token, expires_at, trace_context)
             VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              orderId,
              customer.rows[0]!.id,
              event.id,
              pricing.subtotalCents,
              pricing.feeCents,
              pricing.totalCents,
              pricing.currency,
              idempotencyKey,
              accessToken,
              expiresAt,
              // The webhook resumes this context minutes later, so fulfilment
              // lands in the same trace as the checkout that caused it.
              JSON.stringify(captureTraceContext()),
            ],
          );

          for (const line of pricing.lines) {
            await client.query(
              `INSERT INTO ordering.order_item
                 (order_id, ticket_type_id, name_snapshot, unit_price_cents, quantity)
               VALUES ($1, $2, $3, $4, $5)`,
              [orderId, line.ticketTypeId, line.name, line.unitPriceCents, line.quantity],
            );
          }
        });

        try {
          await this.inventory.hold({
            orderId,
            eventId: event.id,
            items: pricing.lines.map((l) => ({
              ticketTypeId: l.ticketTypeId,
              quantity: l.quantity,
            })),
            ttlSeconds: Math.floor(this.holdTtlMs / 1000),
          });
        } catch (err) {
          // Sold out between rendering the page and pressing buy. Fail the
          // order now rather than leave a pending row that expires in fifteen
          // minutes and confuses the customer's order history.
          await this.pool.query(
            `UPDATE ordering.customer_order
                SET status = 'failed', payment_status_detail = 'inventory_unavailable', updated_at = now()
              WHERE id = $1`,
            [orderId],
          );
          throw err;
        }

        const webUrl = process.env.PUBLIC_WEB_URL ?? 'http://localhost:5173';
        const session = await this.gateway.createCheckoutSession({
          orderId,
          amountCents: pricing.totalCents,
          currency: pricing.currency,
          customerEmail: input.customer.email,
          lineItems: [
            ...pricing.lines.map((l) => ({
              name: `${event.title} - ${l.name}`,
              unitPriceCents: l.unitPriceCents,
              quantity: l.quantity,
            })),
            ...(pricing.feeCents > 0
              ? [{ name: 'Service fee', unitPriceCents: pricing.feeCents, quantity: 1 }]
              : []),
          ],
          successUrl: `${webUrl}/orders/${orderId}?token=${accessToken}`,
          cancelUrl: `${webUrl}/events/${event.slug}`,
          expiresAt,
          idempotencyKey,
        });

        await this.pool.query(
          `UPDATE ordering.customer_order
              SET payment_session_id = $2, payment_session_url = $3, updated_at = now()
            WHERE id = $1`,
          [orderId, session.id, session.url],
        );

        ordersCreated.add(1, { gateway: this.gateway.name, currency: pricing.currency });
        span.setAttribute('order.id', orderId);
        span.setAttribute('order.total_cents', pricing.totalCents);

        return {
          orderId,
          accessToken,
          paymentUrl: session.url,
          totalCents: pricing.totalCents,
          subtotalCents: pricing.subtotalCents,
          feeCents: pricing.feeCents,
          currency: pricing.currency,
          expiresAt: expiresAt.toISOString(),
          replayed: false,
        };
      },
    );
  }

  /**
   * The confirmation page's data source.
   *
   * Guarded by an unguessable access token rather than a login, because this
   * project deliberately has no authentication — adding it would have spent a
   * reviewer's attention on something that demonstrates none of the seven
   * things the project is for.
   */
  async getOrder(orderId: string, accessToken: string) {
    const { rows } = await this.pool.query(
      `SELECT o.id, o.status, o.subtotal_cents, o.fee_cents, o.total_cents, o.currency,
              o.expires_at, o.paid_at, o.fulfilled_at, o.payment_session_url, o.payment_status_detail,
              c.email, c.name,
              e.title, e.slug, e.starts_at, v.name AS venue_name, v.city
         FROM ordering.customer_order o
         JOIN ordering.customer c ON c.id = o.customer_id
         JOIN catalog.event e ON e.id = o.event_id
         JOIN catalog.venue v ON v.id = e.venue_id
        WHERE o.id = $1 AND o.access_token = $2`,
      [orderId, accessToken],
    );

    const order = rows[0];
    // Same 404 whether the order is missing or the token is wrong: telling the
    // two apart would let someone confirm which order ids exist.
    if (!order) throw new NotFoundException({ error: 'ORDER_NOT_FOUND' });

    const items = await this.pool.query(
      `SELECT ticket_type_id, name_snapshot, unit_price_cents, quantity
         FROM ordering.order_item WHERE order_id = $1 ORDER BY name_snapshot`,
      [orderId],
    );

    const tickets = await this.pool.query(
      `SELECT serial, ticket_type_id, seq, issued_at
         FROM ordering.ticket WHERE order_id = $1 ORDER BY ticket_type_id, seq`,
      [orderId],
    );

    return {
      id: order.id,
      status: order.status,
      statusDetail: order.payment_status_detail,
      subtotalCents: order.subtotal_cents,
      feeCents: order.fee_cents,
      totalCents: order.total_cents,
      currency: order.currency,
      expiresAt: new Date(order.expires_at).toISOString(),
      paidAt: order.paid_at ? new Date(order.paid_at).toISOString() : null,
      fulfilledAt: order.fulfilled_at ? new Date(order.fulfilled_at).toISOString() : null,
      paymentUrl: order.payment_session_url,
      customer: { email: order.email, name: order.name },
      event: {
        slug: order.slug,
        title: order.title,
        startsAt: new Date(order.starts_at).toISOString(),
        venueName: order.venue_name,
        city: order.city,
      },
      items: items.rows.map((i) => ({
        ticketTypeId: i.ticket_type_id,
        name: i.name_snapshot,
        unitPriceCents: i.unit_price_cents,
        quantity: i.quantity,
      })),
      tickets: tickets.rows.map((t) => ({
        serial: t.serial,
        ticketTypeId: t.ticket_type_id,
        seq: t.seq,
        issuedAt: new Date(t.issued_at).toISOString(),
      })),
    };
  }
}
