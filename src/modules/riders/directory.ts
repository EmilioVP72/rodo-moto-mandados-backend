import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { riderRegistration, riderChanges } from './validation.js';
import { requireAdmin } from '../../middlewares/auth.js';
import { prisma } from '../../infra/prisma.js';
import { emitAdminEvent } from '../../infra/socket.js';

const withAccount = { user: { select: { email: true, status: true } } } as const;
type RiderRow = Prisma.RiderGetPayload<{ include: typeof withAccount }>;

function publicRow({ user, deletedAt, ...profile }: RiderRow) {
  return { ...profile, email: user?.email ?? null, status: user?.status ?? 'activo' };
}

function fail(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode });
}

async function write<T>(action: (tx: Prisma.TransactionClient) => Promise<T>) {
  try {
    return await prisma.$transaction(action, { isolationLevel: 'ReadCommitted' });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') fail(409, 'Ese correo o teléfono ya está en uso.');
      if (error.code === 'P2034') fail(409, 'La flotilla cambió al mismo tiempo. Revisa los datos y vuelve a intentar.');
    }
    throw error;
  }
}

async function checkContact(tx: Prisma.TransactionClient, id: string | null, email?: string, phone?: string) {
  if (phone) await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(72148, hashtext(${phone}))`;
  const or = [...(email ? [{ email }] : []), ...(phone ? [{ phone }] : [])];
  if (or.length && await tx.user.findFirst({ where: { ...(id ? { id: { not: id } } : {}), OR: or }, select: { id: true } })) {
    fail(409, 'Ese correo o teléfono ya está vinculado a otra cuenta.');
  }
}

async function lockRider(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT id FROM riders WHERE id = ${id} FOR UPDATE`;
  const rider = await tx.rider.findFirst({ where: { id, deletedAt: null }, include: withAccount });
  if (!rider) fail(404, 'Repartidor no encontrado.');
  return rider;
}

async function checkOpenOrders(tx: Prisma.TransactionClient, userId: string | null) {
  if (userId && await tx.order.findFirst({ where: {
    assignedRiderUserId: userId, status: { notIn: ['entregado', 'cancelado', 'cancelado_con_deuda'] },
  }, select: { id: true } })) fail(409, 'Tiene pedidos activos. Reasígnalos o espera a que finalicen.');
}

export async function lockAssignableRider(tx: Prisma.TransactionClient, userId: string) {
  const [rider] = await tx.$queryRaw<{ id: string; name: string; phone: string }[]>`
    SELECT u.id, r.name, r.phone FROM riders r JOIN users u ON u.id = r."userId"
    WHERE u.id = ${userId} AND u.role = 'RIDER' AND u.status = 'activo'
      AND r.available AND r."deletedAt" IS NULL FOR SHARE OF r, u`;
  if (!rider) fail(422, 'El repartidor ya no está disponible para asignaciones.');
  return rider;
}

export async function lockDispatchRider(tx: Prisma.TransactionClient, riderId: string) {
  const [rider] = await tx.$queryRaw<{
    id: string;
    userId: string | null;
    name: string;
    phone: string;
  }[]>`
    SELECT r.id, r."userId", r.name, r.phone
    FROM riders r
    LEFT JOIN users u ON u.id = r."userId"
    WHERE (r.id = ${riderId} OR r."userId" = ${riderId})
      AND r.available
      AND r."deletedAt" IS NULL
      AND (r."userId" IS NULL OR (u.role = 'RIDER' AND u.status = 'activo'))
    FOR SHARE OF r`;
  if (!rider) fail(422, 'El repartidor ya no está disponible para asignaciones.');
  return rider;
}

export function riderDirectoryRoutes(app: FastifyInstance) {
  const path = '/api/admin/riders';
  const admin = { preHandler: [requireAdmin] };

  app.get(path, admin, async () => (await prisma.rider.findMany({
    where: { deletedAt: null }, include: withAccount, orderBy: [{ createdAt: 'asc' }, { name: 'asc' }],
  })).map(publicRow));

  app.get<{ Params: { id: string } }>(path + '/:id', admin, async (request, reply) => {
    const rider = await prisma.rider.findFirst({ where: { id: request.params.id, deletedAt: null }, include: withAccount });
    if (!rider) return reply.code(404).send({ error: 'Repartidor no encontrado.' });
    return publicRow(rider);
  });

  app.post(path, admin, async (request, reply) => {
    const parsed = riderRegistration.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });
    const { name, phone, email, password, available } = parsed.data;
    const passwordHash = await bcrypt.hash(password, 12);
    const rider = await write(async tx => {
      await checkContact(tx, null, email, phone);
      const user = await tx.user.create({ data: { name, phone, email, passwordHash, role: 'RIDER' } });
      return tx.rider.create({ data: { id: user.id, userId: user.id, name, phone, available }, include: withAccount });
    });
    const result = publicRow(rider);
    emitAdminEvent('riders:updated', result);
    return reply.code(201).send(result);
  });

  app.patch<{ Params: { id: string } }>(path + '/:id', admin, async (request, reply) => {
    const parsed = riderChanges.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });
    const { name, phone, email, password, available } = parsed.data;
    const passwordHash = password ? await bcrypt.hash(password, 12) : undefined;
    const rider = await write(async tx => {
      const current = await lockRider(tx, request.params.id);
      let userId = current.userId;
      if (available === false) await checkOpenOrders(tx, userId);
      if (userId) {
        await checkContact(tx, userId, email, phone === current.phone ? undefined : phone);
        await tx.user.update({ where: { id: userId }, data: {
          name: name === current.name ? undefined : name, phone: phone === current.phone ? undefined : phone, email, passwordHash,
        } });
        if (passwordHash || email && email !== current.user?.email) {
          await tx.refreshSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
        }
      } else if (email || passwordHash) {
        if (!email || !passwordHash) fail(400, 'Para habilitar el acceso, indica correo y contraseña.');
        await checkContact(tx, null, email, phone ?? current.phone);
        const user = await tx.user.create({ data: { id: current.id, name: name ?? current.name, phone: phone ?? current.phone,
          email, passwordHash, role: 'RIDER' } });
        userId = user.id;
      }
      return tx.rider.update({ where: { id: current.id }, data: { userId, name, phone, available }, include: withAccount });
    });
    const result = publicRow(rider);
    emitAdminEvent('riders:updated', result);
    return reply.send(result);
  });

  app.delete<{ Params: { id: string } }>(path + '/:id', admin, async (request, reply) => {
    const id = request.params.id;
    await write(async tx => {
      const rider = await lockRider(tx, id);
      await checkOpenOrders(tx, rider.userId);
      const now = new Date();
      await tx.rider.update({ where: { id }, data: { deletedAt: now, available: false } });
      if (rider.userId) {
        await tx.refreshSession.updateMany({ where: { userId: rider.userId, revokedAt: null }, data: { revokedAt: now } });
        await tx.passwordResetToken.updateMany({ where: { userId: rider.userId, usedAt: null }, data: { usedAt: now } });
      }
    });
    emitAdminEvent('riders:updated', { id });
    return reply.code(204).send();
  });
}
