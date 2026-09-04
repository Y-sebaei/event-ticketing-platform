import { Module } from '@nestjs/common';
import { InventoryClient } from '../common/inventory.client';
import { PaymentsModule } from '../payments/payments.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  imports: [PaymentsModule],
  controllers: [OrdersController],
  providers: [OrdersService, InventoryClient],
  exports: [OrdersService],
})
export class OrdersModule {}
