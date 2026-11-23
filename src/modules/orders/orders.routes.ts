import { FastifyInstance } from 'fastify';
import { prisma } from '../../infra/prisma.js';
import { emitOrderEvent, emitAdminEvent } from '../../infra/socket.js';
import { requireAuth, requireAdmin } from '../../middlewares/auth.js';
import {
  allowedOrderTransitions, isOrderStatus,
  getServerCustomerCashLimit,
  validateSpeiTrackingKeyFormat,

} from '../../utils/domainRules.js';

import { quoteExpressDelivery } from '../routing/routing.routes.js';
import { initialOrderPayment, money, priceFoodOrder, priceFuelRequest, matchesDisplayedQuote, PriceError } from '../../utils/orderPricing.js';

const CUSTOMER_ALLOWED_PATCH_FIELDS = new Set([
  'receptionConfirmed',
  'receptionConfirmedAt',
  'rating',
  'riderRating',
  'foodRating',
  'ratingComment',
  'ratedAt',
  'deliverySignatureDataUrl',
  'deliveryProofPhotoUrl',
  'deliveryConfirmedBySignature',
  'deliverySignatureAt',
  'quoteConfirmedByCustomer',
  'cancellationReason',
  'deliveryNotes',
  'status',
]);

export function mapOrderRowToPayload(row: any) {
  const payload = (row.payload || {}) as Record<string, unknown>;
  const relationalItems = Array.isArray(row.items) && row.items.length > 0
    ? row.items.map((it: any) => ({
        id: it.productId,
        name: it.name,
        price: it.unitPrice,
        unitExtraPrice: it.unitExtraPrice,
        quantity: it.quantity,
        notes: it.notes || undefined,
        customizations: Array.isArray(it.customizations) ? it.customizations : undefined,
      }))
    : (payload.items as any[]) || [];

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
    items: relationalItems,
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
    assignedRiderUserId: row.assignedRiderUserId || undefined,
    adminNextStatuses: allowedOrderTransitions('ADMIN', row),
    statusHistory: Array.isArray(row.statusHistory) ? row.statusHistory : undefined,
    createdAt: (payload.createdAt as string) || row.createdAt.toISOString(),
    updatedAt: (payload.updatedAt as string) || row.updatedAt.toISOString(),
  };
}

