import { describe, expect, it } from 'vitest';
import {
  HOLD_TTL_MS,
  InsufficientInventoryError,
  InvariantViolationError,
  assertInvariant,
  availableQuantity,
  canReserve,
  commit,
  holdExpiryFrom,
  isExpired,
  release,
  reserve,
  type InventoryState,
  type Reservation,
} from '../src';

const NOW = new Date('2026-03-01T12:00:00.000Z');

function state(over: Partial<InventoryState> = {}): InventoryState {
  return {
    ticketTypeId: 'tt_general',
    quantityTotal: 100,
    quantityReserved: 0,
    quantitySold: 0,
    ...over,
  };
}

function held(over: Partial<Reservation> = {}): Reservation {
  return {
    orderId: 'ord_1',
    ticketTypeId: 'tt_general',
    quantity: 2,
    state: 'held',
    expiresAt: holdExpiryFrom(NOW),
    ...over,
  };
}

describe('availability', () => {
  it('derives available from total minus reserved minus sold', () => {
    expect(availableQuantity(state({ quantityReserved: 10, quantitySold: 30 }))).toBe(60);
  });

  it('treats held seats as unavailable to a second buyer', () => {
    const s = state({ quantityTotal: 2, quantityReserved: 2 });
    expect(availableQuantity(s)).toBe(0);
    expect(canReserve(s, 1)).toBe(false);
  });
});

describe('reserve', () => {
  it('moves seats from available into reserved', () => {
    const next = reserve(state({ quantityTotal: 10 }), 3);
    expect(next.quantityReserved).toBe(3);
    expect(availableQuantity(next)).toBe(7);
  });

  it('allows reserving exactly the last remaining seats', () => {
    const next = reserve(state({ quantityTotal: 5, quantitySold: 3 }), 2);
    expect(availableQuantity(next)).toBe(0);
  });

  it('refuses to oversell by one', () => {
    expect(() => reserve(state({ quantityTotal: 5, quantitySold: 3 }), 3)).toThrow(
      InsufficientInventoryError,
    );
  });

  it.each([0, -2, 1.5])('rejects the invalid hold quantity %s', (q) => {
    expect(() => reserve(state(), q)).toThrow(InsufficientInventoryError);
  });
});

describe('commit', () => {
  it('turns a hold into a sale exactly once', () => {
    const initial = reserve(state({ quantityTotal: 10 }), 2);
    const first = commit(initial, held());

    expect(first.changed).toBe(true);
    expect(first.state.quantityReserved).toBe(0);
    expect(first.state.quantitySold).toBe(2);
    expect(first.reservation.state).toBe('committed');
  });

  it('is a no-op when replayed, which is what makes redelivery safe', () => {
    const initial = reserve(state({ quantityTotal: 10 }), 2);
    const first = commit(initial, held());
    const second = commit(first.state, first.reservation);
    const third = commit(second.state, second.reservation);

    expect(second.changed).toBe(false);
    expect(third.changed).toBe(false);
    expect(third.state.quantitySold).toBe(2);
    expect(availableQuantity(third.state)).toBe(8);
  });

  it('refuses to commit a reservation that was already released', () => {
    expect(() => commit(state(), held({ state: 'released' }))).toThrow(InvariantViolationError);
  });
});

describe('release', () => {
  it('returns held seats to the pool', () => {
    const initial = reserve(state({ quantityTotal: 10 }), 4);
    const result = release(initial, held({ quantity: 4 }));
    expect(result.changed).toBe(true);
    expect(availableQuantity(result.state)).toBe(10);
  });

  it('is idempotent, because expiry sweeps race with webhook failures', () => {
    const initial = reserve(state({ quantityTotal: 10 }), 4);
    const first = release(initial, held({ quantity: 4 }));
    const second = release(first.state, first.reservation);
    expect(second.changed).toBe(false);
    expect(availableQuantity(second.state)).toBe(10);
  });

  it('refuses to release a sale that already completed', () => {
    expect(() => release(state({ quantitySold: 2 }), held({ state: 'committed' }))).toThrow(
      InvariantViolationError,
    );
  });
});

describe('expiry', () => {
  it('expires a hold at its TTL boundary and not before', () => {
    const r = held({ expiresAt: holdExpiryFrom(NOW) });
    expect(isExpired(r, new Date(NOW.getTime() + HOLD_TTL_MS - 1))).toBe(false);
    expect(isExpired(r, new Date(NOW.getTime() + HOLD_TTL_MS))).toBe(true);
  });

  it('never expires a reservation that is no longer held', () => {
    const later = new Date(NOW.getTime() + HOLD_TTL_MS * 10);
    expect(isExpired(held({ state: 'committed' }), later)).toBe(false);
    expect(isExpired(held({ state: 'released' }), later)).toBe(false);
  });
});

describe('invariant', () => {
  it('rejects a state that is already oversold', () => {
    expect(() => assertInvariant(state({ quantityTotal: 5, quantityReserved: 3, quantitySold: 3 }))).toThrow(
      InvariantViolationError,
    );
  });

  it('rejects fractional or negative counters', () => {
    expect(() => assertInvariant(state({ quantitySold: -1 }))).toThrow(InvariantViolationError);
    expect(() => assertInvariant(state({ quantityReserved: 1.5 }))).toThrow(InvariantViolationError);
  });
});
