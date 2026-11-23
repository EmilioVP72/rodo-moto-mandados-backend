import crypto from 'crypto';
import { FastifyInstance } from 'fastify';
import { prisma } from '../../infra/prisma.js';
import { getCache, setCache, invalidateCache } from '../../infra/redis.js';
import { broadcastEvent, emitAdminEvent } from '../../infra/socket.js';
import { requireAdmin } from '../../middlewares/auth.js';

const RESTAURANTS_CACHE_KEY = 'rodo:catalog:restaurants';
const PARTNER_LOCALS_CACHE_KEY = 'rodo:catalog:partner_locals';

function normalizePinCode(raw?: unknown): string {
  return String(raw || '').replace(/[^0-9]/g, '').slice(0, 4);
}

async function collectUsedServerLocalCodes(excludeRestaurantId?: string): Promise<Set<string>> {
  const used = new Set<string>();
  const excludedPartnerId = excludeRestaurantId
    ? `loc-${excludeRestaurantId.replace(/[^a-zA-Z0-9_-]/g, '')}`
    : null;

  const [restaurants, partnerLocals] = await Promise.all([
    prisma.restaurant.findMany({ select: { id: true, payload: true } }),
    prisma.partnerLocal.findMany({ select: { id: true, code: true } }),
  ]);

  for (const r of restaurants) {
    if (excludeRestaurantId && r.id === excludeRestaurantId) continue;
    const code = normalizePinCode((r.payload as any)?.localCode);
    if (code.length === 3) used.add(code);
  }
  for (const l of partnerLocals) {
    if (excludedPartnerId && l.id === excludedPartnerId) continue;
    const code = normalizePinCode(l.code);
    if (code.length === 3) used.add(code);
  }
  return used;
}

function pickRandomUniquePin(usedCodes: Set<string>): string {
  const available3: string[] = [];
  for (let n = 100; n <= 999; n++) {
    const candidate = String(n);
    if (!usedCodes.has(candidate)) available3.push(candidate);
  }
  if (available3.length > 0) {
    return available3[crypto.randomInt(0, available3.length)];
  }
  for (let n = 1000; n <= 9999; n++) {
    const candidate = String(n);
    if (!usedCodes.has(candidate)) return candidate;
  }
  return String(crypto.randomInt(1000, 9999));
}

export async function catalogRoutes(app: FastifyInstance): Promise<void> {
  // 1. RESTAURANTES Y COMERCIOS
  app.get('/api/restaurants', async (_request, reply) => {
    const cached = await getCache<any[]>(RESTAURANTS_CACHE_KEY);
    if (Array.isArray(cached)) {
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

  app.put('/api/restaurants/:id', { preHandler: [requireAdmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as any;
    if (!body || !body.name) {
      return reply.status(400).send({ error: 'Datos del restaurante incompletos.' });
    }

    const usedCodes = await collectUsedServerLocalCodes(id);
    const requestedCode = normalizePinCode(body.localCode);

    let assignedCode: string;
    if (requestedCode.length === 3) {
      if (usedCodes.has(requestedCode)) {
        return reply.status(409).send({
          error: `El código local #${requestedCode} ya está asignado a otro establecimiento. Genera un nuevo código aleatorio único.`,
        });
      }
      assignedCode = requestedCode;
    } else {
      assignedCode = pickRandomUniquePin(usedCodes);
    }

    const restaurantPayload = {
      ...body,
      id,
      localCode: assignedCode,
    };

    const linkedPartnerId = `loc-${id.replace(/[^a-zA-Z0-9_-]/g, '')}`;

    await prisma.$transaction(async (tx) => {
      await tx.restaurant.upsert({
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

      // Sincronizar automáticamente el código único del establecimiento en partner_locals
      await tx.partnerLocal.upsert({
        where: { id: linkedPartnerId },
        update: {
          code: assignedCode,
          name: String(body.name),
          phone: String(body.phone || '4151019920'),
          serviceFee: Number(body.deliveryFee ?? 35),
          address: body.address || {
            calle: 'Centro',
            numero: 'S/N',
            colonia: 'Centro',
            lat: body.coordinates?.lat || 20.9144,
            lng: body.coordinates?.lng || -100.7437,
          },
          contactPerson: body.contactPerson || null,
          notes: body.description || null,
          isActive: Boolean(body.isActive ?? true),
        },
        create: {
          id: linkedPartnerId,
          code: assignedCode,
          name: String(body.name),
          phone: String(body.phone || '4151019920'),
          serviceFee: Number(body.deliveryFee ?? 35),
          address: body.address || {
            calle: 'Centro',
            numero: 'S/N',
            colonia: 'Centro',
            lat: body.coordinates?.lat || 20.9144,
            lng: body.coordinates?.lng || -100.7437,
          },
          contactPerson: body.contactPerson || null,
          notes: body.description || null,
          isActive: Boolean(body.isActive ?? true),
        },
      });
    });

    await invalidateCache(RESTAURANTS_CACHE_KEY);
    await invalidateCache(PARTNER_LOCALS_CACHE_KEY);
    broadcastEvent('restaurants:updated', restaurantPayload);
    return reply.send(restaurantPayload);
  });

  app.delete('/api/restaurants/:id', { preHandler: [requireAdmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const linkedPartnerId = `loc-${id.replace(/[^a-zA-Z0-9_-]/g, '')}`;
    await prisma.$transaction([
      prisma.restaurant.deleteMany({ where: { id } }),
      prisma.partnerLocal.deleteMany({ where: { id: linkedPartnerId } }),
    ]);
    await invalidateCache(RESTAURANTS_CACHE_KEY);
    await invalidateCache(PARTNER_LOCALS_CACHE_KEY);
    broadcastEvent('restaurants:deleted', { id });
    emitAdminEvent('partner-locals:deleted', { id: linkedPartnerId });
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

  app.put('/api/partner-locals/:id', { preHandler: [requireAdmin] }, async (request, reply) => {
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
    emitAdminEvent('partner-locals:updated', saved);
    return reply.send(saved);
  });

  app.delete('/api/partner-locals/:id', { preHandler: [requireAdmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await prisma.partnerLocal.deleteMany({ where: { id } });
    await invalidateCache(PARTNER_LOCALS_CACHE_KEY);
    emitAdminEvent('partner-locals:deleted', { id });
    return reply.send({ ok: true, id });
  });
}
