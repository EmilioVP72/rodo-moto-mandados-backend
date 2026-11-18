import { FastifyInstance } from 'fastify';
import { prisma } from '../../infra/prisma.js';
import { getCache, setCache, invalidateCache } from '../../infra/redis.js';
import { broadcastEvent } from '../../infra/socket.js';

const SETTINGS_CACHE_KEY = 'rodo:settings:general';

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/settings', async (_request, reply) => {
    const cached = await getCache<Record<string, unknown>>(SETTINGS_CACHE_KEY);
    if (cached) {
      return reply.send(cached);
    }

    const row = await prisma.setting.findUnique({ where: { id: 'general' } });
    const payload = (row?.payload || {}) as Record<string, unknown>;
    await setCache(SETTINGS_CACHE_KEY, payload, 120);
    return reply.send(payload);
  });

  app.put('/api/settings', async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    if (!body || typeof body !== 'object') {
      return reply.status(400).send({ error: 'Configuración inválida.' });
    }

    const existing = await prisma.setting.findUnique({ where: { id: 'general' } });
    const merged = {
      ...((existing?.payload as Record<string, unknown>) || {}),
      ...body,
    };

    await prisma.setting.upsert({
      where: { id: 'general' },
      update: { payload: merged as any },
      create: { id: 'general', payload: merged as any },
    });

    await invalidateCache(SETTINGS_CACHE_KEY);
    broadcastEvent('settings:updated', merged);
    return reply.send(merged);
  });
}
