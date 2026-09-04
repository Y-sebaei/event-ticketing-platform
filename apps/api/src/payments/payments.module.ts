import { Logger, Module } from '@nestjs/common';
import { InventoryClient } from '../common/inventory.client';
import { LocalPaymentGateway } from './local.gateway';
import { PAYMENT_GATEWAY, type PaymentGateway } from './payment-gateway';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { StripeGateway } from './stripe.gateway';

/**
 * Which gateway is in play is decided once, here, by whether a Stripe secret
 * key is present. Nothing downstream branches on it: the rest of the codebase
 * knows only the PaymentGateway interface.
 */
@Module({
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    InventoryClient,
    {
      provide: PAYMENT_GATEWAY,
      useFactory: (): PaymentGateway => {
        const logger = new Logger('payments');
        const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
        const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();

        if (secretKey && webhookSecret) {
          logger.log('using Stripe test mode');
          return new StripeGateway(secretKey, webhookSecret);
        }

        if (secretKey && !webhookSecret) {
          logger.warn(
            'STRIPE_SECRET_KEY is set but STRIPE_WEBHOOK_SECRET is not; falling back to the local gateway',
          );
        } else {
          logger.log('no Stripe key configured; using the local payment gateway');
        }

        return new LocalPaymentGateway(
          process.env.LOCAL_PAYMENT_WEBHOOK_SECRET ?? 'whsec_local_dev_secret',
          process.env.PUBLIC_WEB_URL ?? 'http://localhost:5173',
        );
      },
    },
  ],
  exports: [PAYMENT_GATEWAY, PaymentsService],
})
export class PaymentsModule {}
