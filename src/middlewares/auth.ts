import { FastifyReply, FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { prisma } from '../infra/prisma.js';

export interface AuthTokenPayload {
  sub: string;
  email: string;
  role: 'ADMIN' | 'PARTNER_LOCAL' | 'RIDER' | 'CUSTOMER';
  name: string;
  phone?: string;
  sid?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthTokenPayload;
  }
}

export function hashSecretSha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function timingSafeCompareHex(hexA: string, hexB: string): boolean {
  try {
    const bufA = Buffer.from(hexA, 'hex');
    const bufB = Buffer.from(hexB, 'hex');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

export function generateSecureRefreshToken(): string {
  return crypto.randomBytes(48).toString('base64url');
}

export function generateSixDigitResetCode(): string {
  return String(crypto.randomInt(100000, 999999));
}

export function signAuthToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
}

export function verifyAuthToken(token: string): AuthTokenPayload | null {
  try {
    return jwt.verify(token, env.JWT_SECRET) as AuthTokenPayload;
  } catch {
    return null;
  }
}

export function extractUserFromRequest(request: FastifyRequest): AuthTokenPayload | null {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.slice(7).trim();
  return verifyAuthToken(token);
}

export async function createUserRefreshSession(params: {
  userId: string;
  userAgent?: string;
  ipAddress?: string;
}): Promise<{ sessionId: string; refreshToken: string; expiresAt: Date }> {
  const refreshToken = generateSecureRefreshToken();
  const tokenHash = hashSecretSha256(refreshToken);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 días

  const session = await prisma.refreshSession.create({
    data: {
      userId: params.userId,
      tokenHash,
      userAgent: params.userAgent ? params.userAgent.slice(0, 250) : null,
      ipAddress: params.ipAddress ? params.ipAddress.slice(0, 64) : null,
      expiresAt,
    },
  });

  return {
    sessionId: session.id,
    refreshToken,
    expiresAt,
  };
}

export async function optionalAuth(request: FastifyRequest): Promise<void> {
  const user = extractUserFromRequest(request);
  if (user) {
    request.authUser = user;
  }
}

/**
 * Middleware estricto de autenticación:
 * Verifica la firma JWT y, si incluye sessionId (sid), comprueba que la sesión no haya sido revocada en PostgreSQL.
 */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = extractUserFromRequest(request);
  if (!user) {
    reply.status(401).send({ error: 'Sesión requerida. Por favor inicia sesión para continuar.' });
    return;
  }

  if (user.role === 'RIDER' && !await prisma.rider.findFirst({
    where: { userId: user.sub, deletedAt: null }, select: { id: true },
  })) {
    reply.code(401).send({ error: 'Esta cuenta de repartidor fue dada de baja.' });
    return;
  }
  if (user.sid) {
    const session = await prisma.refreshSession.findUnique({
      where: { id: user.sid },
      select: { revokedAt: true, expiresAt: true },
    });
    if (!session || session.revokedAt !== null || session.expiresAt < new Date()) {
      reply.status(401).send({ error: 'Tu sesión expiró o fue cerrada. Inicia sesión nuevamente.' });
      return;
    }
  }

  request.authUser = user;
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAuth(request, reply);
  if (reply.sent) return;

  if (!request.authUser || request.authUser.role !== 'ADMIN') {
    reply.status(403).send({ error: 'Acceso restringido únicamente a Administradores de RODO.' });
    return;
  }
}

export async function requireRider(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAuth(request, reply);
  if (reply.sent) return;

  if (!request.authUser || request.authUser.role !== 'RIDER') {
    reply.status(403).send({ error: 'Acceso restringido a cuentas de repartidor.' });
    return;
  }

  const rider = await prisma.user.findFirst({
    where: { id: request.authUser.sub, role: 'RIDER', status: 'activo' },
    select: { id: true },
  });
  if (!rider) {
    reply.status(403).send({ error: 'La cuenta de repartidor está inactiva.' });
  }
}
