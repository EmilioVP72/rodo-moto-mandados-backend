import { FastifyInstance, FastifyRequest } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../config/env.js';
import { requireAuth } from '../../middlewares/auth.js';
import { prisma } from '../../infra/prisma.js';
import { isOrderFolder, mayAccessOrderEvidence } from '../../utils/evidence.js';
import { saveImage } from './storage.js';

async function hasActiveAccount(request: FastifyRequest) {
  const user = request.authUser!;
  return Boolean(await prisma.user.findFirst({ where: { id: user.sub, role: user.role, status: 'activo' }, select: { id: true } }));
}

export async function uploadsRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/uploads', { preHandler: [requireAuth], config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { folder, referenceId, dataUrl } = (request.body || {}) as Record<string, unknown>;
    const user = request.authUser!;
    if (!await hasActiveAccount(request)) return reply.code(403).send();
    if (folder === 'restaurants') {
      if (user.role !== 'ADMIN') return reply.code(403).send();
    } else {
      if (!isOrderFolder(folder) || typeof referenceId !== 'string') return reply.code(400).send({ error: 'Tipo de evidencia o pedido inválido.' });
      const order = await prisma.order.findUnique({ where: { id: referenceId } });
      if (!order || !mayAccessOrderEvidence(user, order, folder)) return reply.code(404).send();
    }
    const image = await saveImage(folder, dataUrl);
    if (!image) return reply.code(400).send({ error: 'Usa una imagen JPG, PNG o WebP válida de hasta 4 MB.' });
    try {
      if (isOrderFolder(folder)) await prisma.orderUpload.create({ data: { url: image.url, orderId: referenceId as string } });
    } catch (error) { await image.discard(); throw error; }
    return reply.code(201).send({ url: image.url, sizeBytes: image.sizeBytes });
  });

  app.get('/uploads/:folder/:filename', { preHandler: [requireAuth] }, async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store').header('Vary','Authorization');
    const { folder, filename } = request.params as { folder: string; filename: string };
    if (!/^[A-Za-z0-9_-]+\.(png|jpg|webp)$/.test(filename)) return reply.code(404).send();
    const url = `/uploads/${folder}/${filename}`;
    const user = request.authUser!;
    if (!await hasActiveAccount(request)) return reply.code(403).send();
    if (folder === 'recovery') {
      if (user.role !== 'ADMIN' || !await prisma.accountRecoveryRequest.findFirst({ where: { documentPhotoUrl: url }, select: { id: true } })) return reply.code(404).send();
    } else {
      if (!isOrderFolder(folder)) return reply.code(404).send();
      const upload = await prisma.orderUpload.findUnique({ where: { url }, include: { order: true } });
      let order = upload?.order;
      // Legacy uploads must be referenced by the original order and have its generated filename.
      if (!order && folder !== 'transfers') {
        const field = folder === 'proofs' ? 'deliveryProofPhotoUrl' : 'deliverySignatureDataUrl';
        const legacy = await prisma.order.findFirst({ where: { payload: { path: [field], equals: url } } });
        const suffix = folder === 'proofs' ? 'photo' : 'signature';
        const prefix = legacy && (legacy.id + '-' + suffix).replace(/[^a-zA-Z0-9_-]/g,'').slice(0,50) + '_';
        if (legacy && prefix && filename.startsWith(prefix)) order = legacy;
      }
      if (!order || !mayAccessOrderEvidence(user, order, folder)) return reply.code(404).send();
    }
    try {
      const bytes = await fs.readFile(path.join(env.UPLOADS_DIR, folder, filename));
      const ext = path.extname(filename).slice(1);
      return reply.type('image/' + (ext === 'jpg' ? 'jpeg' : ext)).send(bytes);
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return reply.code(404).send(); throw error; }
  });
}
