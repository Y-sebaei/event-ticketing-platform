import { createHash } from 'node:crypto';
import { InvalidIdempotencyKeyError } from './errors';
import { RequestedLine } from './pricing';

/**
 * Three different replays need three different guards, and conflating them is
 * the classic way to ship a system that looks idempotent and is not:
 *
 *   1. The browser double-submits checkout  -> client idempotency key
 *   2. Stripe replays a webhook             -> provider event id
 *   3. Kafka redelivers after a crash       -> message dedupe key
 *
 * Each returns a value that is stable for "the same thing happening again" and
 * different for "a genuinely new thing". Everything here is a pure function so
 * the guarantee can be asserted in a unit test rather than argued about.
 */

const KEY_PATTERN = /^[A-Za-z0-9_:.-]{8,255}$/;

export function assertValidIdempotencyKey(key: string): string {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
    throw new InvalidIdempotencyKeyError({ key: typeof key === 'string' ? key.slice(0, 64) : null });
  }
  return key;
}

export interface CheckoutFingerprintInput {
  customerEmail: string;
  eventId: string;
  lines: RequestedLine[];
}

/**
 * A content fingerprint of a checkout request. Two requests that mean the same
 * purchase produce the same fingerprint regardless of line ordering or email
 * casing, so a client that retries without sending a key still cannot create a
 * second order. Clients that do send a key get to define their own boundary.
 */
export function checkoutFingerprint(input: CheckoutFingerprintInput): string {
  const canonical = JSON.stringify({
    email: input.customerEmail.trim().toLowerCase(),
    eventId: input.eventId,
    lines: [...input.lines]
      .map((l) => ({ t: l.ticketTypeId, q: l.quantity }))
      .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0)),
  });
  return `cof_${createHash('sha256').update(canonical).digest('hex').slice(0, 40)}`;
}

export function resolveIdempotencyKey(
  providedKey: string | undefined | null,
  fingerprintInput: CheckoutFingerprintInput,
): string {
  if (providedKey === undefined || providedKey === null || providedKey === '') {
    return checkoutFingerprint(fingerprintInput);
  }
  return assertValidIdempotencyKey(providedKey);
}

/**
 * The primary key of the consumer inbox. Scoping by consumer group matters:
 * two different consumers must both be allowed to process the same message,
 * and the same consumer must not.
 */
export function messageDedupeKey(consumerGroup: string, messageId: string): string {
  if (!consumerGroup || !messageId) {
    throw new InvalidIdempotencyKeyError({ consumerGroup, messageId });
  }
  return `${consumerGroup}:${messageId}`;
}

/**
 * A deterministic ticket serial. Because it is derived from (orderId,
 * ticketTypeId, seq) rather than random, a redelivered fulfilment message
 * produces byte-identical serials and collides with the unique index instead of
 * minting a second, subtly different ticket.
 */
export function ticketSerial(orderId: string, ticketTypeId: string, seq: number): string {
  if (!Number.isInteger(seq) || seq < 1) {
    throw new InvalidIdempotencyKeyError({ reason: 'invalid_seq', seq });
  }
  const digest = createHash('sha256')
    .update(`${orderId}|${ticketTypeId}|${seq}`)
    .digest('hex')
    .slice(0, 12)
    .toUpperCase();
  return `TIX-${digest.slice(0, 4)}-${digest.slice(4, 8)}-${digest.slice(8, 12)}`;
}