export async function ordersRoutes(app: FastifyInstance): Promise<void> {
  // =========================================================================
  // 1. LISTAR ÓRDENES (AISLAMIENTO ESTRICTO: CLIENTE SOLO VE SUS PROPIAS ÓRDENES)
  // =========================================================================
  app.get('/api/orders', { preHandler: [requireAuth] }, async (request, reply) => {
    const authUser = request.authUser!;
    const { customerId, limit = '500' } = request.query as { customerId?: string; limit?: string };
    const takeCount = Math.min(1000, Math.max(1, parseInt(limit, 10) || 500));

    // Regla de oro de privacidad: Un cliente JAMÁS puede consultar órdenes ajenas
    const whereClause =
      authUser.role === 'ADMIN'
        ? customerId
          ? { customerId }
          : undefined
        : { customerId: authUser.sub };

    const rows = await prisma.order.findMany({
      where: whereClause,
      include: {
        items: true,
        statusHistory: { orderBy: { createdAt: 'desc' }, take: 10 },
      },
      orderBy: { createdAt: 'desc' },
      take: takeCount,
    });

    return reply.send(rows.map(mapOrderRowToPayload));
  });

  // =========================================================================
  // 1.5 REGISTRO HISTÓRICO COMPLETO DE PEDIDOS (EXCLUSIVO ADMINISTRADOR)
  // =========================================================================
  app.get('/api/admin/orders/history', { preHandler: [requireAdmin] }, async (request, reply) => {
    const {
      search,
      status,
      paymentMethod,
      orderType,
      rider,
      dateFrom,
      dateTo,
      archivedOnly,
      limit = '1000',
    } = request.query as {
      search?: string;
      status?: string;
      paymentMethod?: string;
      orderType?: string;
      rider?: string;
      dateFrom?: string;
      dateTo?: string;
      archivedOnly?: string;
      limit?: string;
    };

    const takeCount = Math.min(2000, Math.max(1, parseInt(limit, 10) || 1000));
    const where: Record<string, any> = {};

    if (status && status !== 'todos') {
      if (status === 'activos') {
        where.status = { notIn: ['entregado', 'cancelado', 'cancelado_con_deuda'] };
      } else if (status === 'cancelados_todos') {
        where.status = { in: ['cancelado', 'cancelado_con_deuda'] };
      } else {
        where.status = status;
      }
    }

    if (paymentMethod && paymentMethod !== 'todos') {
      where.paymentMethod = paymentMethod;
    }

    if (orderType && orderType !== 'todos') {
      where.orderType = orderType;
    }

    if (rider && rider !== 'todos') {
      if (rider === 'sin_asignar') {
        where.assignedRiderName = null;
      } else {
        where.assignedRiderName = { equals: rider, mode: 'insensitive' };
      }
    }

    const createdAtFilter: Record<string, Date> = {};
    if (dateFrom) {
      const fromDate = new Date(`${dateFrom}T00:00:00.000Z`);
      if (!Number.isNaN(fromDate.getTime())) createdAtFilter.gte = fromDate;
    }
    if (dateTo) {
      const toDate = new Date(`${dateTo}T23:59:59.999Z`);
      if (!Number.isNaN(toDate.getTime())) createdAtFilter.lte = toDate;
    }
    if (archivedOnly === 'true') {
      createdAtFilter.lt = new Date(Date.now() - 24 * 60 * 60 * 1000);
    }
    if (Object.keys(createdAtFilter).length > 0) {
      where.createdAt = createdAtFilter;
    }

    if (search && search.trim()) {
      const term = search.trim();
      where.OR = [
        { folio: { contains: term, mode: 'insensitive' } },
        { customerName: { contains: term, mode: 'insensitive' } },
        { customerPhone: { contains: term, mode: 'insensitive' } },
        { restaurantName: { contains: term, mode: 'insensitive' } },
        { deliveryAddress: { contains: term, mode: 'insensitive' } },
        { assignedRiderName: { contains: term, mode: 'insensitive' } },
      ];
    }

    const rows = await prisma.order.findMany({
      where,
      include: {
        items: true,
        statusHistory: { orderBy: { createdAt: 'asc' } },
      },
      orderBy: { createdAt: 'desc' },
      take: takeCount,
    });

    const mapped = rows.map(mapOrderRowToPayload);
    const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
    const summary = mapped.reduce(
      (acc, order: any) => {
        const isCancelled =
          order.status === 'cancelado' || order.status === 'cancelado_con_deuda';
        if (new Date(order.createdAt).getTime() < cutoff24h) acc.archivedCount += 1;
        if (order.status === 'entregado') acc.deliveredCount += 1;
        else if (isCancelled) acc.cancelledCount += 1;
        else acc.activeCount += 1;

        if (!isCancelled) {
          const total = Number(order.total || 0);
          acc.totalRevenue += total;
          acc.totalDeliveryFees += Number(order.deliveryFee || 0);
          acc.totalCommissions += Number(order.commissionAmount || 0);
          if (order.paymentMethod === 'transferencia') acc.transferTotal += total;
          else acc.cashTotal += total;
        }
        return acc;
      },
      {
        totalCount: mapped.length,
        deliveredCount: 0,
        cancelledCount: 0,
        activeCount: 0,
        archivedCount: 0,
        totalRevenue: 0,
        totalDeliveryFees: 0,
        totalCommissions: 0,
        cashTotal: 0,
        transferTotal: 0,
      }
    );

    return reply.send({ orders: mapped, summary });
  });

  // =========================================================================
  // 2. OBTENER DETALLE DE UNA ORDEN POR ID O FOLIO (SOLO DUEÑO O ADMIN)
  // =========================================================================
  app.get('/api/orders/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const authUser = request.authUser!;
    const { id } = request.params as { id: string };

    const order = await prisma.order.findFirst({
      where: {
        OR: [{ id }, { folio: id }],
      },
      include: {
        items: true,
        statusHistory: { orderBy: { createdAt: 'desc' } },
      },
    });

    if (!order) {
      return reply.status(404).send({ error: 'Orden no encontrada.' });
    }

    if (authUser.role !== 'ADMIN' && order.customerId !== authUser.sub) {
      return reply.status(403).send({
        error: 'Acceso denegado: No tienes permisos para ver el pedido de otro cliente.',
      });
    }

    return reply.send(mapOrderRowToPayload(order));
  });

  // =========================================================================
  // 3. VERIFICACIÓN SERVER-SIDE DE TRANSFERENCIA SPEI (CON ÍNDICE UNIQUE EN BD)
  // =========================================================================
  app.post('/api/orders/verify-transfer', { preHandler: [requireAuth] }, async (request, reply) => {
    const body = request.body as {
      trackingKey?: string;
      expectedAmount?: number;
      senderBank?: string;
      orderFolio?: string;
    };

    const senderBank = (body?.senderBank || 'SPEI Interbancario').trim();

    const formatCheck = validateSpeiTrackingKeyFormat(body?.trackingKey || '');
    const cleanKey = formatCheck.cleanKey;
    if (!formatCheck.valid) {
      return reply.send({
        trackingKey: cleanKey,
        senderBank,
        verified: false,
        statusMessage: formatCheck.reason || 'Clave de rastreo SPEI inválida.',
      });
    }

    // Consulta indexada directa a columna UNIQUE orders.speiTrackingKey
    const duplicateOrder = await prisma.order.findUnique({
      where: { speiTrackingKey: cleanKey },
      select: { folio: true },
    });

    if (duplicateOrder && duplicateOrder.folio !== body?.orderFolio) {
      return reply.send({
        trackingKey: cleanKey,
        senderBank,
        verified: false,
        statusMessage: `Alerta antifraude: La clave de rastreo ${cleanKey} ya fue utilizada previamente en la orden #${duplicateOrder.folio}. Ingresa una transferencia nueva.`,
      });
    }

    return reply.send({ trackingKey: cleanKey, senderBank, verified: false, referenceAvailable: true,
      statusMessage: 'Referencia disponible. Despacho confirmará el depósito.' });
  });

  // =========================================================================
  // 4. CREAR ORDEN TRANSACCIONAL (ORDER + ORDER_ITEMS + STATUS_HISTORY + COUPON)
  // =========================================================================
  app.post('/api/orders', { preHandler: [requireAuth] }, async (request, reply) => {
    const authUser = request.authUser!;
    const body = request.body as any;
    if (!body || !body.folio || !body.restaurantName) {
      return reply.status(400).send({ error: 'Datos de la orden incompletos.' });
    }

    delete body.deliverySignatureDataUrl;
    delete body.deliveryProofPhotoUrl;
    delete body.riderLiveCoordinates;
    delete body.riderLastLocationUpdate;

    // 4.1 Verificar pausa por lluvia
    const settingsDoc = await prisma.setting.findUnique({ where: { id: 'general' } });
    const settings = (settingsDoc?.payload || {}) as any;
    if (settings.rainPauseEnabled === true) {
      return reply.status(503).send({
        error:
          settings.rainPauseMessage ||
          '🌧️ Envíos pausados temporalmente por lluvia en San Miguel de Allende.',
      });
    }

    // 4.2 Determinar propietario real desde el JWT (un cliente NO puede suplantar a otro)
    const ownerUserId =
      authUser.role === 'ADMIN' && body.customerId ? String(body.customerId) : authUser.sub;

    const customerUser = await prisma.user.findUnique({
      where: { id: ownerUserId },
      include: { coupons: true },
    });

    if (!customerUser) {
      return reply.status(401).send({ error: 'Tu cuenta de usuario no existe en el sistema.' });
    }

    if (
      customerUser.role !== 'ADMIN' &&
      (customerUser.status === 'bloqueado_fraude' || customerUser.pendingDebt > 0)
    ) {
      return reply.status(403).send({
        error:
          customerUser.pendingDebt > 0
            ? `⛔ Cuenta bloqueada por adeudo pendiente de $${customerUser.pendingDebt.toFixed(2)} MXN (Folio ${customerUser.debtOrderFolio || 'S/N'}).`
            : `⛔ Cuenta suspendida por seguridad (${customerUser.fraudReason || 'Reporte antifraude'}).`,
      });
    }

    // 4.3 Verificar restaurante en PostgreSQL y recalcular subtotal oficial
    const kind = body.orderType || 'comida';
    const isStandardFoodOrder = kind === 'comida';
    const restaurantDoc = body.restaurantId
      ? await prisma.restaurant.findUnique({ where: { id: String(body.restaurantId) } }) : null;
    const menu = (restaurantDoc?.payload || {}) as any;
    let items = Array.isArray(body.items) ? body.items : [];
    let subtotal = 0, deliveryFee = 0, total = 0, commissionAmount = 0;
    let tipAmount = 0, promoDiscountApplied = 0;
    const quoted = ['pedido_personalizado', 'local_no_encontrado', 'auxilio_gasolina'].includes(kind);
    body.isCustomQuote = quoted;
    delete body.quoteOfferedAt;
    body.quoteConfirmedByCustomer = false;
    try {
      if (isStandardFoodOrder) {
        if (!restaurantDoc?.isActive || !restaurantDoc.isOpen) throw new PriceError('El restaurante no está disponible.');
        const surcharge = body.deliveryType === 'express' ? money(settings.expressDeliverySurcharge ?? 25) : 0;
        const price = priceFoodOrder(body, { menu: menu.menu || [], suggestedExtras: menu.suggestedExtras,
          deliveryFee: restaurantDoc.deliveryFee + surcharge, commissionRate: restaurantDoc.commissionRate,
          promoPercent: menu.promoActive ? menu.promoDiscountPercent || 0 : 0 });
        ({ items, subtotal, total, deliveryFee, commissionAmount, tipAmount, promoDiscountApplied } = price);
        body.restaurantCommissionRate = restaurantDoc.commissionRate;
        body.deliveryTypeSurcharge = surcharge;
      } else if (kind === 'envio') {
        const quote = await quoteExpressDelivery({ pickupCoords: body.pickupCoordinates, deliveryCoords: body.coordinates,
          pickupAddress: body.pickupAddress, deliveryAddress: body.deliveryAddress, deliveryType: body.deliveryType });
        if (!quote) throw new PriceError('Fija los puntos de recolección y entrega para cotizar el envío.');
        deliveryFee = total = commissionAmount = quote.totalFee;
        Object.assign(body, { distanceKm: quote.distanceKm, coordinates: quote.deliveryCoords,
          pickupCoordinates: quote.pickupCoords, deliveryTypeSurcharge: quote.expressSurcharge });
        items = [{ id: 'envio', name: items[0]?.name || 'Envío', quantity: 1, price: 0 }];
      } else if (kind === 'solicitud_local') {
        const local = await prisma.partnerLocal.findUnique({ where: { id: String(body.restaurantId) } });
        const count = body.ridersRequestedCount;
        if (!local?.isActive || local.code !== body.localCode || !Number.isInteger(count) || count < 1 || count > 4)
          throw new PriceError('Local o número de repartidores inválido.');
        deliveryFee = local.serviceFee;
        total = subtotal = commissionAmount = money(count * deliveryFee);
        items = [{ id: 'item-riders', name: 'Servicio de reparto', quantity: count, price: deliveryFee }];
      } else if (quoted) {
        deliveryFee = kind === 'auxilio_gasolina' ? 0 : restaurantDoc?.deliveryFee ?? 35;
        if (kind === 'auxilio_gasolina') {
          const { liters, fuelType } = body.fuelDetails || {};
          body.fuelDetails = priceFuelRequest(liters, fuelType, settings);
          subtotal = body.fuelDetails.fuelTotal;
        }
        items = [{ id: 'cotizacion', name: items[0]?.name || 'Solicitud de cotización', quantity: 1, price: subtotal }];
        total = money(subtotal + deliveryFee);
      } else throw new PriceError('Tipo de pedido desconocido.');
      Object.assign(body, { items, subtotal, deliveryFee, total, commissionAmount, tipAmount, promoDiscountApplied, restaurantDeliveryFee: deliveryFee });
      body.paymentMethod ??= 'efectivo';
      Object.assign(body, initialOrderPayment(body.paymentMethod, body.bankVerification?.trackingKey));
    } catch (error) {
      if (error instanceof PriceError || error instanceof TypeError) return reply.status(422).send({ error: error.message });
      throw error;
    }
    const verifiedSubtotal = subtotal;
    const calculatedTotal = total;

    // 4.4 Validar límite antifraude de efectivo según historial real en PostgreSQL
    if (isStandardFoodOrder && body.paymentMethod === 'efectivo' && customerUser.role !== 'ADMIN') {
      const cashLimit = getServerCustomerCashLimit(customerUser.completedOrdersCount);
      if (verifiedSubtotal > cashLimit) {
        return reply.status(422).send({
          error: `Por política antifraude para tu pedido #${customerUser.completedOrdersCount + 1}, el límite en efectivo es de $${cashLimit} MXN en productos. Selecciona Pago por Transferencia (sin límite) o reduce tu pedido.`,
        });
      }
    }

    // 4.5 Validar unicidad de clave SPEI en columna UNIQUE
    let cleanSpeiKey: string | null = null;
    if (body.paymentMethod === 'transferencia' && body.bankVerification?.trackingKey) {
      const checkSpei = validateSpeiTrackingKeyFormat(body.bankVerification.trackingKey);
      if (!checkSpei.valid) {
        return reply.status(400).send({ error: checkSpei.reason || 'Clave SPEI inválida.' });
      }
      cleanSpeiKey = checkSpei.cleanKey;

      const dup = await prisma.order.findUnique({
        where: { speiTrackingKey: cleanSpeiKey },
        select: { folio: true, id: true },
      });
      if (dup && dup.folio !== body.folio && dup.id !== body.id) {
        return reply.status(409).send({
          error: `Alerta antifraude: La clave de rastreo SPEI ${cleanSpeiKey} ya fue registrada en el pedido #${dup.folio}.`,
        });
      }
    }

    const orderId = String(body.id || `ord-${Date.now()}`);
    const nowIso = new Date().toISOString();
    const initialStatus = quoted ? 'pendiente_cotizacion' : 'nuevo';
    if (cleanSpeiKey) body.bankVerification.trackingKey = cleanSpeiKey;
    if (body.paymentMethod === 'transferencia' && !cleanSpeiKey && !quoted) {
      return reply.status(422).send({ error: 'Ingresa la referencia SPEI para revisión por despacho.' });
    }

    const fullPayload = {
      ...body,
      id: orderId,
      customerId: customerUser.id,
      customerName: body.customerName || customerUser.name,
      customerPhone: body.customerPhone || customerUser.phone,
      customerEmail: body.customerEmail || customerUser.email,
      subtotal: verifiedSubtotal,
      deliveryFee,
      total: calculatedTotal,
      createdAt: body.createdAt || nowIso,
      updatedAt: nowIso,
    };



    // 4.6 Transacción relacional atómica en PostgreSQL
    const saved = await prisma.$transaction(async (tx) => {
      const createdOrder = await tx.order.create({
        data: {
          id: orderId,
          folio: String(body.folio),
          orderType: String(body.orderType || 'comida'),
          customerId: customerUser.id,
          customerName: String(body.customerName || customerUser.name),
          customerPhone: String(body.customerPhone || customerUser.phone),
          customerEmail: body.customerEmail || customerUser.email,
          restaurantId: String(body.restaurantId || 'general'),
          restaurantRefId: restaurantDoc ? restaurantDoc.id : null,
          restaurantName: String(body.restaurantName),
          subtotal: verifiedSubtotal,
          deliveryFee,
          commissionAmount: Number(body.commissionAmount || 0),
          total: calculatedTotal,
          paymentMethod: String(body.paymentMethod || 'efectivo'),
          paymentStatus: String(body.paymentStatus || 'en_efectivo'),
          speiTrackingKey: cleanSpeiKey,
          deliveryAddress: String(body.deliveryAddress || ''),
          status: initialStatus,
          assignedRiderName: authUser.role === 'ADMIN' ? body.assignedRiderName || null : null,
          assignedRiderPhone: authUser.role === 'ADMIN' ? body.assignedRiderPhone || null : null,
          assignedRiderUserId: authUser.role === 'ADMIN' ? body.assignedRiderUserId || null : null,
          payload: fullPayload,
          items: {
            create: items.map((it: any) => {
              return {
                productId: String(it.id || 'item'),
                name: String(it.name || 'Producto'),
                unitPrice: it.price,
                unitExtraPrice: Math.max(0, Number(it.unitExtraPrice) || 0),
                quantity: Math.max(1, Number(it.quantity) || 1),
                notes: it.notes ? String(it.notes) : null,
                customizations: it.customizations ?? null,
              };
            }),
          },
          statusHistory: {
            create: {
              fromStatus: null,
              toStatus: initialStatus,
              changedByUserId: authUser.sub,
              changedByRole: authUser.role,
              note: `Pedido creado (${body.paymentMethod || 'efectivo'})`,
            },
          },
        },
        include: {
          items: true,
          statusHistory: true,
        },
      });

      // Consumir cupón personal del usuario en la tabla relacional coupons si fue aplicado
      if (body.promoCode) {
        const codeUpper = String(body.promoCode).trim().toUpperCase();
        await tx.coupon.updateMany({
          where: {
            userId: customerUser.id,
            code: codeUpper,
            used: false,
          },
          data: {
            used: true,
            usedAt: new Date(),
            usedOrderFolio: createdOrder.folio,
          },
        });
      }

      return createdOrder;
    });

    const mapped = mapOrderRowToPayload(saved);
    emitOrderEvent('orders:created', mapped);
    emitOrderEvent('orders:updated', mapped);
    return reply.status(201).send(mapped);
  });

  // =========================================================================
  // 5. CREACIÓN EN LOTE (EXCLUSIVO ADMIN)
  // =========================================================================
  app.post('/api/orders/batch', { preHandler: [requireAdmin] }, async (request, reply) => {
    const body = request.body as { orders?: any[] };
    const orders = Array.isArray(body?.orders) ? body.orders.slice(0, 450) : [];
    if (orders.length === 0) {
      return reply.status(400).send({ error: 'No se enviaron órdenes en el lote.' });
    }

    if (orders.some(o => !isOrderStatus(String(o.status || 'nuevo')))) return reply.status(422).send({ error: 'Estado desconocido.' });
    const adminId = request.authUser!.sub;

    await prisma.$transaction(
      orders.map((o) => {
        const orderId = String(o.id || `ord-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
        const folio = String(o.folio || `RD-${orderId}`);
        return prisma.order.upsert({
          where: { id: orderId },
          update: {}, // Un reintento no sobrescribe el historial ni el estado.
          create: {
            id: orderId,
            folio,
            orderType: String(o.orderType || 'comida'),
            statusHistory: { create: { fromStatus: null, toStatus: String(o.status || 'nuevo'), changedByUserId: adminId, changedByRole: 'ADMIN', note: 'Importación administrativa' } },
            customerId: adminId,
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

    emitAdminEvent('orders:batch-updated', { count: orders.length });
    return reply.send({ ok: true, count: orders.length });
  });

  // =========================================================================
  // 6. ACTUALIZAR ORDEN (CON VERIFICACIÓN DE PROPIETARIO Y AUDITORÍA DE ESTADOS)
  // =========================================================================
  app.patch('/api/orders/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const authUser = request.authUser!;
    const { id } = request.params as { id: string };
    const rawUpdates = (request.body || {}) as Record<string, any>;

    const existing = await prisma.order.findUnique({ where: { id } });
    if (!existing) {
      return reply.status(404).send({ error: 'Orden no encontrada.' });
    }

    const isAdmin = authUser.role === 'ADMIN';
    if (!isAdmin && existing.customerId !== authUser.sub) {
      return reply.status(403).send({
        error: 'Acceso denegado: No puedes modificar un pedido que pertenece a otro usuario.',
      });
    }

    // Filtrar campos permitidos si el solicitante es un cliente normal
    const updates: Record<string, any> = isAdmin ? rawUpdates : {};
    if (!isAdmin) {
      for (const [key, value] of Object.entries(rawUpdates)) {
        if (CUSTOMER_ALLOWED_PATCH_FIELDS.has(key)) {
          updates[key] = value;
        }
      }

    }

    let assignedRiderUserId = existing.assignedRiderUserId;
    let assignedRiderName = existing.assignedRiderName;
    let assignedRiderPhone = existing.assignedRiderPhone;
    if (isAdmin && updates.assignedRiderUserId !== undefined) {
      const requestedRiderId = updates.assignedRiderUserId ? String(updates.assignedRiderUserId) : null;
      const rider = requestedRiderId
        ? await prisma.user.findFirst({
            where: { id: requestedRiderId, role: 'RIDER', status: 'activo' },
            select: { id: true, name: true, phone: true },
          })
        : null;
      if (requestedRiderId && !rider) {
        return reply.status(422).send({ error: 'La cuenta de repartidor no existe o está inactiva.' });
      }
      assignedRiderUserId = rider?.id || null;
      assignedRiderName = rider?.name || null;
      assignedRiderPhone = rider?.phone || null;
      updates.assignedRiderName = assignedRiderName;
      updates.assignedRiderPhone = assignedRiderPhone;
      if (requestedRiderId && updates.status === undefined && ['nuevo','en_preparacion'].includes(existing.status)) updates.status = 'asignado';
      if (!requestedRiderId && ['recolectado','en_camino','afuera_del_domicilio'].includes(existing.status)) return reply.status(409).send({ error: 'Reasigna el pedido a otra cuenta activa.' });
      if (!requestedRiderId && existing.status === 'asignado' && updates.status === undefined) {
        updates.status = 'nuevo';
      }
    }

    if (isAdmin && updates.status === 'asignado' && !assignedRiderUserId) {
      return reply.status(422).send({ error: 'Asigna una cuenta activa de repartidor antes de marcar el pedido como asignado.' });
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const prevPayload = (existing.payload || {}) as Record<string, any>;
    delete updates.quoteOfferedAt;
    for (const [field, folder] of [['deliverySignatureDataUrl', 'signatures'], ['deliveryProofPhotoUrl', 'proofs']]) {
      const url = updates[field];
      if (url === undefined || url === prevPayload[field]) continue;
      if (typeof url !== 'string' || !url.startsWith(`/uploads/${folder}/`) ||
          !await prisma.orderUpload.findFirst({ where: { orderId: id, url } })) {
        return reply.code(422).send({ error: 'La evidencia debe cargarse y pertenecer a este pedido.' });
      }
    }
    if (isAdmin && updates.paymentStatus === 'verificado') {
      if (existing.paymentMethod !== 'transferencia') return reply.status(422).send({ error: 'La orden no es por transferencia.' });
      updates.bankVerification = { trackingKey: existing.speiTrackingKey || prevPayload.bankVerification?.trackingKey || '',
        verified: true, verifiedAt: nowIso, verifiedAmount: existing.total,
        statusMessage: 'Depósito confirmado por despacho.' };
    }
    if (isAdmin && existing.status === 'pendiente_cotizacion' && updates.deliveryFee !== undefined) {
      const fuel = existing.orderType === 'auxilio_gasolina';
      const quotedSubtotal = fuel ? existing.subtotal : updates.subtotal;
      if (![quotedSubtotal, updates.deliveryFee].every(x => Number.isFinite(x) && x >= 0))
        return reply.status(422).send({ error: 'La cotización requiere importes válidos.' });
      updates.subtotal = quotedSubtotal;
      updates.total = money(quotedSubtotal + updates.deliveryFee);
      updates.quoteOfferedAt = nowIso;
      if (fuel) updates.fuelDetails = { ...prevPayload.fuelDetails, serviceTravelFee: updates.deliveryFee };
    }
    const mergedPayload = {
      ...prevPayload,
      ...updates,
      id,
      updatedAt: nowIso,
    };

    const nextStatus = updates.status !== undefined ? String(updates.status) : existing.status;

    const quoteOffered = Boolean(prevPayload.quoteOfferedAt || (existing.orderType !== 'auxilio_gasolina' && existing.subtotal > 0));
    const allowed = allowedOrderTransitions(authUser.role, { ...existing, assignedRiderUserId, quoteOffered });
    if (nextStatus !== existing.status && !allowed.includes(nextStatus)) {
      return reply.status(409).send({ error: 'El cambio de estado no está permitido para este pedido y rol.' });
    }
    if (!isAdmin && updates.quoteConfirmedByCustomer === true &&
        !(existing.status === 'pendiente_cotizacion' && nextStatus === 'nuevo' && quoteOffered)) {
      return reply.status(409).send({ error: 'Primero despacho debe emitir la cotización.' });
    }
    if (!isAdmin && existing.status === 'pendiente_cotizacion' && nextStatus === 'nuevo' &&
        !matchesDisplayedQuote(existing.total, prevPayload.quoteOfferedAt, rawUpdates.expectedQuoteTotal, rawUpdates.expectedQuoteOfferedAt)) {
      return reply.status(409).send({ error: 'La cotización cambió. Revisa el importe actualizado y confirma de nuevo.' });
    }
    if (!isAdmin && existing.status === 'pendiente_cotizacion' && nextStatus === 'nuevo' && updates.quoteConfirmedByCustomer !== true) {
      return reply.status(409).send({ error: 'Confirma la cotización antes de continuar.' });
    }
    const updated = await prisma.$transaction(async (tx) => {
      const changed = await tx.order.updateMany({
        where: { id, status: existing.status, updatedAt: existing.updatedAt },
        data: {
          status: nextStatus,
          paymentStatus:
            isAdmin && updates.paymentStatus !== undefined
              ? String(updates.paymentStatus)
              : undefined,
          subtotal:
            isAdmin && updates.subtotal !== undefined ? Number(updates.subtotal) : existing.subtotal,
          deliveryFee:
            isAdmin && updates.deliveryFee !== undefined
              ? Number(updates.deliveryFee)
              : existing.deliveryFee,
          total: isAdmin && updates.total !== undefined ? Number(updates.total) : existing.total,
          assignedRiderName:
            isAdmin && (updates.assignedRiderUserId !== undefined || updates.assignedRiderName !== undefined)
              ? assignedRiderName
              : existing.assignedRiderName,
          assignedRiderPhone:
            isAdmin && (updates.assignedRiderUserId !== undefined || updates.assignedRiderPhone !== undefined)
              ? assignedRiderPhone
              : existing.assignedRiderPhone,
          assignedRiderUserId:
            isAdmin && updates.assignedRiderUserId !== undefined
              ? assignedRiderUserId
              : existing.assignedRiderUserId,
          payload: mergedPayload,
        },
      });
      if (!changed.count) return null;

      if (isAdmin && updates.quoteOfferedAt && Array.isArray(updates.items)) {
        await tx.orderItem.deleteMany({ where: { orderId: id } });
        await tx.orderItem.create({ data: { orderId: id, productId: 'it-quoted',
          name: existing.orderType === 'auxilio_gasolina' ? 'Combustible' : 'Artículos cotizados',
          quantity: 1, unitPrice: updates.subtotal } });
      }
      if (nextStatus !== existing.status) {
        await tx.orderStatusHistory.create({
          data: {
            orderId: id,
            fromStatus: existing.status,
            toStatus: nextStatus,
            changedByUserId: authUser.sub,
              changedByRole: authUser.role,
            note: updates.cancellationReason || (isAdmin ? 'Actualizado por Despacho' : 'Confirmado por Cliente'),
          },
        });
      }

      // Al entregarse la orden por primera vez, incrementar completedOrdersCount del cliente propietario
      if (nextStatus === 'entregado' && existing.status !== 'entregado') {
        await tx.user.update({
          where: { id: existing.customerId },
          data: { completedOrdersCount: { increment: 1 } },
        });
      }

      // Si el administrador marca cancelación con adeudo, bloquear cuenta y revocar sesiones activas
      if (isAdmin && existing.status !== nextStatus && nextStatus === 'cancelado_con_deuda') {
        const debtAmount = Number(updates.cancellationDebtAmount ?? existing.total);
        await tx.user.update({
          where: { id: existing.customerId },
          data: {
            pendingDebt: debtAmount,
            debtReason: updates.cancellationReason || 'Cancelación con adeudo pendiente',
            debtOrderFolio: existing.folio,
            debtDate: now.toLocaleDateString('es-MX'),
            status: 'bloqueado_fraude',
            blockedAt: now,
          },
        });
        await tx.refreshSession.updateMany({
          where: { userId: existing.customerId, revokedAt: null },
          data: { revokedAt: now },
        });
      }

      return tx.order.findUniqueOrThrow({ where: { id }, include: { items: true, statusHistory: { orderBy: { createdAt: 'desc' }, take: 10 } } });
    });

    if (!updated) return reply.status(409).send({ error: 'Otro usuario cambió el pedido. Actualiza e inténtalo de nuevo.' });

    const mapped = mapOrderRowToPayload(updated);
    emitOrderEvent('orders:updated', mapped);
    return reply.send(mapped);
  });
}
