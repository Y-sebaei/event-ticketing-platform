import { Module } from '@nestjs/common';
import { DatabaseModule } from './database.module';
import { HealthController } from './health.controller';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { ReservationSweeper } from './reservation.sweeper';

@Module({
  imports: [DatabaseModule],
  controllers: [InventoryController, HealthController],
  providers: [InventoryService, ReservationSweeper],
})
export class AppModule {}
