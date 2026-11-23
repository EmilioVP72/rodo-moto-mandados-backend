import { Buffer } from 'node:buffer';

export const privateOrderFolders = ['signatures', 'proofs', 'transfers'] as const;
export type OrderFolder = typeof privateOrderFolders[number];
export function isOrderFolder(folder: unknown): folder is OrderFolder {
  return privateOrderFolders.some(x => x === folder);
}

export function mayAccessOrderEvidence(user: { sub: string; role: string }, order: {
  customerId: string; assignedRiderUserId: string | null;
}, folder: OrderFolder) {
  if (user.role === 'ADMIN') return true;
  if (user.role === 'RIDER') return folder !== 'transfers' && user.sub === order.assignedRiderUserId;
  return ['CUSTOMER','PARTNER_LOCAL'].includes(user.role) && user.sub === order.customerId;
}

export function parseImage(input: unknown) {
  if (typeof input !== 'string' || input.length > 4 * Math.ceil(4194304 / 3) + 40) return null;
  const match = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(input);
  if (!match) return null;
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > 4194304 || bytes.toString('base64') !== match[2]) return null;
  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
  const valid = ext === 'png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a','hex'))
    : ext === 'jpg' ? bytes.subarray(0, 3).equals(Buffer.from('ffd8ff','hex'))
    : bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP';
  return valid ? { bytes, ext } : null;
}
