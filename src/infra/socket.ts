import { Server as HttpServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { env } from '../config/env.js';
import { prisma } from './prisma.js';
import { validateGpsCoordinates } from '../utils/domainRules.js';

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

    socket.on(
      'rider:location',
      async (payload: { orderId: string; lat: number; lng: number; riderName?: string }) => {
        if (!payload?.orderId) return;
        const check = validateGpsCoordinates(payload.lat, payload.lng);
        if (!check.valid) return;

        const nowIso = new Date().toISOString();
        const locationEvent = {
          orderId: String(payload.orderId),
          coordinates: { lat: check.lat, lng: check.lng },
          riderName: payload.riderName,
          timestamp: nowIso,
        };

        io?.emit('order:rider-location', locationEvent);

        // Persistir última coordenada GPS del repartidor en PostgreSQL de forma no bloqueante
        try {
          const existing = await prisma.order.findUnique({ where: { id: String(payload.orderId) } });
          if (existing) {
            const prevPayload = (existing.payload || {}) as Record<string, unknown>;
            await prisma.order.update({
              where: { id: existing.id },
              data: {
                payload: {
                  ...prevPayload,
                  riderLiveCoordinates: { lat: check.lat, lng: check.lng },
                  riderLastLocationUpdate: nowIso,
                },
              },
            });
          }
        } catch {
          // Non-blocking DB update for high-frequency GPS pings
        }
      }
    );
  });

  console.log('[Socket.IO] Real-time dispatch & GPS tracking bus initialized');
  return io;
}

export function getIO(): SocketIOServer | null {
  return io;
}

export function broadcastEvent(event: string, data: unknown): void {
  if (!io) return;
  io.emit(event, data);
}
