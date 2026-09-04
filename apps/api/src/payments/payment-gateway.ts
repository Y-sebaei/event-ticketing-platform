/**
 * The payment boundary.
 *
 * Two implementations satisfy it: Stripe in test mode, and a local adapter used
 * when no Stripe key is configured. The local adapter is not a mock in the
 * usual sense — it produces a real HTTP webhook, signed with the same HMAC
 * scheme Stripe uses, delivered to the same endpoint. Signature verification,
 * webhook deduplication, order state transitions and fulfilment all run
 * identically either way. What it does not do is talk to Stripe.
 *
 * This exists so that `docker compose up` on a machine with no Stripe account
 * still demonstrates the entire payment path, which the brief asked for: one
 * command, no extra README steps.
 */
export interface CheckoutLineItem {
  name: string;
  unitPriceCents: number;
  quantity: number;
}

export interface CreateCheckoutSessionInput {
  orderId: string;
  amountCents: number;
  currency: string;
  customerEmail: string;
  lineItems: CheckoutLineItem[];
  successUrl: string;
  cancelUrl: string;
  expiresAt: Date;
  idempotencyKey: string;
}

export interface CheckoutSession {
  id: string;
  url: string;
  expiresAt: Date;
}

export type PaymentEventType = 'payment.succeeded' | 'payment.failed' | 'session.expired';

export interface PaymentEvent {
  /** Provider event id. The primary key of the webhook dedupe table. */
  id: string;
  type: PaymentEventType;
  sessionId: string;
  paymentIntentId?: string;
  orderId?: string;
  /** Human-readable outcome, e.g. Stripe's decline code. */
  detail?: string;
}

export interface PaymentGateway {
  readonly name: string;
  createCheckoutSession(input: CreateCheckoutSessionInput): Promise<CheckoutSession>;
  /**
   * Verifies the signature over the RAW request bytes and returns the event, or
   * throws. Never parse the body before this runs: any re-serialisation changes
   * the bytes and every signature check fails.
   */
  verifyAndParse(rawBody: Buffer, signatureHeader: string): PaymentEvent;
}

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');
