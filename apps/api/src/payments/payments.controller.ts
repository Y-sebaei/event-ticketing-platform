import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Logger,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { currentTraceId } from '@ticketing/otel';
import type { Request } from 'express';
import { LocalPaymentGateway } from './local.gateway';
import { PAYMENT_GATEWAY, type PaymentGateway } from './payment-gateway';
import { PaymentsService } from './payments.service';

@Controller()
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    private readonly payments: PaymentsService,
  ) {}

  /**
   * The webhook receiver.
   *
   * Fulfilment is driven from here and nowhere else — never from the browser
   * redirect. That is what makes "the webhook arrives before the redirect" a
   * non-event rather than a race: by the time the customer's browser comes
   * back, the order may already be paid, and the confirmation page simply
   * renders that. When the redirect wins instead, the page subscribes and the
   * transition arrives over the WebSocket a moment later. Neither ordering is
   * special-cased, because neither ordering is exceptional.
   *
   * Always 200 on a well-formed event, including duplicates. Only a bad
   * signature is a 400.
   */
  @Post('webhooks/payments')
  @HttpCode(200)
  async receive(
    @Req() request: RawBodyRequest<Request>,
    @Headers('stripe-signature') stripeSignature?: string,
    @Headers('x-payment-signature') localSignature?: string,
  ) {
    const rawBody = request.rawBody;
    if (!rawBody) {
      throw new BadRequestException({ error: 'RAW_BODY_MISSING' });
    }

    const signature = stripeSignature ?? localSignature;
    if (!signature) {
      throw new BadRequestException({ error: 'SIGNATURE_MISSING' });
    }

    // Verification happens before anything else reads the body. An unverified
    // webhook is an anonymous internet request claiming someone paid.
    const event = this.gateway.verifyAndParse(rawBody, signature);
    const result = await this.payments.handle(event);

    return { received: true, duplicate: result.duplicate, traceId: currentTraceId() };
  }

  /**
   * Called by the built-in checkout page when no Stripe key is configured. It
   * signs an event and delivers it to the webhook endpoint above over real
   * HTTP, so the local path exercises signature verification and deduplication
   * exactly as the Stripe path does.
   */
  @Post('payments/local/complete')
  @HttpCode(202)
  async completeLocal(
    @Body() body: { sessionId: string; orderId: string; outcome: 'succeeded' | 'failed' | 'expired' },
  ) {
    if (!(this.gateway instanceof LocalPaymentGateway)) {
      throw new ServiceUnavailableException({
        error: 'LOCAL_PAYMENTS_DISABLED',
        message: 'Stripe is configured; complete the payment through Stripe Checkout instead.',
      });
    }

    const payload = JSON.stringify(this.gateway.buildEvent(body));
    const signature = this.gateway.sign(payload);
    const url = `http://127.0.0.1:${process.env.PORT ?? 3000}/webhooks/payments`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-payment-signature': signature },
      body: payload,
    });

    if (!response.ok) {
      this.logger.error(`local webhook delivery failed: ${response.status}`);
      throw new BadRequestException({ error: 'WEBHOOK_DELIVERY_FAILED', status: response.status });
    }

    return { delivered: true, traceId: currentTraceId() };
  }
}
