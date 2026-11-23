import { Server as HttpServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { env } from '../config/env.js';
import { prisma } from './prisma.js';
import { getRiderGpsPing } from '../utils/domainRules.js';
import { verifyAuthToken } from '../middlewares/auth.js';

let io: SocketIOServer | null = null;

function leaveAllPrivateRooms(socket: Socket): void {
  for (const room of socket.rooms) {
    if (room.startsWith('room:')) {
      socket.leave(room);
    }
  }
}

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
      if (verifiedUser.role === 'ADMIN') {
        socket.join('room:admin');
      } else if (verifiedUser.role === 'CUSTOMER') {
        socket.join(`room:customer:${verifiedUser.sub}`);
      }
    }

    // Permite autenticar o cambiar de cuenta en el socket limpiando SIEMPRE las salas previas
    socket.on('auth:identify', (token: string) => {
      leaveAllPrivateRooms(socket);
      socket.data.user = undefined;

      const user = typeof token === 'string' ? verifyAuthToken(token) : null;
      if (!user) return;
      socket.data.user = user;
      if (user.role === 'ADMIN') {
        socket.join('room:admin');
      } else if (user.role === 'CUSTOMER') {
        socket.join(`room:customer:${user.sub}`);
      }
    });

    // Limpieza explícita de salas al cerrar sesión para evitar fugas entre roles/usuarios
    socket.on('auth:logout', () => {
      leaveAllPrivateRooms(socket);
      socket.data.user = undefined;
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
        const ping = getRiderGpsPing(socket.data.user, payload);
        if (!ping) return;
        const { orderId, riderId, sessionId, coordinates } = ping;
        const timestamp = new Date().toISOString();
        try {
          // La misma escritura comprueba la asignación, el estado y la sesión.
          const rows = await prisma.$queryRaw<{ customerId: string; riderName: string }[]>`
            UPDATE orders AS o
               SET payload = COALESCE(o.payload, '{}'::jsonb) || ${JSON.stringify({
                 riderLiveCoordinates: coordinates, riderLastLocationUpdate: timestamp,
               })}::jsonb
              FROM users AS u, refresh_sessions AS s
             WHERE o.id = ${orderId} AND o."assignedRiderUserId" = ${riderId}
               AND o.status IN ('asignado','recolectado','en_camino','afuera_del_domicilio')
               AND u.id = o."assignedRiderUserId" AND u.role = 'RIDER' AND u.status = 'activo'
               AND s.id = ${sessionId} AND s."userId" = u.id AND s."revokedAt" IS NULL
               AND s."expiresAt" > CURRENT_TIMESTAMP
            RETURNING o."customerId", u.name AS "riderName"
          `;
          if (!rows.length) return;
          const { customerId, riderName } = rows[0];
          io?.to('room:admin').to(`room:customer:${customerId}`)
            .emit('order:rider-location', { orderId, riderName, coordinates, timestamp });
        } catch {
          console.warn('[GPS] No se pudo guardar la ubicación del repartidor.');
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
export function emitOrderEvent(event: string, order: { id: string; customerId: string; assignedRiderUserId?: string | null }): void {
  if (!io || !order?.customerId) return;
  io.to('room:admin')
    .to(`room:customer:${order.customerId}`)
    .to(`room:rider:${order.assignedRiderUserId || ''}`)
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
