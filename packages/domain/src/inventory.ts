import { InsufficientInventoryError, InvariantViolationError } from './errors';

/**
 * Inventory is modelled as three counters rather than one. `available` is
 * derived, never stored, so it cannot drift from the numbers it is derived
 * from.
 *
 *   total = available + reserved + sold
 *
 * `reserved` exists because of the Stripe redirect window: between "customer
 * clicked buy" and "webhook confirms payment" there are seconds to minutes
 * during which those seats must not be sellable to anyone else, but must also
 * come back if the customer abandons the tab. A hold with a TTL is the only
 * honest way to model that.
 */
export interface InventoryState {
  ticketTypeId: string;
  quantityTotal: number;
  quantityReserved: number;
  quantitySold: number;
}

export type ReservationState = 'held' | 'committed' | 'released';

export interface Reservation {
  orderId: string;
  ticketTypeId: string;
  quantity: number;
  state: ReservationState;
  expiresAt: Date;
}

export function availableQuantity(state: InventoryState): number {
  return state.quantityTotal - state.quantityReserved - state.quantitySold;
}

export function assertInvariant(state: InventoryState): void {
  const { quantityTotal, quantityReserved, quantitySold } = state;
  if (
    !Number.isInteger(quantityTotal) ||
    !Number.isInteger(quantityReserved) ||
    !Number.isInteger(quantitySold) ||
    quantityReserved < 0 ||
    quantitySold < 0 ||
    quantityTotal < 0
  ) {
    throw new InvariantViolationError({ ...state, reason: 'negative_or_fractional' });
  }
  if (quantityReserved + quantitySold > quantityTotal) {
    throw new InvariantViolationError({ ...state, reason: 'oversold' });
  }
}

export function canReserve(state: InventoryState, quantity: number): boolean {
  return quantity > 0 && Number.isInteger(quantity) && availableQuantity(state) >= quantity;
}

/** Pure transition: held seats move out of `available` and into `reserved`. */
export function reserve(state: InventoryState, quantity: number): InventoryState {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new InsufficientInventoryError({ reason: 'invalid_quantity', quantity });
  }
  const next = { ...state, quantityReserved: state.quantityReserved + quantity };
  if (availableQuantity(state) < quantity) {
    throw new InsufficientInventoryError({
      ticketTypeId: state.ticketTypeId,
      requested: quantity,
      available: availableQuantity(state),
    });
  }
  assertInvariant(next);
  return next;
}

/**
 * Commit turns a hold into a sale. It is idempotent by design: committing a
 * reservation that is already committed returns the state untouched, because
 * the fulfilment consumer will be asked to do this more than once whenever
 * Kafka redelivers a message.
 */
export function commit(
  state: InventoryState,
  reservation: Reservation,
): { state: InventoryState; reservation: Reservation; changed: boolean } {
  if (reservation.state === 'committed') {
    return { state, reservation, changed: false };
  }
  if (reservation.state === 'released') {
    throw new InvariantViolationError({
      reason: 'commit_after_release',
      orderId: reservation.orderId,
    });
  }
  const next: InventoryState = {
    ...state,
    quantityReserved: state.quantityReserved - reservation.quantity,
    quantitySold: state.quantitySold + reservation.quantity,
  };
  assertInvariant(next);
  return { state: next, reservation: { ...reservation, state: 'committed' }, changed: true };
}

/** Release is likewise idempotent — expiry sweeps and webhook failures race. */
export function release(
  state: InventoryState,
  reservation: Reservation,
): { state: InventoryState; reservation: Reservation; changed: boolean } {
  if (reservation.state === 'released') {
    return { state, reservation, changed: false };
  }
  if (reservation.state === 'committed') {
    throw new InvariantViolationError({
      reason: 'release_after_commit',
      orderId: reservation.orderId,
    });
  }
  const next: InventoryState = {
    ...state,
    quantityReserved: state.quantityReserved - reservation.quantity,
  };
  assertInvariant(next);
  return { state: next, reservation: { ...reservation, state: 'released' }, changed: true };
}

export function isExpired(reservation: Reservation, now: Date): boolean {
  return reservation.state === 'held' && reservation.expiresAt.getTime() <= now.getTime();
}

/** Matches the Stripe Checkout Session lifetime so the two can never disagree. */
export const HOLD_TTL_MS = 15 * 60 * 1000;

export function holdExpiryFrom(now: Date, ttlMs: number = HOLD_TTL_MS): Date {
  return new Date(now.getTime() + ttlMs);
}
