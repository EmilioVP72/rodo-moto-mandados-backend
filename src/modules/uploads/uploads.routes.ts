import { FastifyInstance } from 'fastify';
import fs from 'fs/promises';
import path from 'path';
import { env } from '../../config/env.js';

export async function uploadsRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/uploads', async (request, reply) => {
    const body = request.body as {
      dataUrl?: string;
      folder?: 'signatures' | 'proofs' | 'recovery' | 'transfers' | 'restaurants';
      referenceId?: string;
    };

    if (!body?.dataUrl || !body.dataUrl.startsWith('data:image/')) {
      return reply.status(400).send({ error: 'Se requiere una imagen válida en formato DataURL.' });
    }

    const mimeMatch = body.dataUrl.match(/^data:(image\/(jpeg|jpg|png|webp));base64,(.+)$/);
    if (!mimeMatch) {
      return reply.status(400).send({ error: 'Formato de imagen no permitido. Usa JPG, PNG o WEBP.' });
    }

    const ext = mimeMatch[2] === 'png' ? 'png' : mimeMatch[2] === 'webp' ? 'webp' : 'jpg';
    const base64Data = mimeMatch[3];
    const buffer = Buffer.from(base64Data, 'base64');

    if (buffer.byteLength > 4 * 1024 * 1024) {
      return reply.status(413).send({ error: 'La imagen excede el límite máximo de 4 MB.' });
    }

    const safeFolder = (body.folder || 'proofs').replace(/[^a-z0-9_-]/gi, '');
    const safeRef = (body.referenceId || 'doc').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50) || 'doc';
    const fileName = `${safeRef}_${Date.now()}.${ext}`;

    const targetDir = path.resolve(env.UPLOADS_DIR, safeFolder);
    await fs.mkdir(targetDir, { recursive: true });

    const filePath = path.join(targetDir, fileName);
    await fs.writeFile(filePath, buffer);

    const publicUrl = `/uploads/${safeFolder}/${fileName}`;
    return reply.status(201).send({
      url: publicUrl,
      sizeBytes: buffer.byteLength,
    });
  });
}
