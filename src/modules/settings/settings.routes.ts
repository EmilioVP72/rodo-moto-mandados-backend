import { FastifyInstance } from 'fastify';
import { prisma } from '../../infra/prisma.js';
import { getCache, setCache, invalidateCache } from '../../infra/redis.js';
import { broadcastEvent } from '../../infra/socket.js';
import { requireAdmin, extractUserFromRequest } from '../../middlewares/auth.js';
import {
  stripDangerousKeysDeep,
  validateDispatchSettingsPayload,
} from '../../utils/inputSanitizer.js';

const SETTINGS_CACHE_KEY = 'rodo:settings:general';

function sanitizeSettingsForPublic(payload: Record<string, unknown>, _isAdmin: boolean) {
  return stripDangerousKeysDeep({ ...payload });
}

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/settings', async (request, reply) => {
    const user = extractUserFromRequest(request);
    const isAdmin = user?.role === 'ADMIN';

    const cached = await getCache<Record<string, unknown>>(SETTINGS_CACHE_KEY);
    if (cached) {
      return reply.send(sanitizeSettingsForPublic(cached, isAdmin));
    }

    const row = await prisma.setting.findUnique({ where: { id: 'general' } });
    const payload = (row?.payload || {}) as Record<string, unknown>;
    await setCache(SETTINGS_CACHE_KEY, payload, 120);
    return reply.send(sanitizeSettingsForPublic(payload, isAdmin));
  });

  app.put('/api/settings', { preHandler: [requireAdmin] }, async (request, reply) => {
    const validated = validateDispatchSettingsPayload(request.body);
    if (!validated.success) {
      return reply.status(400).send({ error: validated.error });
    }

    const existing = await prisma.setting.findUnique({ where: { id: 'general' } });
    const prevPayload = stripDangerousKeysDeep(
      { ...((existing?.payload as Record<string, unknown>) || {}) }
    );
    const merged = {
      ...prevPayload,
      ...validated.data,
    };

    await prisma.setting.upsert({
      where: { id: 'general' },
      update: { payload: merged as any },
      create: { id: 'general', payload: merged as any },
    });

    await invalidateCache(SETTINGS_CACHE_KEY);
    // Nunca emitir adminPasscode ni claves prohibidas por Socket.IO público
    broadcastEvent('settings:updated', sanitizeSettingsForPublic(merged, false));
    return reply.send(sanitizeSettingsForPublic(merged, true));
  });
}
