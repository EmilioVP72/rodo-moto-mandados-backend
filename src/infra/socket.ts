import { Server as HttpServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { env } from '../config/env.js';

let io: SocketIOServer | null = null;

export function initSocketServer(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(','),
      credentials: true,
    },
    path: '/socket.io',
    transports: ['websocket', 'polling'],
  });

  io.on('connection', (socket: Socket) => {
    socket.on('join:role', (role: string) => {
      if (role === 'ADMIN' || role === 'DISPATCH') {
        socket.join('room:admin');
      }
    });

    socket.on('join:customer', (customerId: string) => {
      if (customerId) {
        socket.join(`room:customer:${customerId}`);
      }
    });

    socket.on('join:order', (orderIdOrFolio: string) => {
      if (orderIdOrFolio) {
        socket.join(`room:order:${orderIdOrFolio}`);
      }
    });

    socket.on('rider:location', (payload: { orderId: string; lat: number; lng: number }) => {
      if (payload?.orderId && typeof payload.lat === 'number' && typeof payload.lng === 'number') {
        io?.emit('order:rider-location', {
          orderId: payload.orderId,
          coordinates: { lat: payload.lat, lng: payload.lng },
          timestamp: new Date().toISOString(),
        });
      }
    });
  });

  console.log('[Socket.IO] Real-time dispatch bus initialized');
  return io;
}

export function getIO(): SocketIOServer | null {
  return io;
}

export function broadcastEvent(event: string, data: unknown): void {
  if (!io) return;
  io.emit(event, data);
}
