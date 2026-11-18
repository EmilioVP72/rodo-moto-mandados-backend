import { Server as HttpServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { env } from '../config/env.js';
import { prisma } from './prisma.js';
import { validateGpsCoordinates } from '../utils/domainRules.js';
import { verifyAuthToken } from '../middlewares/auth.js';

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
    const rawToken =
      (socket.handshake.auth && typeof socket.handshake.auth.token === 'string'
        ? socket.handshake.auth.token
        : '') ||
      (typeof socket.handshake.headers.authorization === 'string' &&
      socket.handshake.headers.authorization.startsWith('Bearer ')
        ? socket.handshake.headers.authorization.slice(7).trim()
        : '');

    const verifiedUser = rawToken ? verifyAuthToken(rawToken) : null;

    if (verifiedUser) {
      socket.data.user = verifiedUser;
      socket.join(`room:customer:${verifiedUser.sub}`);
      if (verifiedUser.role === 'ADMIN') {
        socket.join('room:admin');
      }
    }

    // Permite autenticar el socket después de hacer login sin recrear la conexión
    socket.on('auth:identify', (token: string) => {
      const user = typeof token === 'string' ? verifyAuthToken(token) : null;
      if (!user) return;
      socket.data.user = user;
      socket.join(`room:customer:${user.sub}`);
      if (user.role === 'ADMIN') {
        socket.join('room:admin');
      }
    });

    socket.on('join:order', async (orderIdOrFolio: string) => {
      const user = socket.data.user;
      if (!user || !orderIdOrFolio) return;

      const order = await prisma.order.findFirst({
        where: {
          OR: [{ id: orderIdOrFolio }, { folio: orderIdOrFolio }],
        },
        select: { id: true, customerId: true },
      });

      if (order && (user.role === 'ADMIN' || order.customerId === user.sub)) {
        socket.join(`room:order:${order.id}`);
      }
    });

    socket.on(
      'rider:location',
      async (payload: { orderId: string; lat: number; lng: number; riderName?: string }) => {
        if (!payload?.orderId) return;
        const check = validateGpsCoordinates(payload.lat, payload.lng);
        if (!check.valid) return;

        const existing = await prisma.order.findUnique({ where: { id: String(payload.orderId) } });
        if (!existing) return;

        const nowIso = new Date().toISOString();
        const locationEvent = {
          orderId: existing.id,
          coordinates: { lat: check.lat, lng: check.lng },
          riderName: payload.riderName,
          timestamp: nowIso,
        };

        // Emitir coordenadas GPS únicamente al dueño de la orden, sala de la orden y admins
        io?.to('room:admin')
          .to(`room:customer:${existing.customerId}`)
          .to(`room:order:${existing.id}`)
          .emit('order:rider-location', locationEvent);

        try {
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
        } catch {
          // Non-blocking DB update for high-frequency GPS pings
        }
      }
    );
  });

  console.log('[Socket.IO] Authenticated real-time dispatch & GPS tracking bus initialized');
  return io;
}

export function getIO(): SocketIOServer | null {
  return io;
}

/**
 * Emisión pública (catálogo de restaurantes, pausa por lluvia, broadcasts promocionales)
 */
export function broadcastEvent(event: string, data: unknown): void {
  if (!io) return;
  io.emit(event, data);
}

/**
 * Emisión aislada por privacidad: solo el cliente propietario de la orden y los administradores reciben el evento.
 */
export function emitOrderEvent(event: string, order: { id: string; customerId: string }): void {
  if (!io || !order?.customerId) return;
  io.to('room:admin')
    .to(`room:customer:${order.customerId}`)
    .to(`room:order:${order.id}`)
    .emit(event, order);
}

/**
 * Emisión exclusiva para administradores (cuentas, auditoría, solicitudes de recuperación)
 */
export function emitAdminEvent(event: string, data: unknown): void {
  if (!io) return;
  io.to('room:admin').emit(event, data);
}
