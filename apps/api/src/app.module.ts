import { Module } from '@nestjs/common';
import { CatalogModule } from './catalog/catalog.module';
import { InfraModule } from './common/infra.module';
import { MetricsInterceptor } from './common/metrics.interceptor';
import { HealthController } from './health/health.controller';
import { OrdersModule } from './orders/orders.module';
import { PaymentsModule } from './payments/payments.module';
import { RealtimeModule } from './realtime/realtime.module';
import { SearchModule } from './search/search.module';

@Module({
  imports: [InfraModule, CatalogModule, SearchModule, OrdersModule, PaymentsModule, RealtimeModule],
  controllers: [HealthController],
  providers: [MetricsInterceptor],
})
export class AppModule {}
