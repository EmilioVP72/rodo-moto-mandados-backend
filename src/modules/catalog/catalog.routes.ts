import { FastifyInstance } from 'fastify';
import { prisma } from '../../infra/prisma.js';
import { getCache, setCache, invalidateCache } from '../../infra/redis.js';
import { broadcastEvent } from '../../infra/socket.js';

const RESTAURANTS_CACHE_KEY = 'rodo:catalog:restaurants';
const PARTNER_LOCALS_CACHE_KEY = 'rodo:catalog:partner_locals';

export async function catalogRoutes(app: FastifyInstance): Promise<void> {
  // 1. RESTAURANTES Y COMERCIOS
  app.get('/api/restaurants', async (_request, reply) => {
    const cached = await getCache<any[]>(RESTAURANTS_CACHE_KEY);
    if (cached && cached.length > 0) {
      return reply.send(cached);
    }

    const rows = await prisma.restaurant.findMany({
      orderBy: { createdAt: 'asc' },
    });

    const list = rows.map((r) => ({
      ...(r.payload as Record<string, unknown>),
      id: r.id,
      name: r.name,
      establishmentType: r.establishmentType,
      category: r.category,
      deliveryFee: r.deliveryFee,
      commissionRate: r.commissionRate,
      isActive: r.isActive,
      isOpen: r.isOpen,
    }));

    await setCache(RESTAURANTS_CACHE_KEY, list, 120);
    return reply.send(list);
  });

  app.put('/api/restaurants/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as any;
    if (!body || !body.name) {
      return reply.status(400).send({ error: 'Datos del restaurante incompletos.' });
    }

    const restaurantPayload = {
      ...body,
      id,
    };

    await prisma.restaurant.upsert({
      where: { id },
      update: {
        name: String(body.name),
        establishmentType: String(body.establishmentType || 'restaurante'),
        category: String(body.category || 'General'),
        deliveryFee: Number(body.deliveryFee ?? 35),
        commissionRate: Number(body.commissionRate ?? 15),
        isActive: Boolean(body.isActive ?? true),
        isOpen: Boolean(body.isOpen ?? true),
        payload: restaurantPayload,
      },
      create: {
        id,
        name: String(body.name),
        establishmentType: String(body.establishmentType || 'restaurante'),
        category: String(body.category || 'General'),
        deliveryFee: Number(body.deliveryFee ?? 35),
        commissionRate: Number(body.commissionRate ?? 15),
        isActive: Boolean(body.isActive ?? true),
        isOpen: Boolean(body.isOpen ?? true),
        payload: restaurantPayload,
      },
    });

    await invalidateCache(RESTAURANTS_CACHE_KEY);
    broadcastEvent('restaurants:updated', restaurantPayload);
    return reply.send(restaurantPayload);
  });

  app.delete('/api/restaurants/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await prisma.restaurant.deleteMany({ where: { id } });
    await invalidateCache(RESTAURANTS_CACHE_KEY);
    broadcastEvent('restaurants:deleted', { id });
    return reply.send({ ok: true, id });
  });

  // 2. LOCALES ASOCIADOS CON CÓDIGO PIN DE 3 DÍGITOS
  app.get('/api/partner-locals', async (_request, reply) => {
    const cached = await getCache<any[]>(PARTNER_LOCALS_CACHE_KEY);
    if (cached && cached.length > 0) {
      return reply.send(cached);
    }

    const rows = await prisma.partnerLocal.findMany({
      orderBy: { code: 'asc' },
    });

    const list = rows.map((l) => ({
      id: l.id,
      code: l.code,
      name: l.name,
      phone: l.phone,
      serviceFee: l.serviceFee,
      address: l.address,
      contactPerson: l.contactPerson || undefined,
      notes: l.notes || undefined,
      isActive: l.isActive,
      createdAt: l.createdAt.toISOString(),
    }));

    await setCache(PARTNER_LOCALS_CACHE_KEY, list, 120);
    return reply.send(list);
  });

  app.get('/api/partner-locals/code/:code', async (request, reply) => {
    const { code } = request.params as { code: string };
    const cleanCode = code.trim();
    const local = await prisma.partnerLocal.findUnique({
      where: { code: cleanCode },
    });

    if (!local || !local.isActive) {
      return reply.status(404).send({ error: 'Código de local no encontrado o inactivo.' });
    }

    return reply.send({
      id: local.id,
      code: local.code,
      name: local.name,
      phone: local.phone,
      serviceFee: local.serviceFee,
      address: local.address,
      contactPerson: local.contactPerson || undefined,
      notes: local.notes || undefined,
      isActive: local.isActive,
    });
  });

  app.put('/api/partner-locals/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as any;
    if (!body || !body.name || !body.code) {
      return reply.status(400).send({ error: 'Nombre y código de 3 dígitos son obligatorios.' });
    }

    const cleanCode = String(body.code).trim();

    // Si otro local tenía ese código, liberarlo primero
    await prisma.partnerLocal.updateMany({
      where: {
        code: cleanCode,
        NOT: { id },
      },
      data: {
        code: `OLD-${Date.now().toString().slice(-4)}`,
      },
    });

    const saved = await prisma.partnerLocal.upsert({
      where: { id },
      update: {
        code: cleanCode,
        name: String(body.name),
        phone: String(body.phone || ''),
        serviceFee: Number(body.serviceFee ?? 35),
        address: body.address || {},
        contactPerson: body.contactPerson || null,
        notes: body.notes || null,
        isActive: Boolean(body.isActive ?? true),
      },
      create: {
        id,
        code: cleanCode,
        name: String(body.name),
        phone: String(body.phone || ''),
        serviceFee: Number(body.serviceFee ?? 35),
        address: body.address || {},
        contactPerson: body.contactPerson || null,
        notes: body.notes || null,
        isActive: Boolean(body.isActive ?? true),
      },
    });

    await invalidateCache(PARTNER_LOCALS_CACHE_KEY);
    broadcastEvent('partner-locals:updated', saved);
    return reply.send(saved);
  });

  app.delete('/api/partner-locals/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    await prisma.partnerLocal.deleteMany({ where: { id } });
    await invalidateCache(PARTNER_LOCALS_CACHE_KEY);
    broadcastEvent('partner-locals:deleted', { id });
    return reply.send({ ok: true, id });
  });
}
