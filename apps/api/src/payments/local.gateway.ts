import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import type {
  CheckoutSession,
  CreateCheckoutSessionInput,
  PaymentEvent,
  PaymentGateway,
} from './payment-gateway';

/**
 * The zero-configuration payment adapter.
 *
 * It reimplements Stripe's webhook signature scheme exactly — `t=<unix>,v1=
 * <hmac-sha256 of "timestamp.body">`, with a five-minute tolerance — so the
 * webhook receiver, the deduplication table, the order state machine and the
 * fulfilment consumer all run the same code they would in Stripe test mode.
 * Nothing downstream can tell the difference, which is the point: the paths
 * that carry risk are exercised on every clone of this repository, not only on
 * machines with API keys.
 */
const TOLERANCE_SECONDS = 300;

@Injectable()
export class LocalPaymentGateway implements PaymentGateway {
  readonly name = 'local';

  constructor(
    private readonly webhookSecret: string,
    private readonly webUrl: string,
  ) {}

  async createCheckoutSession(input: CreateCheckoutSessionInput): Promise<CheckoutSession> {
    // Deriving the session id from the idempotency key means a retried checkout
    // yields the same session, matching Stripe's behaviour rather than only
    // appearing to.
    const id = `cs_local_${createHmac('sha256', this.webhookSecret)
      .update(input.idempotencyKey)
      .digest('hex')
      .slice(0, 24)}`;

    const url = new URL('/pay', this.webUrl);
    url.searchParams.set('session', id);
    url.searchParams.set('order', input.orderId);
    url.searchParams.set('amount', String(input.amountCents));
    url.searchParams.set('currency', input.currency);
    // Carries the confirmation URL (with its access token) through the payment
    // page, mirroring how Stripe hands `success_url` back after checkout.
    url.searchParams.set('return', input.successUrl);

    return { id, url: url.toString(), expiresAt: input.expiresAt };
  }

  /** Signs a payload the way Stripe would, for the local checkout page to post back. */
  sign(body: string, timestampSeconds = Math.floor(Date.now() / 1000)): string {
    const signature = createHmac('sha256', this.webhookSecret)
      .update(`${timestampSeconds}.${body}`)
      .digest('hex');
    return `t=${timestampSeconds},v1=${signature}`;
  }

  buildEvent(input: {
    sessionId: string;
    orderId: string;
    outcome: 'succeeded' | 'failed' | 'expired';
    detail?: string;
  }): Record<string, unknown> {
    return {
      id: `evt_local_${randomUUID()}`,
      type:
        input.outcome === 'succeeded'
          ? 'payment.succeeded'
          : input.outcome === 'failed'
            ? 'payment.failed'
            : 'session.expired',
      sessionId: input.sessionId,
      orderId: input.orderId,
      paymentIntentId: `pi_local_${input.sessionId.slice(-12)}`,
      detail: input.detail ?? input.outcome,
    };
  }

  verifyAndParse(rawBody: Buffer, signatureHeader: string): PaymentEvent {
    const parts = Object.fromEntries(
      (signatureHeader ?? '').split(',').map((part) => {
        const [key, value] = part.split('=');
        return [key ?? '', value ?? ''];
      }),
    );

    const timestamp = Number(parts.t);
    if (!Number.isFinite(timestamp) || !parts.v1) {
      throw new BadRequestException({ error: 'INVALID_SIGNATURE', reason: 'malformed_header' });
    }
    // A replayed-but-valid signature from days ago is still a replay attack.
    if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > TOLERANCE_SECONDS) {
      throw new BadRequestException({ error: 'INVALID_SIGNATURE', reason: 'timestamp_outside_tolerance' });
    }

    const expected = createHmac('sha256', this.webhookSecret)
      .update(`${timestamp}.${rawBody.toString('utf8')}`)
      .digest();
    const provided = Buffer.from(parts.v1, 'hex');

    // Constant-time compare: a length check first, because timingSafeEqual
    // throws on mismatched lengths and that throw is itself a timing signal.
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new BadRequestException({ error: 'INVALID_SIGNATURE', reason: 'mismatch' });
    }

    const parsed = JSON.parse(rawBody.toString('utf8')) as PaymentEvent;
    return parsed;
  }
}
