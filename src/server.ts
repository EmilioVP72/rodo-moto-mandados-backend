import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fs from 'fs/promises';
import path from 'path';
import { env } from './config/env.js';
import { connectDatabase, prisma } from './infra/prisma.js';
import { getRedisClient, invalidateCache } from './infra/redis.js';
import { initSocketServer } from './infra/socket.js';
import { runInitialDatabaseSeed } from './utils/seed.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { catalogRoutes } from './modules/catalog/catalog.routes.js';
import { ordersRoutes } from './modules/orders/orders.routes.js';
import { settingsRoutes } from './modules/settings/settings.routes.js';
import { notificationsRoutes } from './modules/notifications/notifications.routes.js';
import { routingRoutes } from './modules/routing/routing.routes.js';
import { uploadsRoutes } from './modules/uploads/uploads.routes.js';
import { ridersRoutes } from './modules/riders/riders.routes.js';

async function bootstrap() {
  const app = Fastify({
    logger: env.NODE_ENV === 'development',
    trustProxy: true,
    bodyLimit: 8 * 1024 * 1024, // 8 MB para permitir imágenes de evidencia o catálogos
  });

  // 1. Plugins de Seguridad y Red
  await app.register(cors, {
    origin:
      env.CORS_ORIGIN === '*'
        ? true
        : env.CORS_ORIGIN.split(',')
            .map((o) => o.trim())
            .filter(Boolean),
    credentials: true,
  });

  await app.register(helmet, {
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: false,
  });

  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
  });

  // 2. Directorio persistente de archivos subidos (/uploads)
  const uploadsRoot = path.resolve(env.UPLOADS_DIR);
  await fs.mkdir(uploadsRoot, { recursive: true });

  await app.register(fastifyStatic, {
    root: uploadsRoot,
    prefix: '/uploads/',
  });

  // 3. Healthcheck y Diagnóstico de Infraestructura
  app.get('/api/health', async () => {
    let dbOk = false;
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbOk = true;
    } catch {}
    const redis = getRedisClient();

    return {
      status: dbOk ? 'healthy' : 'degraded',
      service: 'rodo-moto-mandados-api',
      timestamp: new Date().toISOString(),
      database: dbOk ? 'connected' : 'disconnected',
      redis: redis ? 'connected' : 'fallback-mode',
    };
  });

  // 4. Endpoint de sincronización inicial de catálogo y configuración semilla
  app.post('/api/seed', async (request, reply) => {
    const body = request.body as {
      restaurants?: any[];
      settings?: Record<string, unknown>;
    };

    let seededRestaurants = 0;
    const currentRestCount = await prisma.restaurant.count();

    if (currentRestCount === 0 && Array.isArray(body?.restaurants) && body.restaurants.length > 0) {
      for (const r of body.restaurants) {
        if (!r?.id || !r?.name) continue;
        await prisma.restaurant.upsert({
          where: { id: String(r.id) },
          update: {},
          create: {
            id: String(r.id),
            name: String(r.name),
            establishmentType: String(r.establishmentType || 'restaurante'),
            category: String(r.category || 'General'),
            deliveryFee: Number(r.deliveryFee ?? 35),
            commissionRate: Number(r.commissionRate ?? 15),
            isActive: Boolean(r.isActive ?? true),
            isOpen: Boolean(r.isOpen ?? true),
            payload: r,
          },
        });
        seededRestaurants++;
      }
      await invalidateCache('rodo:catalog:restaurants');
    }

    const existingSettings = await prisma.setting.findUnique({ where: { id: 'general' } });
    if (!existingSettings && body?.settings) {
      await prisma.setting.create({
        data: {
          id: 'general',
          payload: body.settings as any,
        },
      });
      await invalidateCache('rodo:settings:general');
    }

    return reply.send({
      ok: true,
      seededRestaurants,
      totalRestaurants: currentRestCount + seededRestaurants,
    });
  });

  // 5. Registrar módulos de rutas de dominio
  await app.register(authRoutes);
  await app.register(catalogRoutes);
  await app.register(ordersRoutes);
  await app.register(settingsRoutes);
  await app.register(notificationsRoutes);
  await app.register(routingRoutes);
  await app.register(uploadsRoutes);
  await app.register(ridersRoutes);

  // 6. Conectar PostgreSQL, Redis y ejecutar seed inicial
  await connectDatabase();
  getRedisClient();
  await runInitialDatabaseSeed();

  // 7. Iniciar servidor HTTP y adjuntar bus Socket.IO en tiempo real
  await app.listen({ port: env.PORT, host: env.HOST });
  initSocketServer(app.server);

  console.log(`🚀 [RODO API] Listening on http://${env.HOST}:${env.PORT}`);
}

bootstrap().catch((err) => {
  console.error('[Fatal] Failed to start RODO API server:', err);
  process.exit(1);
});
