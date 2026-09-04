import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { Client as ElasticClient } from '@elastic/elasticsearch';
import { GRPC_LOADER_OPTIONS, INVENTORY_PACKAGE, inventoryProtoPath } from '@ticketing/contracts';
import { createKafka, createPool, type Producer } from '@ticketing/platform';
import { FulfilmentConsumer } from './consumers/fulfilment.consumer';
import { SearchIndexerConsumer } from './consumers/search-indexer.consumer';
import { HealthController } from './health.controller';
import { InventoryClient } from './inventory.client';
import { Mailer } from './mailer';
import { ELASTIC_CLIENT, INVENTORY_CLIENT, KAFKA_PRODUCER, PG_POOL } from './tokens';

@Module({
  imports: [
    ClientsModule.register([
      {
        name: INVENTORY_CLIENT,
        transport: Transport.GRPC,
        options: {
          package: INVENTORY_PACKAGE,
          protoPath: inventoryProtoPath(),
          url: process.env.INVENTORY_GRPC_URL ?? 'localhost:50051',
          loader: { ...GRPC_LOADER_OPTIONS },
        },
      },
    ]),
  ],
  controllers: [HealthController],
  providers: [
    { provide: PG_POOL, useFactory: () => createPool() },
    {
      provide: ELASTIC_CLIENT,
      useFactory: () =>
        new ElasticClient({
          node: process.env.ELASTICSEARCH_URL ?? 'http://localhost:9200',
          requestTimeout: 5_000,
          maxRetries: 2,
        }),
    },
    {
      provide: KAFKA_PRODUCER,
      useFactory: async (): Promise<Producer> => {
        // Only used for dead-letter publishing; the worker's own outbox rows are
        // relayed by the API's relay, which already polls the ordering schema.
        const producer = createKafka('worker').producer({ allowAutoTopicCreation: true });
        await producer.connect();
        return producer;
      },
    },
    Mailer,
    InventoryClient,
    FulfilmentConsumer,
    SearchIndexerConsumer,
  ],
})
export class AppModule {}
