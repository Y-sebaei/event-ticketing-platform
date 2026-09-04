import { Global, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { Client as ElasticClient } from '@elastic/elasticsearch';
import { GRPC_LOADER_OPTIONS, INVENTORY_PACKAGE, inventoryProtoPath } from '@ticketing/contracts';
import { OutboxRelay, createKafka, createPool, type Pool, type Producer } from '@ticketing/platform';

import { ELASTIC_CLIENT, INVENTORY_CLIENT, KAFKA_PRODUCER, ORDERING_RELAY, PG_POOL } from './tokens';

export { ELASTIC_CLIENT, INVENTORY_CLIENT, KAFKA_PRODUCER, ORDERING_RELAY, PG_POOL };

@Global()
@Module({
  imports: [
    // The order service's only route to inventory. There is no REST fallback
    // and no direct database access; the gRPC contract is the boundary.
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
  providers: [
    { provide: PG_POOL, useFactory: () => createPool() },
    {
      provide: ELASTIC_CLIENT,
      useFactory: () =>
        new ElasticClient({
          node: process.env.ELASTICSEARCH_URL ?? 'http://localhost:9200',
          // Search must never be the reason a page fails to load: a slow
          // Elasticsearch degrades to a Postgres-backed listing instead.
          requestTimeout: 3_000,
          maxRetries: 1,
        }),
    },
    {
      provide: KAFKA_PRODUCER,
      useFactory: async (): Promise<Producer> => {
        const producer = createKafka('api').producer({ allowAutoTopicCreation: true });
        await producer.connect();
        return producer;
      },
    },
    {
      provide: ORDERING_RELAY,
      inject: [PG_POOL, KAFKA_PRODUCER],
      useFactory: (pool: Pool, producer: Producer) => {
        const logger = new Logger('ordering-outbox');
        const relay = new OutboxRelay({
          pool,
          producer,
          schema: 'ordering',
          onError: (err) => logger.error(`relay tick failed: ${err.message}`),
        });
        relay.start();
        return relay;
      },
    },
  ],
  exports: [PG_POOL, KAFKA_PRODUCER, ELASTIC_CLIENT, ORDERING_RELAY, ClientsModule],
})
export class InfraModule implements OnApplicationShutdown {
  onApplicationShutdown(): void {
    // Relay timers are unref'd; Nest closes the pool and Kafka clients.
  }
}
