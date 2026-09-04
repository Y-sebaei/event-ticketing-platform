import { hostname } from 'node:os';
import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { CONSUMER_GROUPS, TOPICS } from '@ticketing/contracts';
import { createKafka, startConsumer, type Consumer } from '@ticketing/platform';
import { RealtimeGateway } from './realtime.gateway';

/**
 * Fans Kafka messages out to connected browsers.
 *
 * The consumer group is unique per process — hostname plus pid — which is the
 * opposite of the usual arrangement, and deliberately so. Normally you want the
 * partitions shared across a consumer group so each message is handled once.
 * Here every API instance must see every inventory change, because each holds
 * its own set of WebSocket connections and can only push to those. Sharing the
 * partitions would mean a browser connected to instance A never hears about a
 * message that instance B consumed.
 *
 * The consequence is that these groups are disposable: they exist for the life
 * of one process. Nothing depends on their committed offsets, which is why this
 * consumer reads from the latest offset rather than the beginning — replaying
 * an hour of inventory history to a browser that just connected would be noise.
 */
@Injectable()
export class RealtimeConsumer implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RealtimeConsumer.name);
  private consumer?: Consumer;

  constructor(private readonly gateway: RealtimeGateway) {}

  async onModuleInit(): Promise<void> {
    const groupId = `${CONSUMER_GROUPS.REALTIME_FANOUT_PREFIX}-${hostname()}-${process.pid}`;

    this.consumer = await startConsumer({
      kafka: createKafka('api-realtime'),
      groupId,
      topics: [TOPICS.INVENTORY_CHANGED, TOPICS.ORDER_FULFILLED],
      fromBeginning: false,
      handle: async (message) => {
        const payload = message.envelope.payload as Record<string, unknown> | undefined;
        if (!payload) return;

        if (message.topic === TOPICS.INVENTORY_CHANGED) {
          this.gateway.broadcastInventory(String(payload.eventId), payload);
          return;
        }

        this.gateway.broadcastOrder(String(payload.orderId), {
          status: 'fulfilled',
          ticketCount: payload.ticketCount,
          serials: payload.serials,
        });
      },
    });

    this.logger.log(`realtime fan-out consuming as ${groupId}`);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.consumer?.disconnect().catch(() => {});
  }
}
