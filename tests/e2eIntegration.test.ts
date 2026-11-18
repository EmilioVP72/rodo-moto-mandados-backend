import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:8080';

async function e2eFetch(path: string, options: RequestInit = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json')
    ? await res.json().catch(() => null)
    : await res.text().catch(() => null);
  return { status: res.status, ok: res.ok, data, headers: res.headers };
}

describe('Fase 4 · End-to-End Integration Tests (Nginx + Fastify + PostgreSQL 16 + Redis 7)', () => {
  let adminToken = '';
  let customerToken = '';
  let testCustomerId = '';
  let createdOrderId = '';
  const uniqueRunId = Date.now().toString().slice(-6);
  const uniqueSpeiKey = `SPEI20261118${uniqueRunId}`;

  it('1. Nginx sirve el Frontend PWA, Service Worker y proxy /api/health en estado healthy', async () => {
    const htmlRes = await fetch(`${BASE_URL}/`);
    assert.equal(htmlRes.status, 200);
    const htmlText = await htmlRes.text();
    assert.ok(htmlText.includes('<div id="root">'));

    const swRes = await fetch(`${BASE_URL}/sw.js`);
    assert.equal(swRes.status, 200);
    const swText = await swRes.text();
    assert.ok(swText.includes('rodo-pwa-cache-v1'));

    const health = await e2eFetch('/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.data.status, 'healthy');
    assert.equal(health.data.database, 'connected');
    assert.equal(health.data.redis, 'connected');
  });

  it('2. Sincroniza catálogo semilla en PostgreSQL (/api/seed) y consulta restaurantes y locales por PIN', async () => {
    const seedRes = await e2eFetch('/api/seed', {
      method: 'POST',
      body: JSON.stringify({
        restaurants: [
          {
            id: 'tacos-sebas',
            name: 'Tacos Sebastián',
            establishmentType: 'restaurante',
            category: 'Tacos al Carbón',
            deliveryFee: 35,
            commissionRate: 15,
            isActive: true,
            isOpen: true,
            menu: [
              { id: 'ts-1', name: 'Orden de 4 Tacos de Bistec', price: 100, originalPrice: 85, surcharge: 15 },
              { id: 'ts-4', name: 'Refresco 600ml', price: 30, originalPrice: 25, surcharge: 5 },
            ],
          },
        ],
        settings: {
          rainPauseEnabled: false,
          baseDeliveryTariff: 35,
          tariffPerKm: 7,
        },
      }),
    });
    assert.equal(seedRes.status, 200);
    assert.equal(seedRes.data.ok, true);

    const restRes = await e2eFetch('/api/restaurants');
    assert.equal(restRes.status, 200);
    assert.ok(Array.isArray(restRes.data) && restRes.data.length >= 1);

    const pinRes = await e2eFetch('/api/partner-locals/code/101');
    assert.equal(pinRes.status, 200);
    assert.equal(pinRes.data.name, 'Tacos Sebastián');
  });

  it('3. Autentica al Administrador con JWT y rechaza contraseñas incorrectas', async () => {
    const badLogin = await e2eFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'edsoncruz14999@gmail.com', password: 'WRONG_PASSWORD' }),
    });
    assert.equal(badLogin.status, 401);

    const adminLogin = await e2eFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'edsoncruz14999@gmail.com', password: 'RODO2026' }),
    });
    assert.equal(adminLogin.status, 200);
    assert.equal(adminLogin.data.isAdmin, true);
    assert.ok(adminLogin.data.token);
    adminToken = adminLogin.data.token;

    const meRes = await e2eFetch('/api/auth/me', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(meRes.status, 200);
    assert.equal(meRes.data.user.role, 'ADMIN');
  });

  it('4. Bloquea registro con INE deudor (8942105434) y registra cliente nuevo con INE válido (8942105438)', async () => {
    const debtorAttempt = await e2eFetch('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Intento Deudor',
        phone: '4151998877',
        email: `deudor.${uniqueRunId}@ejemplo.com`,
        password: 'Password123',
        ine10Digits: '8942105434', // INE de Roberto Gómez con deuda de $340 MXN en PostgreSQL
      }),
    });
    assert.equal(debtorAttempt.status, 403);
    assert.ok(debtorAttempt.data.error.includes('ADEUDO'));

    // Generar un INE de 10 dígitos válido único para esta ejecución calculando su dígito verificador OACI 7-3-1
    const base9 = `741${uniqueRunId}`;
    const weights = [7, 3, 1, 7, 3, 1, 7, 3, 1];
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += parseInt(base9[i], 10) * weights[i];
    const checkDigit = sum % 10;
    const validUniqueIne = `${base9}${checkDigit}`;

    const registerRes = await e2eFetch('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Cliente Prueba E2E',
        phone: `4151${uniqueRunId}`,
        email: `cliente.e2e.${uniqueRunId}@rodo.mx`,
        password: 'PasswordE2E!',
        ine10Digits: validUniqueIne,
      }),
    });
    assert.equal(registerRes.status, 201);
    assert.ok(registerRes.data.token);
    assert.ok(registerRes.data.user.referralCode.startsWith('RODO-'));
    customerToken = registerRes.data.token;
    testCustomerId = registerRes.data.user.id;
  });

  it('5. Valida transferencia SPEI en servidor y recalcula precios alterados al crear una orden', async () => {
    const fakeSpei = await e2eFetch('/api/orders/verify-transfer', {
      method: 'POST',
      body: JSON.stringify({
        trackingKey: '123456',
        expectedAmount: 235,
        senderBank: 'BBVA',
        orderFolio: `RD-E2E-${uniqueRunId}`,
      }),
    });
    assert.equal(fakeSpei.data.verified, false);

    const realSpei = await e2eFetch('/api/orders/verify-transfer', {
      method: 'POST',
      body: JSON.stringify({
        trackingKey: uniqueSpeiKey,
        expectedAmount: 235,
        senderBank: 'BBVA',
        orderFolio: `RD-E2E-${uniqueRunId}`,
      }),
    });
    assert.equal(realSpei.data.verified, true);

    // Crear orden enviando un precio manipulado ($1 MXN en vez de $100 MXN por orden de tacos)
    const orderFolio = `RD-261118-${uniqueRunId}`;
    const createOrderRes = await e2eFetch('/api/orders', {
      method: 'POST',
      headers: { Authorization: `Bearer ${customerToken}` },
      body: JSON.stringify({
        id: `ord-e2e-${uniqueRunId}`,
        folio: orderFolio,
        orderType: 'comida',
        customerId: testCustomerId,
        customerName: 'Cliente Prueba E2E',
        customerPhone: `4151${uniqueRunId}`,
        customerEmail: `cliente.e2e.${uniqueRunId}@rodo.mx`,
        restaurantId: 'tacos-sebas',
        restaurantName: 'Tacos Sebastián',
        items: [
          { id: 'ts-1', name: 'Orden de 4 Tacos de Bistec', price: 1, quantity: 2 }, // Manipulado a $1
        ],
        subtotal: 2,
        deliveryFee: 35,
        total: 37,
        paymentMethod: 'transferencia',
        paymentStatus: 'verificado',
        bankVerification: realSpei.data,
        deliveryAddress: 'Calle Correo #14, Centro, San Miguel de Allende',
        status: 'nuevo',
      }),
    });

    assert.equal(createOrderRes.status, 201);
    // El servidor debe haber recalculado 2 x $100 = $200 subtotal + $35 envío = $235 total
    assert.equal(createOrderRes.data.subtotal, 200);
    assert.equal(createOrderRes.data.total, 235);
    createdOrderId = createOrderRes.data.id;

    // Intentar reutilizar la misma clave de rastreo SPEI en otro pedido debe ser bloqueado
    const duplicateSpeiCheck = await e2eFetch('/api/orders/verify-transfer', {
      method: 'POST',
      body: JSON.stringify({
        trackingKey: uniqueSpeiKey,
        expectedAmount: 235,
        senderBank: 'BBVA',
        orderFolio: `RD-OTHER-${uniqueRunId}`,
      }),
    });
    assert.equal(duplicateSpeiCheck.data.verified, false);
    assert.ok(duplicateSpeiCheck.data.statusMessage.includes('ya fue utilizada'));
  });

  it('6. Rechaza pedido en efectivo que excede el límite antifraude de $300 MXN para cliente nuevo (HTTP 422)', async () => {
    const cashLimitOrder = await e2eFetch('/api/orders', {
      method: 'POST',
      body: JSON.stringify({
        id: `ord-cash-limit-${uniqueRunId}`,
        folio: `RD-CASH-${uniqueRunId}`,
        orderType: 'comida',
        customerId: testCustomerId,
        customerName: 'Cliente Prueba E2E',
        customerPhone: `4151${uniqueRunId}`,
        restaurantId: 'tacos-sebas',
        restaurantName: 'Tacos Sebastián',
        items: [
          { id: 'ts-1', name: 'Orden de 4 Tacos de Bistec', price: 100, quantity: 4 }, // $400 MXN > $300 límite
        ],
        subtotal: 400,
        deliveryFee: 35,
        total: 435,
        paymentMethod: 'efectivo',
        paymentStatus: 'en_efectivo',
        deliveryAddress: 'Calle Hidalgo #12, Centro, SMA',
        status: 'nuevo',
      }),
    });

    assert.equal(cashLimitOrder.status, 422);
    assert.ok(cashLimitOrder.data.error.includes('$300 MXN'));
  });

  it('7. Sube firma digital de entrega (/api/uploads), completa orden y eleva límite del cliente en PostgreSQL', async () => {
    // 1x1 pixel PNG transparente en Base64
    const tinyPngDataUrl =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    const uploadRes = await e2eFetch('/api/uploads', {
      method: 'POST',
      body: JSON.stringify({
        dataUrl: tinyPngDataUrl,
        folder: 'signatures',
        referenceId: createdOrderId,
      }),
    });
    assert.equal(uploadRes.status, 201);
    assert.ok(uploadRes.data.url.startsWith('/uploads/signatures/'));

    // Verificar que Nginx sirve la imagen subida desde el volumen persistente
    const fileRes = await fetch(`${BASE_URL}${uploadRes.data.url}`);
    assert.equal(fileRes.status, 200);

    // Completar entrega y calificar con 5 estrellas
    const patchRes = await e2eFetch(`/api/orders/${encodeURIComponent(createdOrderId)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'entregado',
        deliverySignatureDataUrl: uploadRes.data.url,
        deliveryConfirmedBySignature: true,
        receptionConfirmed: true,
        rating: 5,
        riderRating: 5,
        foodRating: 5,
      }),
    });
    assert.equal(patchRes.status, 200);
    assert.equal(patchRes.data.status, 'entregado');

    // Verificar en /api/auth/me que completedOrdersCount subió de 0 a 1
    const meAfter = await e2eFetch('/api/auth/me', {
      headers: { Authorization: `Bearer ${customerToken}` },
    });
    assert.equal(meAfter.status, 200);
    assert.equal(meAfter.data.user.completedOrdersCount, 1);
  });

  it('8. Bloquea nuevos pedidos cuando el Administrador activa la Pausa por Lluvia (HTTP 503) y restaura operación', async () => {
    const enableRain = await e2eFetch('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        rainPauseEnabled: true,
        rainPauseMessage: '🌧️ Lluvia fuerte en el Centro de San Miguel.',
      }),
    });
    assert.equal(enableRain.status, 200);
    assert.equal(enableRain.data.rainPauseEnabled, true);

    const orderDuringRain = await e2eFetch('/api/orders', {
      method: 'POST',
      body: JSON.stringify({
        id: `ord-rain-${uniqueRunId}`,
        folio: `RD-RAIN-${uniqueRunId}`,
        orderType: 'comida',
        customerId: testCustomerId,
        customerName: 'Cliente Prueba E2E',
        customerPhone: `4151${uniqueRunId}`,
        restaurantId: 'tacos-sebas',
        restaurantName: 'Tacos Sebastián',
        items: [{ id: 'ts-4', name: 'Refresco 600ml', price: 30, quantity: 1 }],
        subtotal: 30,
        deliveryFee: 35,
        total: 65,
        paymentMethod: 'efectivo',
        paymentStatus: 'en_efectivo',
        deliveryAddress: 'Calle Correo #14, Centro',
        status: 'nuevo',
      }),
    });
    assert.equal(orderDuringRain.status, 503);

    // Restaurar rainPauseEnabled = false
    const disableRain = await e2eFetch('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ rainPauseEnabled: false }),
    });
    assert.equal(disableRain.status, 200);
    assert.equal(disableRain.data.rainPauseEnabled, false);
  });
});
