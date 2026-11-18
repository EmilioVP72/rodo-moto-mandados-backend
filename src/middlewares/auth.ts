import { FastifyReply, FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export interface AuthTokenPayload {
  sub: string;
  email: string;
  role: 'ADMIN' | 'PARTNER_LOCAL' | 'RIDER' | 'CUSTOMER';
  name: string;
  phone?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthTokenPayload;
  }
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

export async function optionalAuth(request: FastifyRequest): Promise<void> {
  const user = extractUserFromRequest(request);
  if (user) {
    request.authUser = user;
  }
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = extractUserFromRequest(request);
  if (!user) {
    reply.status(401).send({ error: 'No autorizado. Inicia sesión nuevamente.' });
    return;
  }
  request.authUser = user;
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const user = extractUserFromRequest(request);
  if (!user || user.role !== 'ADMIN') {
    reply.status(403).send({ error: 'Acceso restringido únicamente a Administradores de RODO.' });
    return;
  }
  request.authUser = user;
}
