import { riderDirectoryRoutes } from './directory.js';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRider } from '../../middlewares/auth.js';
import { prisma } from '../../infra/prisma.js';
import { emitOrderEvent, emitAdminEvent } from '../../infra/socket.js';
import { allowedOrderTransitions } from '../../utils/domainRules.js';
import { mapOrderRowToPayload } from '../orders/orders.routes.js';

export async function ridersRoutes(app: FastifyInstance): Promise<void> {
  riderDirectoryRoutes(app);

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
    if (!allowedOrderTransitions('RIDER', existing).includes(parsed.data.status)) {
      return reply.status(409).send({ error: `No puedes cambiar el pedido de ${existing.status} a ${parsed.data.status}.` });
    }

    const now = new Date();
    const previousPayload = (existing.payload || {}) as Record<string, unknown>;
    const updated = await prisma.$transaction(async (tx) => {
      const changed = await tx.order.updateMany({
        where: {
          id,
          assignedRiderUserId: riderId,
          status: existing.status, updatedAt: existing.updatedAt,
        },
        data: {
          status: parsed.data.status,
          payload: {
            ...previousPayload,
            status: parsed.data.status,
            updatedAt: now.toISOString(),
            ...(parsed.data.status === 'afuera_del_domicilio' ? { arrivalNotifiedAt: now.toISOString(), arrivalExpiresAt: new Date(now.getTime() + 600000).toISOString(), customerNotifiedOutside: true } : {}),
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
          changedByRole: 'RIDER',
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
    if (parsed.data.status === 'entregado' && existing.status !== 'entregado') {
      emitAdminEvent('admin:order-delivered', {
        id: mapped.id,
        folio: mapped.folio,
        customerName: mapped.customerName,
        restaurantName: mapped.restaurantName,
        assignedRiderName: mapped.assignedRiderName,
        total: mapped.total,
        deliveredAt: now.toISOString(),
      });
    }
    if (parsed.data.status === 'afuera_del_domicilio') {
      emitOrderEvent('order:arrival-alert', {
        id: mapped.id,
        folio: mapped.folio,
        customerId: mapped.customerId,
        assignedRiderUserId: mapped.assignedRiderUserId,
        assignedRiderName: mapped.assignedRiderName || 'Repartidor RODO',
        deliveryAddress: mapped.deliveryAddress,
        arrivalNotifiedAt: now.toISOString(),
        arrivalExpiresAt: new Date(now.getTime() + 600000).toISOString(),
      });
    }
    const { customerEmail: _customerEmail, ...riderOrder } = mapped;
    return reply.send(riderOrder);
  });
}
