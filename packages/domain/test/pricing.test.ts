import { describe, expect, it } from 'vitest';
import {
  InvalidQuantityError,
  MAX_TICKETS_PER_ORDER,
  OrderTooLargeError,
  SalesWindowClosedError,
  priceOrder,
  type TicketTypeSnapshot,
} from '../src';

const NOW = new Date('2026-03-01T12:00:00.000Z');

function ticketType(over: Partial<TicketTypeSnapshot> = {}): TicketTypeSnapshot {
  return {
    ticketTypeId: 'tt_general',
    name: 'General Admission',
    unitPriceCents: 2500,
    maxPerOrder: 6,
    salesStartAt: new Date('2026-01-01T00:00:00.000Z'),
    salesEndAt: new Date('2026-06-01T00:00:00.000Z'),
    ...over,
  };
}

describe('priceOrder', () => {
  it('multiplies unit price by quantity and adds the service fee', () => {
    const result = priceOrder({
      requested: [{ ticketTypeId: 'tt_general', quantity: 2 }],
      ticketTypes: [ticketType()],
      serviceFeeBps: 750,
      currency: 'EUR',
      now: NOW,
    });

    expect(result.subtotalCents).toBe(5000);
    expect(result.feeCents).toBe(375);
    expect(result.totalCents).toBe(5375);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]?.subtotalCents).toBe(5000);
  });

  it('rounds a fractional fee half-up, never producing a fractional cent', () => {
    // 1999 * 7.5% = 149.925 -> 150
    const result = priceOrder({
      requested: [{ ticketTypeId: 'tt_general', quantity: 1 }],
      ticketTypes: [ticketType({ unitPriceCents: 1999 })],
      serviceFeeBps: 750,
      currency: 'EUR',
      now: NOW,
    });
    expect(result.feeCents).toBe(150);
    expect(Number.isInteger(result.totalCents)).toBe(true);
  });

  it('rounds exactly .5 upwards', () => {
    // 1000 * 0.05% = 0.5 -> 1
    const result = priceOrder({
      requested: [{ ticketTypeId: 'tt_general', quantity: 1 }],
      ticketTypes: [ticketType({ unitPriceCents: 1000 })],
      serviceFeeBps: 5,
      currency: 'EUR',
      now: NOW,
    });
    expect(result.feeCents).toBe(1);
  });

  it('charges no service fee on a fully free order', () => {
    const result = priceOrder({
      requested: [{ ticketTypeId: 'tt_free', quantity: 2 }],
      ticketTypes: [ticketType({ ticketTypeId: 'tt_free', unitPriceCents: 0 })],
      serviceFeeBps: 750,
      currency: 'EUR',
      now: NOW,
    });
    expect(result.subtotalCents).toBe(0);
    expect(result.feeCents).toBe(0);
    expect(result.totalCents).toBe(0);
  });

  it('prices multiple ticket types in one order', () => {
    const result = priceOrder({
      requested: [
        { ticketTypeId: 'tt_general', quantity: 2 },
        { ticketTypeId: 'tt_early', quantity: 1 },
      ],
      ticketTypes: [
        ticketType(),
        ticketType({ ticketTypeId: 'tt_early', name: 'Early Bird', unitPriceCents: 1800 }),
      ],
      serviceFeeBps: 0,
      currency: 'EUR',
      now: NOW,
    });
    expect(result.subtotalCents).toBe(6800);
    expect(result.totalCents).toBe(6800);
  });

  it('rejects a quantity above the ticket type limit', () => {
    expect(() =>
      priceOrder({
        requested: [{ ticketTypeId: 'tt_general', quantity: 7 }],
        ticketTypes: [ticketType({ maxPerOrder: 6 })],
        serviceFeeBps: 0,
        currency: 'EUR',
        now: NOW,
      }),
    ).toThrow(InvalidQuantityError);
  });

  it('rejects the same ticket type split across two lines to dodge the limit', () => {
    expect(() =>
      priceOrder({
        requested: [
          { ticketTypeId: 'tt_general', quantity: 6 },
          { ticketTypeId: 'tt_general', quantity: 6 },
        ],
        ticketTypes: [ticketType({ maxPerOrder: 6 })],
        serviceFeeBps: 0,
        currency: 'EUR',
        now: NOW,
      }),
    ).toThrow(InvalidQuantityError);
  });

  it('rejects an order over the global ticket ceiling', () => {
    expect(() =>
      priceOrder({
        requested: [
          { ticketTypeId: 'a', quantity: 6 },
          { ticketTypeId: 'b', quantity: 6 },
        ],
        ticketTypes: [
          ticketType({ ticketTypeId: 'a', maxPerOrder: 6 }),
          ticketType({ ticketTypeId: 'b', maxPerOrder: 6 }),
        ],
        serviceFeeBps: 0,
        currency: 'EUR',
        now: NOW,
      }),
    ).toThrow(OrderTooLargeError);
    expect(MAX_TICKETS_PER_ORDER).toBe(10);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects the invalid quantity %s', (quantity) => {
    expect(() =>
      priceOrder({
        requested: [{ ticketTypeId: 'tt_general', quantity }],
        ticketTypes: [ticketType()],
        serviceFeeBps: 0,
        currency: 'EUR',
        now: NOW,
      }),
    ).toThrow(InvalidQuantityError);
  });

  it('rejects an empty order and an unknown ticket type', () => {
    const base = { ticketTypes: [ticketType()], serviceFeeBps: 0, currency: 'EUR' as const, now: NOW };
    expect(() => priceOrder({ ...base, requested: [] })).toThrow(InvalidQuantityError);
    expect(() => priceOrder({ ...base, requested: [{ ticketTypeId: 'nope', quantity: 1 }] })).toThrow(
      InvalidQuantityError,
    );
  });

  it('rejects a nonsensical fee configuration', () => {
    expect(() =>
      priceOrder({
        requested: [{ ticketTypeId: 'tt_general', quantity: 1 }],
        ticketTypes: [ticketType()],
        serviceFeeBps: 10_001,
        currency: 'EUR',
        now: NOW,
      }),
    ).toThrow(InvalidQuantityError);
  });

  it('refuses sales before the window opens and at the instant it closes', () => {
    const tt = ticketType({
      salesStartAt: new Date('2026-04-01T00:00:00.000Z'),
      salesEndAt: new Date('2026-05-01T00:00:00.000Z'),
    });
    const call = (now: Date) =>
      priceOrder({
        requested: [{ ticketTypeId: 'tt_general', quantity: 1 }],
        ticketTypes: [tt],
        serviceFeeBps: 0,
        currency: 'EUR',
        now,
      });

    expect(() => call(new Date('2026-03-31T23:59:59.999Z'))).toThrow(SalesWindowClosedError);
    expect(() => call(new Date('2026-05-01T00:00:00.000Z'))).toThrow(SalesWindowClosedError);
    expect(call(new Date('2026-04-01T00:00:00.000Z')).totalCents).toBe(2500);
  });
});
