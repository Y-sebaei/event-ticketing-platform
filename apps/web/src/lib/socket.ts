import { io, type Socket } from 'socket.io-client';

let socket: Socket | undefined;

/**
 * One shared connection for the whole tab. Opening a socket per component would
 * multiply connections by the number of mounted views for no benefit — rooms
 * already do the filtering.
 */
export function getSocket(): Socket {
  if (!socket) {
    socket = io({ path: '/socket.io', transports: ['websocket', 'polling'] });
  }
  return socket;
}

export interface InventoryChange {
  eventId: string;
  reason: 'hold' | 'commit' | 'release' | 'register';
  items: { ticketTypeId: string; quantityAvailable: number; quantityTotal: number }[];
}

export function subscribeToEvent(eventId: string, onChange: (change: InventoryChange) => void): () => void {
  const s = getSocket();
  const handler = (change: InventoryChange) => {
    if (change.eventId === eventId) onChange(change);
  };

  s.emit('subscribe:event', eventId);
  s.on('inventory:changed', handler);
  // Re-subscribing on reconnect matters: the server has no memory of which
  // rooms a socket was in once the socket is gone.
  s.on('connect', () => s.emit('subscribe:event', eventId));

  return () => {
    s.emit('unsubscribe:event', eventId);
    s.off('inventory:changed', handler);
  };
}

export function subscribeToOrder(orderId: string, onUpdate: (update: unknown) => void): () => void {
  const s = getSocket();
  s.emit('subscribe:order', orderId);
  s.on('order:updated', onUpdate);
  s.on('connect', () => s.emit('subscribe:order', orderId));
  return () => s.off('order:updated', onUpdate);
}
