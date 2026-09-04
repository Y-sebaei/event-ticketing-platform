import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { websocketConnections } from '@ticketing/otel';
import { Server, Socket } from 'socket.io';

/**
 * Rooms, not broadcasts. A browser on one event page has no business receiving
 * inventory updates for every other event, and at any real traffic level that
 * difference is the difference between a working socket server and a melted one.
 */
@WebSocketGateway({ cors: { origin: true, credentials: true } })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  private server!: Server;

  handleConnection(client: Socket): void {
    websocketConnections.add(1);
    this.logger.debug(`client ${client.id} connected`);
  }

  handleDisconnect(client: Socket): void {
    websocketConnections.add(-1);
    this.logger.debug(`client ${client.id} disconnected`);
  }

  @SubscribeMessage('subscribe:event')
  subscribeEvent(client: Socket, eventId: string): { subscribed: string } {
    void client.join(`event:${eventId}`);
    return { subscribed: `event:${eventId}` };
  }

  @SubscribeMessage('unsubscribe:event')
  unsubscribeEvent(client: Socket, eventId: string): { unsubscribed: string } {
    void client.leave(`event:${eventId}`);
    return { unsubscribed: `event:${eventId}` };
  }

  @SubscribeMessage('subscribe:order')
  subscribeOrder(client: Socket, orderId: string): { subscribed: string } {
    void client.join(`order:${orderId}`);
    return { subscribed: `order:${orderId}` };
  }

  /** Called by the Kafka consumer, once per inventory change. */
  broadcastInventory(eventId: string, payload: unknown): void {
    this.server?.to(`event:${eventId}`).emit('inventory:changed', payload);
  }

  broadcastOrder(orderId: string, payload: unknown): void {
    this.server?.to(`order:${orderId}`).emit('order:updated', payload);
  }
}
