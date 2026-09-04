import { Injectable, Logger } from '@nestjs/common';
import { withSpan } from '@ticketing/otel';
import { createTransport, type Transporter } from 'nodemailer';

/**
 * Confirmation email. Mailpit is in the compose file, so a reviewer can open
 * http://localhost:8025 and read the actual message rather than take a log line
 * on trust.
 *
 * Sending is deliberately best-effort: it happens after the tickets are
 * committed, and a failure is logged rather than thrown. Throwing would send
 * the message back to Kafka for redelivery, and the redelivery would find the
 * tickets already issued and skip — sending nothing, forever. A customer with
 * tickets and no email is a support ticket; a customer with no tickets is a
 * refund.
 */
@Injectable()
export class Mailer {
  private readonly logger = new Logger(Mailer.name);
  private readonly transport: Transporter;

  constructor() {
    this.transport = createTransport({
      host: process.env.SMTP_HOST ?? 'localhost',
      port: Number(process.env.SMTP_PORT ?? 1025),
      secure: false,
      ignoreTLS: true,
    });
  }

  async sendConfirmation(input: {
    to: string;
    name: string;
    orderId: string;
    eventTitle: string;
    serials: string[];
    totalCents: number;
    currency: string;
  }): Promise<boolean> {
    return withSpan('mail.sendConfirmation', { 'order.id': input.orderId }, async () => {
      const total = (input.totalCents / 100).toFixed(2);
      try {
        await this.transport.sendMail({
          from: 'tickets@example.berlin',
          to: input.to,
          subject: `Your tickets for ${input.eventTitle}`,
          text: [
            `Hi ${input.name},`,
            '',
            `Your order ${input.orderId} is confirmed.`,
            `Total paid: ${total} ${input.currency}`,
            '',
            'Tickets:',
            ...input.serials.map((s) => `  - ${s}`),
            '',
            'Show this email at the door.',
          ].join('\n'),
        });
        return true;
      } catch (err) {
        this.logger.warn(`confirmation email for ${input.orderId} failed: ${(err as Error).message}`);
        return false;
      }
    });
  }
}
