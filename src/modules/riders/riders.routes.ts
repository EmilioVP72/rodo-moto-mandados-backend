import bcrypt from 'bcryptjs';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin, requireRider } from '../../middlewares/auth.js';
import { prisma } from '../../infra/prisma.js';
import { emitOrderEvent, emitAdminEvent } from '../../infra/socket.js';
import { canRiderTransitionOrderStatus } from '../../utils/domainRules.js';
import { mapOrderRowToPayload } from '../orders/orders.routes.js';

const riderPasswordRounds = 12;

export async function ridersRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/admin/riders', { preHandler: [requireAdmin] }, async (_request, reply) => {
    const riders = await prisma.user.findMany({
      where: { role: 'RIDER' },
      select: { id: true, name: true, email: true, phone: true, status: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    return reply.send(riders);
  });

  app.post('/api/admin/riders', { preHandler: [requireAdmin] }, async (request, reply) => {
    const schema = z.object({
      name: z.string().trim().min(2).max(120),
      email: z.string().trim().email().max(254),
      phone: z.string().trim().min(8).max(32),
      password: z.string().min(8).max(128),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message || 'Datos de repartidor inválidos.' });
    }

    const email = parsed.data.email.toLowerCase();
    const duplicate = await prisma.user.findFirst({
      where: { OR: [{ email }, { phone: parsed.data.phone }] },
      select: { id: true },
    });
    if (duplicate) {
      return reply.status(409).send({ error: 'El correo o teléfono ya está vinculado a una cuenta.' });
    }

    const rider = await prisma.user.create({
      data: {
        name: parsed.data.name,
        email,
        phone: parsed.data.phone,
        passwordHash: await bcrypt.hash(parsed.data.password, riderPasswordRounds),
        role: 'RIDER',
        status: 'activo',
      },
      select: { id: true, name: true, email: true, phone: true, status: true, createdAt: true },
    });
    emitAdminEvent('riders:updated', rider);
    return reply.status(201).send(rider);
  });

  app.get('/api/rider/orders', { preHandler: [requireRider] }, async (request, reply) => {
    const orders = await prisma.order.findMany({
      where: { assignedRiderUserId: request.authUser!.sub },
      include: {
        items: true,
        statusHistory: { orderBy: { createdAt: 'desc' }, take: 10 },
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    });
    return reply.send(orders.map((order) => {
      const { customerEmail: _customerEmail, ...riderOrder } = mapOrderRowToPayload(order);
      return riderOrder;
    }));
  });

  app.patch('/api/rider/orders/:id/status', { preHandler: [requireRider] }, async (request, reply) => {
    const schema = z.object({ status: z.string().min(1).max(40), deliveryNotes: z.string().max(1000).optional() });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Estado de pedido inválido.' });
    }

    const { id } = request.params as { id: string };
    const riderId = request.authUser!.sub;
    const existing = await prisma.order.findUnique({ where: { id } });
    if (!existing) return reply.status(404).send({ error: 'Pedido no encontrado.' });
    if (existing.assignedRiderUserId !== riderId) {
      return reply.status(403).send({ error: 'Este pedido no está asignado a tu cuenta.' });
    }
    if (!canRiderTransitionOrderStatus(existing.status, parsed.data.status)) {
      return reply.status(409).send({ error: `No puedes cambiar el pedido de ${existing.status} a ${parsed.data.status}.` });
    }

    const now = new Date();
    const previousPayload = (existing.payload || {}) as Record<string, unknown>;
    const updated = await prisma.$transaction(async (tx) => {
      const changed = await tx.order.updateMany({
        where: {
          id,
          assignedRiderUserId: riderId,
          status: existing.status,
        },
        data: {
          status: parsed.data.status,
          payload: {
            ...previousPayload,
            status: parsed.data.status,
            updatedAt: now.toISOString(),
            ...(parsed.data.deliveryNotes ? { deliveryNotes: parsed.data.deliveryNotes } : {}),
          },
        },
      });
      if (changed.count !== 1) return null;
      await tx.orderStatusHistory.create({
        data: {
          orderId: id,
          fromStatus: existing.status,
          toStatus: parsed.data.status,
          changedByUserId: riderId,
          note: parsed.data.deliveryNotes || 'Actualizado por repartidor asignado',
        },
      });
      if (parsed.data.status === 'entregado') {
        await tx.user.update({
          where: { id: existing.customerId },
          data: { completedOrdersCount: { increment: 1 } },
        });
      }
      return tx.order.findUniqueOrThrow({
        where: { id },
        include: { items: true, statusHistory: { orderBy: { createdAt: 'desc' }, take: 10 } },
      });
    });

    if (!updated) {
      return reply.status(409).send({ error: 'El pedido cambió mientras lo actualizabas. Actualiza la lista e inténtalo de nuevo.' });
    }

    const mapped = mapOrderRowToPayload(updated);
    emitOrderEvent('orders:updated', mapped);
    const { customerEmail: _customerEmail, ...riderOrder } = mapped;
    return reply.send(riderOrder);
  });
}
