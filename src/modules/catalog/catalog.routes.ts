import crypto from 'crypto';
import { FastifyInstance } from 'fastify';
import { prisma } from '../../infra/prisma.js';
import { getCache, setCache, invalidateCache } from '../../infra/redis.js';
import { broadcastEvent, emitAdminEvent } from '../../infra/socket.js';
import { extractUserFromRequest, requireAdmin } from '../../middlewares/auth.js';
import {
  validatePartnerLocalPayload,
  validateRestaurantPayload,
} from '../../utils/inputSanitizer.js';

const RESTAURANTS_CACHE_KEY = 'rodo:catalog:restaurants';
const PARTNER_LOCALS_CACHE_KEY = 'rodo:catalog:partner_locals';

function sanitizeRestaurantForClient(item: Record<string, unknown>, isAdmin: boolean): Record<string, unknown> {
  if (isAdmin) return item;
  const copy = { ...item };
  delete copy.localCode;
  delete copy.contactPerson;
  return copy;
}

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
  // 1. RESTAURANTES Y COMERCIOS (Oculta códigos PIN internos a visitantes y clientes)
  app.get('/api/restaurants', async (request, reply) => {
    const isAdmin = extractUserFromRequest(request)?.role === 'ADMIN';
    const cached = await getCache<any[]>(RESTAURANTS_CACHE_KEY);
    if (Array.isArray(cached)) {
      return reply.send(cached.map((r) => sanitizeRestaurantForClient(r, isAdmin)));
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
    return reply.send(list.map((r) => sanitizeRestaurantForClient(r, isAdmin)));
  });

  app.put('/api/restaurants/:id', { preHandler: [requireAdmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const validated = validateRestaurantPayload(request.body);
    if (!validated.success) {
      return reply.status(400).send({ error: validated.error });
    }
    const body = validated.data;

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
          name: body.name,
          establishmentType: body.establishmentType,
          category: body.category,
          deliveryFee: body.deliveryFee,
          commissionRate: body.commissionRate,
          isActive: body.isActive,
          isOpen: body.isOpen,
          payload: restaurantPayload as any,
        },
        create: {
          id,
          name: body.name,
          establishmentType: body.establishmentType,
          category: body.category,
          deliveryFee: body.deliveryFee,
          commissionRate: body.commissionRate,
          isActive: body.isActive,
          isOpen: body.isOpen,
          payload: restaurantPayload as any,
        },
      });

      // Sincronizar automáticamente el código único del establecimiento en partner_locals
      await tx.partnerLocal.upsert({
        where: { id: linkedPartnerId },
        update: {
          code: assignedCode,
          name: body.name,
          phone: String(body.phone || '4151019920'),
          serviceFee: body.deliveryFee,
          address: (body.address || {
            calle: 'Centro',
            numero: 'S/N',
            colonia: 'Centro',
            lat: body.coordinates?.lat || 20.9144,
            lng: body.coordinates?.lng || -100.7437,
          }) as any,
          contactPerson: body.contactPerson || null,
          notes: body.description || null,
          isActive: body.isActive,
        },
        create: {
          id: linkedPartnerId,
          code: assignedCode,
          name: body.name,
          phone: String(body.phone || '4151019920'),
          serviceFee: body.deliveryFee,
          address: (body.address || {
            calle: 'Centro',
            numero: 'S/N',
            colonia: 'Centro',
            lat: body.coordinates?.lat || 20.9144,
            lng: body.coordinates?.lng || -100.7437,
          }) as any,
          contactPerson: body.contactPerson || null,
          notes: body.description || null,
          isActive: body.isActive,
        },
      });
    });

    await invalidateCache(RESTAURANTS_CACHE_KEY);
    await invalidateCache(PARTNER_LOCALS_CACHE_KEY);
    broadcastEvent('restaurants:updated', sanitizeRestaurantForClient(restaurantPayload, false));
    emitAdminEvent('restaurants:admin-updated', restaurantPayload);
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

  // 2. LOCALES ASOCIADOS CON CÓDIGO PIN DE 3 DÍGITOS (LISTADO EXCLUSIVO PARA ADMIN)
  app.get('/api/partner-locals', { preHandler: [requireAdmin] }, async (_request, reply) => {
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

  app.get(
    '/api/partner-locals/code/:code',
    { config: { rateLimit: { max: 8, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const { code } = request.params as { code: string };
      const cleanCode = code.trim();
      if (!/^\d{3,4}$/.test(cleanCode)) {
        return reply.status(404).send({ error: 'Código de local no encontrado o inactivo.' });
      }
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
        isActive: local.isActive,
      });
    }
  );

  app.put('/api/partner-locals/:id', { preHandler: [requireAdmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const validated = validatePartnerLocalPayload(request.body);
    if (!validated.success) {
      return reply.status(400).send({ error: validated.error });
    }
    const body = validated.data;
    const cleanCode = body.code;

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
        name: body.name,
        phone: body.phone,
        serviceFee: body.serviceFee,
        address: body.address as any,
        contactPerson: body.contactPerson || null,
        notes: body.notes || null,
        isActive: body.isActive,
      },
      create: {
        id,
        code: cleanCode,
        name: body.name,
        phone: body.phone,
        serviceFee: body.serviceFee,
        address: body.address as any,
        contactPerson: body.contactPerson || null,
        notes: body.notes || null,
        isActive: body.isActive,
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
