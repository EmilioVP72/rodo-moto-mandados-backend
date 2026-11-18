import { FastifyInstance } from 'fastify';
import { prisma } from '../../infra/prisma.js';
import { broadcastEvent } from '../../infra/socket.js';

function mapOrderRowToPayload(row: any) {
  const payload = (row.payload || {}) as Record<string, unknown>;
  return {
    ...payload,
    id: row.id,
    folio: row.folio,
    orderType: row.orderType,
    customerId: row.customerId,
    customerName: row.customerName,
    customerPhone: row.customerPhone,
    customerEmail: row.customerEmail || undefined,
    restaurantId: row.restaurantId,
    restaurantName: row.restaurantName,
    subtotal: row.subtotal,
    deliveryFee: row.deliveryFee,
    commissionAmount: row.commissionAmount,
    total: row.total,
    paymentMethod: row.paymentMethod,
    paymentStatus: row.paymentStatus,
    deliveryAddress: row.deliveryAddress,
    status: row.status,
    assignedRiderName: row.assignedRiderName || undefined,
    assignedRiderPhone: row.assignedRiderPhone || undefined,
    createdAt: (payload.createdAt as string) || row.createdAt.toISOString(),
    updatedAt: (payload.updatedAt as string) || row.updatedAt.toISOString(),
  };
}

