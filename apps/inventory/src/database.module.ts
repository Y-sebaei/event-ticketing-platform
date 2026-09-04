import { Global, Module, OnApplicationShutdown } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { OutboxRelay, createKafka, createPool, type Pool, type Producer } from '@ticketing/platform';

export const PG_POOL = Symbol('PG_POOL');
export const OUTBOX_RELAY = Symbol('OUTBOX_RELAY');
export const KAFKA_PRODUCER = Symbol('KAFKA_PRODUCER');

/**
 * The inventory service relays its own outbox. It has to: nothing else is
 * granted rights on the inventory schema, which is the point of the boundary.
 */
@Global()
@Module({
  providers: [
    { provide: PG_POOL, useFactory: () => createPool() },
    {
      provide: KAFKA_PRODUCER,
      useFactory: async (): Promise<Producer> => {
        const producer = createKafka('inventory').producer({ allowAutoTopicCreation: true });
        await producer.connect();
        return producer;
      },
    },
    {
      provide: OUTBOX_RELAY,
      inject: [PG_POOL, KAFKA_PRODUCER],
      useFactory: (pool: Pool, producer: Producer) => {
        const logger = new Logger('inventory-outbox');
        const relay = new OutboxRelay({
          pool,
          producer,
          schema: 'inventory',
          onError: (err) => logger.error(`relay tick failed: ${err.message}`),
        });
        relay.start();
        return relay;
      },
    },
  ],
  exports: [PG_POOL, OUTBOX_RELAY, KAFKA_PRODUCER],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor() {}

  async onApplicationShutdown(): Promise<void> {
    // Nest tears providers down for us; the relay unrefs its timer so the
    // process can exit even if a tick is scheduled.
  }
}
