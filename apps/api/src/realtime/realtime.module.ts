import { Module } from '@nestjs/common';
import { RealtimeConsumer } from './realtime.consumer';
import { RealtimeGateway } from './realtime.gateway';

@Module({
  providers: [RealtimeGateway, RealtimeConsumer],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