export async function ordersRoutes(app: FastifyInstance): Promise<void> {
  // 1. LISTAR ÓRDENES
  app.get('/api/orders', async (request, reply) => {
    const { customerId, limit = '500' } = request.query as { customerId?: string; limit?: string };
    const takeCount = Math.min(1000, Math.max(1, parseInt(limit, 10) || 500));

    const rows = await prisma.order.findMany({
      where: customerId ? { customerId } : undefined,
      orderBy: { createdAt: 'desc' },
      take: takeCount,
    });

    return reply.send(rows.map(mapOrderRowToPayload));
  });

  // 2. CREAR ORDEN CON VALIDACIÓN SERVER-SIDE Y NOTIFICACIÓN EN TIEMPO REAL
  app.post('/api/orders', async (request, reply) => {
    const body = request.body as any;
    if (!body || !body.folio || !body.restaurantName) {
      return reply.status(400).send({ error: 'Datos de la orden incompletos.' });
    }

    // Verificar si la pausa por lluvia está activa en la configuración global
    const settingsDoc = await prisma.setting.findUnique({ where: { id: 'general' } });
    const settings = (settingsDoc?.payload || {}) as any;
    if (settings.rainPauseEnabled === true) {
      return reply.status(503).send({
        error:
          settings.rainPauseMessage ||
          'Envíos pausados temporalmente por lluvia en San Miguel de Allende.',
      });
    }

    // Recalcular subtotal en el servidor a partir de los items para evitar manipulación de precios
    const items = Array.isArray(body.items) ? body.items : [];
    let verifiedSubtotal = 0;

    if (items.length > 0 && !body.isCustomQuote && body.orderType !== 'auxilio_gasolina' && body.orderType !== 'solicitud_local') {
      const restaurantDoc = await prisma.restaurant.findUnique({
        where: { id: String(body.restaurantId || '') },
      });
      const menuList: any[] = Array.isArray((restaurantDoc?.payload as any)?.menu)
        ? (restaurantDoc?.payload as any).menu
        : [];
      const menuMap = new Map(menuList.map((m) => [String(m.id), m]));

      for (const item of items) {
        const qty = Math.max(1, Number(item.quantity) || 1);
        const catalogItem = menuMap.get(String(item.id));
        const unitExtra = Math.max(0, Number(item.unitExtraPrice) || 0);
        const unitPrice = catalogItem
          ? Math.max(0, Number(catalogItem.price) || 0) + unitExtra
          : Math.max(0, Number(item.price) || 0);
        verifiedSubtotal += unitPrice * qty;
      }
    } else {
      verifiedSubtotal = Math.max(0, Number(body.subtotal) || 0);
    }

    const deliveryFee = Math.max(0, Number(body.deliveryFee) || 0);
    const tipAmount = Math.max(0, Number(body.tipAmount) || 0);
    const promoDiscount = Math.max(0, Number(body.promoDiscountApplied) || 0);
    const calculatedTotal =
      body.orderType === 'auxilio_gasolina' || body.orderType === 'solicitud_local' || body.isCustomQuote
        ? Math.max(0, Number(body.total) || 0)
        : Math.max(0, verifiedSubtotal + deliveryFee + tipAmount - promoDiscount);

    const orderId = String(body.id || `ord-${Date.now()}`);
    const nowIso = new Date().toISOString();

    const fullPayload = {
      ...body,
      id: orderId,
      subtotal: verifiedSubtotal,
      deliveryFee,
      total: calculatedTotal,
      createdAt: body.createdAt || nowIso,
      updatedAt: nowIso,
    };

    const saved = await prisma.order.upsert({
      where: { id: orderId },
      update: {
        status: String(body.status || 'nuevo'),
        subtotal: verifiedSubtotal,
        deliveryFee,
        commissionAmount: Number(body.commissionAmount || 0),
        total: calculatedTotal,
        paymentMethod: String(body.paymentMethod || 'efectivo'),
        paymentStatus: String(body.paymentStatus || 'en_efectivo'),
        deliveryAddress: String(body.deliveryAddress || ''),
        assignedRiderName: body.assignedRiderName || null,
        assignedRiderPhone: body.assignedRiderPhone || null,
        payload: fullPayload,
      },
      create: {
        id: orderId,
        folio: String(body.folio),
        orderType: String(body.orderType || 'comida'),
        customerId: String(body.customerId || 'guest'),
        customerName: String(body.customerName || 'Cliente'),
        customerPhone: String(body.customerPhone || ''),
        customerEmail: body.customerEmail || null,
        restaurantId: String(body.restaurantId || 'general'),
        restaurantName: String(body.restaurantName),
        subtotal: verifiedSubtotal,
        deliveryFee,
        commissionAmount: Number(body.commissionAmount || 0),
        total: calculatedTotal,
        paymentMethod: String(body.paymentMethod || 'efectivo'),
        paymentStatus: String(body.paymentStatus || 'en_efectivo'),
        deliveryAddress: String(body.deliveryAddress || ''),
        status: String(body.status || 'nuevo'),
        assignedRiderName: body.assignedRiderName || null,
        assignedRiderPhone: body.assignedRiderPhone || null,
        payload: fullPayload,
      },
    });

    const mapped = mapOrderRowToPayload(saved);
    broadcastEvent('orders:created', mapped);
    broadcastEvent('orders:updated', mapped);
    return reply.status(201).send(mapped);
  });

  // 3. CREACIÓN EN LOTE (SIMULACIÓN DE CARGA OPERATIVA)
  app.post('/api/orders/batch', async (request, reply) => {
    const body = request.body as { orders?: any[] };
    const orders = Array.isArray(body?.orders) ? body.orders.slice(0, 450) : [];
    if (orders.length === 0) {
      return reply.status(400).send({ error: 'No se enviaron órdenes en el lote.' });
    }

    await prisma.$transaction(
      orders.map((o) => {
        const orderId = String(o.id || `ord-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
        const folio = String(o.folio || `RD-${orderId}`);
        return prisma.order.upsert({
          where: { id: orderId },
          update: {
            status: String(o.status || 'nuevo'),
            total: Number(o.total || 0),
            payload: { ...o, id: orderId, folio },
          },
          create: {
            id: orderId,
            folio,
            orderType: String(o.orderType || 'comida'),
            customerId: String(o.customerId || 'sim-user'),
            customerName: String(o.customerName || 'Cliente Simulación'),
            customerPhone: String(o.customerPhone || '4150000000'),
            customerEmail: o.customerEmail || null,
            restaurantId: String(o.restaurantId || 'general'),
            restaurantName: String(o.restaurantName || 'Restaurante'),
            subtotal: Number(o.subtotal || 0),
            deliveryFee: Number(o.deliveryFee || 35),
            commissionAmount: Number(o.commissionAmount || 0),
            total: Number(o.total || 0),
            paymentMethod: String(o.paymentMethod || 'efectivo'),
            paymentStatus: String(o.paymentStatus || 'en_efectivo'),
            deliveryAddress: String(o.deliveryAddress || 'San Miguel de Allende'),
            status: String(o.status || 'nuevo'),
            assignedRiderName: o.assignedRiderName || null,
            assignedRiderPhone: o.assignedRiderPhone || null,
            payload: { ...o, id: orderId, folio },
          },
        });
      })
    );

    broadcastEvent('orders:batch-updated', { count: orders.length });
    return reply.send({ ok: true, count: orders.length });
  });

  // 4. ACTUALIZAR ESTADO, ASIGNACIÓN DE REPARTIDOR, FIRMA O CALIFICACIÓN DE ORDEN
  app.patch('/api/orders/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const updates = request.body as Record<string, any>;

    const existing = await prisma.order.findUnique({ where: { id } });
    if (!existing) {
      return reply.status(404).send({ error: 'Orden no encontrada.' });
    }

    const nowIso = new Date().toISOString();
    const prevPayload = (existing.payload || {}) as Record<string, any>;
    const mergedPayload = {
      ...prevPayload,
      ...updates,
      id,
      updatedAt: nowIso,
    };

    const updated = await prisma.order.update({
      where: { id },
      data: {
        status: updates.status !== undefined ? String(updates.status) : existing.status,
        paymentStatus: updates.paymentStatus !== undefined ? String(updates.paymentStatus) : existing.paymentStatus,
        subtotal: updates.subtotal !== undefined ? Number(updates.subtotal) : existing.subtotal,
        deliveryFee: updates.deliveryFee !== undefined ? Number(updates.deliveryFee) : existing.deliveryFee,
        total: updates.total !== undefined ? Number(updates.total) : existing.total,
        assignedRiderName:
          updates.assignedRiderName !== undefined ? updates.assignedRiderName : existing.assignedRiderName,
        assignedRiderPhone:
          updates.assignedRiderPhone !== undefined ? updates.assignedRiderPhone : existing.assignedRiderPhone,
        payload: mergedPayload,
      },
    });

    // Si la orden pasó a 'entregado', incrementar contador de órdenes completadas del cliente (aumenta límite de efectivo)
    if (updates.status === 'entregado' && existing.status !== 'entregado' && existing.customerId) {
      await prisma.user
        .updateMany({
          where: { id: existing.customerId },
          data: { completedOrdersCount: { increment: 1 } },
        })
        .catch(() => {});
    }

    // Si la orden pasó a 'cancelado_con_deuda', registrar deuda y bloqueo en la cuenta del cliente en PostgreSQL
    if (updates.status === 'cancelado_con_deuda' && existing.customerId) {
      const debtAmount = Number(updates.cancellationDebtAmount ?? existing.total);
      await prisma.user
        .updateMany({
          where: { id: existing.customerId },
          data: {
            pendingDebt: debtAmount,
            debtReason: updates.cancellationReason || 'Cancelación con adeudo pendiente',
            debtOrderFolio: existing.folio,
            debtDate: new Date().toLocaleDateString('es-MX'),
            status: 'bloqueado_fraude',
            blockedAt: nowIso,
          },
        })
        .catch(() => {});
    }

    const mapped = mapOrderRowToPayload(updated);
    broadcastEvent('orders:updated', mapped);
    return reply.send(mapped);
  });
}
