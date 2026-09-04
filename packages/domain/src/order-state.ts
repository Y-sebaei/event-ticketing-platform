import { IllegalTransitionError } from './errors';

export type OrderStatus = 'pending' | 'paid' | 'fulfilled' | 'failed' | 'expired';

/**
 * The order lifecycle, written down once. `paid` and `fulfilled` are separate
 * states on purpose: money is captured by the webhook, tickets are issued by
 * the Kafka consumer, and the gap between them is exactly where a crash can
 * happen. Collapsing them into one state would make that window invisible.
 */
const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: ['paid', 'failed', 'expired'],
  paid: ['fulfilled'],
  fulfilled: [],
  failed: [],
  expired: [],
};

export function isTerminal(status: OrderStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Re-applying a transition that already happened is a no-op, not an error:
 * webhooks replay and Kafka redelivers, and both must be safe to repeat.
 */
export function transition(from: OrderStatus, to: OrderStatus): { status: OrderStatus; changed: boolean } {
  if (from === to) return { status: from, changed: false };
  if (!canTransition(from, to)) {
    throw new IllegalTransitionError({ from, to });
  }
  return { status: to, changed: true };
}

export function isExpiredOrder(status: OrderStatus, expiresAt: Date, now: Date): boolean {
  return status === 'pending' && expiresAt.getTime() <= now.getTime();
}
