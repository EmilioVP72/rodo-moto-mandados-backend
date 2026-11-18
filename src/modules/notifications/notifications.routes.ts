import { FastifyInstance } from 'fastify';
import { prisma } from '../../infra/prisma.js';
import { broadcastEvent } from '../../infra/socket.js';

export async function notificationsRoutes(app: FastifyInstance): Promise<void> {
  // 1. NOTIFICACIONES DE MARKETING / BROADCAST
  app.get('/api/broadcasts', async (_request, reply) => {
    const rows = await prisma.broadcastNotification.findMany({
      orderBy: { storedAt: 'desc' },
      take: 30,
    });
    return reply.send(rows);
  });

  app.post('/api/broadcasts', async (request, reply) => {
    const body = request.body as any;
    if (!body || !body.title || !body.message) {
      return reply.status(400).send({ error: 'Título y mensaje son requeridos.' });
    }

    const id = String(body.id || `notif-${Date.now()}`);
    const saved = await prisma.broadcastNotification.upsert({
      where: { id },
      update: {
        title: String(body.title),
        message: String(body.message),
        promoCode: body.promoCode || null,
        scheduledFor: body.scheduledFor || null,
        sendImmediately: Boolean(body.sendImmediately ?? true),
      },
      create: {
        id,
        title: String(body.title),
        message: String(body.message),
        promoCode: body.promoCode || null,
        scheduledFor: body.scheduledFor || null,
        sendImmediately: Boolean(body.sendImmediately ?? true),
        sentBy: String(body.sentBy || 'Admin RODO'),
        createdAt: String(body.createdAt || new Date().toISOString()),
      },
    });

    broadcastEvent('broadcasts:created', saved);
    return reply.status(201).send(saved);
  });

  // 2. BITÁCORA INMUTABLE DE AUDITORÍA ADMINISTRATIVA
  app.get('/api/audit-logs', async (request, reply) => {
    const { limit = '100' } = request.query as { limit?: string };
    const takeCount = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));

    const rows = await prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: takeCount,
    });
    return reply.send(rows);
  });

  app.post('/api/audit-logs', async (request, reply) => {
    const body = request.body as any;
    if (!body) {
      return reply.status(400).send({ error: 'Datos de auditoría vacíos.' });
    }

    const id = String(body.id || `audit-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    const created = await prisma.auditLog.upsert({
      where: { id },
      update: {},
      create: {
        id,
        timestamp: String(body.timestamp || new Date().toISOString()),
        adminEmail: String(body.adminEmail || body.user_id || 'edsoncruz14999@gmail.com'),
        actionType: String(body.actionType || body.action || 'accion_admin'),
        details: String(body.details || ''),
        affectedFolio: body.affectedFolio || body.affected_folio || null,
        affectedRestaurant: body.affectedRestaurant || body.affected_restaurant || null,
        previousValue: body.previousValue ?? body.previous_value ?? null,
        newValue: body.newValue ?? body.new_value ?? null,
        metadata: body.metadata || null,
      },
    });

    broadcastEvent('audit:created', created);
    return reply.status(201).send(created);
  });
}
