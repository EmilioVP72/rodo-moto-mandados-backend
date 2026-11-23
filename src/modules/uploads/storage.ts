import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { parseImage } from '../../utils/evidence.js';

export async function saveImage(folder: string, dataUrl: unknown) {
  const image = parseImage(dataUrl);
  if (!image) return null;
  const filename = `${randomUUID()}.${image.ext}`;
  const directory = path.join(env.UPLOADS_DIR, folder);
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, filename);
  await fs.writeFile(file, image.bytes, { flag: 'wx' });
  return { url: `/uploads/${folder}/${filename}`, sizeBytes: image.bytes.length, discard: () => fs.unlink(file) };
}
