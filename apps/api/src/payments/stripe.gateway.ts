import { Injectable, Logger } from '@nestjs/common';
import Stripe from 'stripe';
import type {
  CheckoutSession,
  CreateCheckoutSessionInput,
  PaymentEvent,
  PaymentGateway,
} from './payment-gateway';

@Injectable()
export class StripeGateway implements PaymentGateway {
  readonly name = 'stripe';
  private readonly logger = new Logger(StripeGateway.name);
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;

  constructor(secretKey: string, webhookSecret: string) {
    this.stripe = new Stripe(secretKey, { apiVersion: '2024-12-18.acacia' as Stripe.LatestApiVersion });
    this.webhookSecret = webhookSecret;
  }

  async createCheckoutSession(input: CreateCheckoutSessionInput): Promise<CheckoutSession> {
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'payment',
        customer_email: input.customerEmail,
        // Stripe's own idempotency, layered on ours: a retried checkout returns
        // the same session instead of charging the customer twice.
        client_reference_id: input.orderId,
        metadata: { orderId: input.orderId },
        expires_at: Math.floor(input.expiresAt.getTime() / 1000),
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        line_items: input.lineItems.map((item) => ({
          quantity: item.quantity,
          price_data: {
            currency: input.currency.toLowerCase(),
            unit_amount: item.unitPriceCents,
            product_data: { name: item.name },
          },
        })),
      },
      { idempotencyKey: input.idempotencyKey },
    );

    return {
      id: session.id,
      url: session.url ?? '',
      expiresAt: new Date((session.expires_at ?? 0) * 1000),
    };
  }

  verifyAndParse(rawBody: Buffer, signatureHeader: string): PaymentEvent {
    const event = this.stripe.webhooks.constructEvent(rawBody, signatureHeader, this.webhookSecret);

    switch (event.type) {
      // The happy path. Note `payment_status`: a completed session with an
      // async payment method is not yet money in the account, and issuing
      // tickets for it would be issuing them on a promise.
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        return {
          id: event.id,
          type: session.payment_status === 'paid' ? 'payment.succeeded' : 'payment.failed',
          sessionId: session.id,
          paymentIntentId: (session.payment_intent as string) ?? undefined,
          orderId: session.metadata?.orderId ?? session.client_reference_id ?? undefined,
          detail: session.payment_status,
        };
      }
      case 'checkout.session.async_payment_succeeded': {
        const session = event.data.object as Stripe.Checkout.Session;
        return {
          id: event.id,
          type: 'payment.succeeded',
          sessionId: session.id,
          paymentIntentId: (session.payment_intent as string) ?? undefined,
          orderId: session.metadata?.orderId ?? undefined,
        };
      }
      // A declined card. Stripe's own test card 4000 0000 0000 0002 lands here.
      case 'checkout.session.async_payment_failed':
      case 'payment_intent.payment_failed': {
        const object = event.data.object as Stripe.Checkout.Session | Stripe.PaymentIntent;
        const sessionId = 'id' in object ? object.id : '';
        return {
          id: event.id,
          type: 'payment.failed',
          sessionId,
          detail:
            'last_payment_error' in object
              ? (object.last_payment_error?.decline_code ?? object.last_payment_error?.message ?? 'declined')
              : 'declined',
        };
      }
      // The customer opened checkout and walked away. The hold has to come back.
      case 'checkout.session.expired': {
        const session = event.data.object as Stripe.Checkout.Session;
        return {
          id: event.id,
          type: 'session.expired',
          sessionId: session.id,
          orderId: session.metadata?.orderId ?? undefined,
        };
      }
      default:
        this.logger.debug(`ignoring stripe event ${event.type}`);
        return { id: event.id, type: 'payment.failed', sessionId: '', detail: `ignored:${event.type}` };
    }
  }
}
