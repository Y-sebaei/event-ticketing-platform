import { InvalidQuantityError, OrderTooLargeError, SalesWindowClosedError } from './errors';
import { Cents, Currency, roundHalfUp } from './money';

/** A hard ceiling per order, independent of any single ticket type's limit. */
export const MAX_TICKETS_PER_ORDER = 10;

export interface TicketTypeSnapshot {
  ticketTypeId: string;
  name: string;
  unitPriceCents: Cents;
  maxPerOrder: number;
  salesStartAt: Date;
  salesEndAt: Date;
}

export interface RequestedLine {
  ticketTypeId: string;
  quantity: number;
}

export interface PricedLine {
  ticketTypeId: string;
  name: string;
  unitPriceCents: Cents;
  quantity: number;
  subtotalCents: Cents;
}

export interface OrderPricing {
  lines: PricedLine[];
  subtotalCents: Cents;
  feeCents: Cents;
  totalCents: Cents;
  currency: Currency;
}

export interface PriceOrderInput {
  requested: RequestedLine[];
  ticketTypes: TicketTypeSnapshot[];
  serviceFeeBps: number;
  currency: Currency;
  now: Date;
}

/**
 * The single source of truth for what an order costs. The API prices the order,
 * the payment gateway is told that total, and the fulfilment consumer never
 * recomputes it — it reads what was persisted. Pricing happening in exactly one
 * place is what makes "the customer was charged the wrong amount" impossible
 * rather than merely unlikely.
 */
export function priceOrder(input: PriceOrderInput): OrderPricing {
  const { requested, ticketTypes, serviceFeeBps, currency, now } = input;

  if (requested.length === 0) {
    throw new InvalidQuantityError({ reason: 'empty_order' });
  }
  if (!Number.isInteger(serviceFeeBps) || serviceFeeBps < 0 || serviceFeeBps > 10_000) {
    throw new InvalidQuantityError({ reason: 'invalid_fee_bps', serviceFeeBps });
  }

  const byId = new Map(ticketTypes.map((t) => [t.ticketTypeId, t]));
  const seen = new Set<string>();
  const lines: PricedLine[] = [];
  let subtotalCents = 0;
  let totalQuantity = 0;
  let anyPaidLine = false;

  for (const line of requested) {
    const ticketType = byId.get(line.ticketTypeId);
    if (!ticketType) {
      throw new InvalidQuantityError({ reason: 'unknown_ticket_type', ...line });
    }
    // Two lines for the same ticket type would let a caller walk past
    // maxPerOrder one line at a time.
    if (seen.has(line.ticketTypeId)) {
      throw new InvalidQuantityError({ reason: 'duplicate_ticket_type', ...line });
    }
    seen.add(line.ticketTypeId);

    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      throw new InvalidQuantityError({ reason: 'not_a_positive_integer', ...line });
    }
    if (line.quantity > ticketType.maxPerOrder) {
      throw new InvalidQuantityError({
        reason: 'exceeds_max_per_order',
        maxPerOrder: ticketType.maxPerOrder,
        ...line,
      });
    }
    if (now < ticketType.salesStartAt || now >= ticketType.salesEndAt) {
      throw new SalesWindowClosedError({
        ticketTypeId: line.ticketTypeId,
        salesStartAt: ticketType.salesStartAt.toISOString(),
        salesEndAt: ticketType.salesEndAt.toISOString(),
      });
    }

    const lineSubtotal = ticketType.unitPriceCents * line.quantity;
    if (ticketType.unitPriceCents > 0) anyPaidLine = true;
    subtotalCents += lineSubtotal;
    totalQuantity += line.quantity;

    lines.push({
      ticketTypeId: ticketType.ticketTypeId,
      name: ticketType.name,
      unitPriceCents: ticketType.unitPriceCents,
      quantity: line.quantity,
      subtotalCents: lineSubtotal,
    });
  }

  if (totalQuantity > MAX_TICKETS_PER_ORDER) {
    throw new OrderTooLargeError({ totalQuantity, max: MAX_TICKETS_PER_ORDER });
  }

  // A fully free order carries no service fee. Charging 0.00 would still create
  // a payment intent for zero, which Stripe rejects, so this is a real rule and
  // not a cosmetic one.
  const feeCents = anyPaidLine ? roundHalfUp((subtotalCents * serviceFeeBps) / 10_000) : 0;

  return { lines, subtotalCents, feeCents, totalCents: subtotalCents + feeCents, currency };
}
