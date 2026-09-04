import { Body, Controller, Get, Headers, Param, Post, Query, UsePipes } from '@nestjs/common';
import { currentTraceId } from '@ticketing/otel';
import { ZodValidationPipe } from '../common/zod.pipe';
import { checkoutSchema, type CheckoutInput } from './orders.dto';
import { OrdersService } from './orders.service';

@Controller()
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  /**
   * The trace id comes back in the response body. It is what makes the README's
   * "See a distributed trace" section three commands rather than a hunt through
   * Grafana for the right span.
   */
  @Post('checkout')
  @UsePipes(new ZodValidationPipe(checkoutSchema))
  async checkout(
    @Body() body: CheckoutInput,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const result = await this.orders.checkout(body, idempotencyKey);
    return { ...result, traceId: currentTraceId() };
  }

  @Get('orders/:id')
  async get(@Param('id') id: string, @Query('token') token: string) {
    return this.orders.getOrder(id, token ?? '');
  }
}
