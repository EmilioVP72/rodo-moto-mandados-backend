import { FastifyInstance } from 'fastify';
import { prisma } from '../../infra/prisma.js';
import { broadcastEvent, emitAdminEvent } from '../../infra/socket.js';
import { requireAdmin } from '../../middlewares/auth.js';

export async function notificationsRoutes(app: FastifyInstance): Promise<void> {
  async function publishDue() {
    const now = new Date();
    const due = await prisma.broadcastNotification.findMany({
      where: { publishedAt: null, publishAt: { lte: now } }, orderBy: { publishAt: 'asc' }, take: 100,
    });
    for (const campaign of due) {
      const claim = await prisma.broadcastNotification.updateMany({
        where: { id: campaign.id, publishedAt: null }, data: { publishedAt: now },
      });
      if (claim.count) broadcastEvent('broadcasts:created', { ...campaign, publishedAt: now });
    }
  }
  const timer = setInterval(() => publishDue().catch(() => console.error('[Campañas] No se pudo procesar la programación.')), 5000);
  timer.unref();
  app.addHook('onClose', async () => { clearInterval(timer); });

  app.get('/api/broadcasts', async () => prisma.broadcastNotification.findMany({
    where: { publishedAt: { not: null } }, orderBy: { publishedAt: 'desc' }, take: 30,
    select: { id: true, title: true, message: true, promoCode: true, publishedAt: true, createdAt: true },
  }));
  app.get('/api/admin/broadcasts', { preHandler: [requireAdmin] }, async () =>
    prisma.broadcastNotification.findMany({ orderBy: { storedAt: 'desc' }, take: 50 }));

  app.post('/api/broadcasts', { preHandler: [requireAdmin] }, async (request, reply) => {
    const body = request.body as any;
    if (!body?.title?.trim() || !body?.message?.trim()) return reply.code(400).send({ error: 'Completa título y mensaje.' });
    const now = new Date();
    const scheduled = Boolean(body.scheduledFor || body.sendImmediately === false);
    const publishAt = scheduled ? new Date(body.scheduledFor || '') : now;
    if (scheduled && (!/(Z|[+-]\d{2}:\d{2})$/.test(body.scheduledFor) || !Number.isFinite(+publishAt) || publishAt <= now))
      return reply.code(422).send({ error: 'Selecciona una fecha futura con zona horaria.' });
    const id = String(body.id || crypto.randomUUID());
    const campaign = await prisma.broadcastNotification.createMany({ data: [{
      id, title: body.title.trim(), message: body.message.trim(), promoCode: body.promoCode || null,
      scheduledFor: scheduled ? publishAt.toISOString() : null, publishAt, publishedAt: scheduled ? null : now,
      sendImmediately: !scheduled, sentBy: request.authUser!.email, createdAt: now.toISOString(),
    }], skipDuplicates: true });
    const saved = await prisma.broadcastNotification.findUniqueOrThrow({ where: { id } });
    if (campaign.count && !scheduled) broadcastEvent('broadcasts:created', saved);
    return reply.code(campaign.count ? 201 : 200).send(saved);
  });

  // 2. BITÁCORA INMUTABLE DE AUDITORÍA ADMINISTRATIVA (EXCLUSIVO ADMIN)
  app.get('/api/audit-logs', { preHandler: [requireAdmin] }, async (request, reply) => {
    const { limit = '100' } = request.query as { limit?: string };
    const takeCount = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));

    const rows = await prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: takeCount,
    });
    return reply.send(rows);
  });

  app.post('/api/audit-logs', { preHandler: [requireAdmin] }, async (request, reply) => {
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
        adminEmail: request.authUser!.email,
        adminUserId: request.authUser!.sub,
        actionType: String(body.actionType || body.action || 'accion_admin'),
        details: String(body.details || ''),
        affectedFolio: body.affectedFolio || body.affected_folio || null,
        affectedRestaurant: body.affectedRestaurant || body.affected_restaurant || null,
        previousValue: body.previousValue ?? body.previous_value ?? null,
        newValue: body.newValue ?? body.new_value ?? null,
        metadata: body.metadata || null,
      },
    });

    emitAdminEvent('audit:created', created);
    return reply.status(201).send(created);
  });
}
