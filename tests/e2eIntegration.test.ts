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

async function readMailboxCode(email: string): Promise<string> {
  const inbox = new URL('/api/v1/messages', process.env.E2E_MAILPIT_URL);
  const messages = await (await fetch(inbox)).json();
  const message = messages.messages.find((m: any) => m.To.some((address: any) => address.Address === email));
  assert.ok(message, 'Debe llegar correo a la cuenta de prueba');
  const mail = await (await fetch(new URL('/api/v1/message/' + message.ID, inbox))).json();
  const resetCode = mail.Text.match(/\b\d{6}\b/)?.[0];
  assert.ok(resetCode);
  return resetCode;
}

function makeValidIne10(seed6: string, prefix3: string): string {
  const base9 = `${prefix3}${seed6.slice(-6).padStart(6, '0')}`;
  const weights = [7, 3, 1, 7, 3, 1, 7, 3, 1];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(base9[i], 10) * weights[i];
  return `${base9}${sum % 10}`;
}

describe('End-to-End Integration Tests (Relational PostgreSQL + Auth + Password Reset + Strict Privacy Isolation)', () => {
  let adminToken = '';
  let customerAToken = '';
  let customerARefresh = '';
  let customerAId = '';
  let customerBToken = '';
  let orderAId = '';

  const runId = Date.now().toString().slice(-6);
  const emailA = `cliente.a.${runId}@rodo.mx`;
  const emailB = `cliente.b.${runId}@rodo.mx`;
  const uniqueSpeiKey = `SPEI20261118${runId}`;

  it('1. Nginx sirve Frontend PWA, Service Worker y proxy /api/health en estado healthy', async () => {
    const htmlRes = await fetch(`${BASE_URL}/`);
    assert.equal(htmlRes.status, 200);
    assert.ok((await htmlRes.text()).includes('<div id="root">'));

    const swRes = await fetch(`${BASE_URL}/sw.js`);
    assert.equal(swRes.status, 200);
    assert.ok((await swRes.text()).includes('rodo-pwa-cache-'));

    const health = await e2eFetch('/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.data.status, 'healthy');
    assert.equal(health.data.database, 'connected');
    assert.equal(health.data.redis, 'connected');
  });

  it('2. Rechaza acceso sin autenticación a /api/orders, /api/auth/me y /api/profile/addresses (HTTP 401)', async () => {
    const unauthOrders = await e2eFetch('/api/orders');
    assert.equal(unauthOrders.status, 401);

    const unauthMe = await e2eFetch('/api/auth/me');
    assert.equal(unauthMe.status, 401);

    const unauthAddresses = await e2eFetch('/api/profile/addresses');
    assert.equal(unauthAddresses.status, 401);
  });

  it('3. Autentica al Administrador, siembra catálogo y verifica aislamiento RBAC', async () => {
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
    assert.ok(adminLogin.data.refreshToken);
    adminToken = adminLogin.data.token;

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
        settings: { rainPauseEnabled: false, baseDeliveryTariff: 35, tariffPerKm: 7 },
      }),
    });
    assert.equal(seedRes.status, 200);

    // Verificar que GET /api/settings público NO filtra adminPasscode
    const publicSettings = await e2eFetch('/api/settings');
    assert.equal(publicSettings.status, 200);
    assert.equal(publicSettings.data.adminPasscode, undefined);
  });

  it('4. Registra Cliente A y Cliente B en PostgreSQL, bloquea INE deudor y protege endpoints Admin (403)', async () => {
    const debtor = { name: 'Cuenta de prueba', phone: '4153' + runId, email: 'bloqueo.' + runId + '@example.invalid',
      password: 'Pruebas123!', ine10Digits: makeValidIne10(runId, '693') };
    const registered = await e2eFetch('/api/auth/register', { method: 'POST', body: JSON.stringify(debtor) });
    assert.equal(registered.status, 201);
    const blocked = await e2eFetch('/api/auth/blocked-customers', { method: 'POST',
      headers: { Authorization: 'Bearer ' + adminToken }, body: JSON.stringify({ identifier: debtor.email }) });
    assert.equal(blocked.status, 201);
    const debtorAttempt = await e2eFetch('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Intento Deudor',
        phone: '4151998877',
        email: `deudor.${runId}@ejemplo.com`,
        password: 'Password123!',
        ine10Digits: debtor.ine10Digits,
      }),
    });
    assert.equal(debtorAttempt.status, 403);

    const regA = await e2eFetch('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Cliente A Privado',
        phone: `4151${runId}`,
        email: emailA,
        password: 'PasswordA123!',
        ine10Digits: makeValidIne10(runId, '741'),
      }),
    });
    assert.equal(regA.status, 201);
    assert.ok(regA.data.token);
    assert.ok(regA.data.refreshToken);
    customerAToken = regA.data.token;
    customerARefresh = regA.data.refreshToken;
    customerAId = regA.data.user.id;

    // Cliente A no puede acceder a rutas exclusivas de Admin (HTTP 403)
    const forbiddenAccounts = await e2eFetch('/api/auth/accounts', {
      headers: { Authorization: `Bearer ${customerAToken}` },
    });
    assert.equal(forbiddenAccounts.status, 403);

    const forbiddenSettings = await e2eFetch('/api/settings', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${customerAToken}` },
      body: JSON.stringify({ rainPauseEnabled: true }),
    });
    assert.equal(forbiddenSettings.status, 403);

    // Registrar Cliente B (usando código de referido de Cliente A para validar tabla relacional coupons)
    const regB = await e2eFetch('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Cliente B Independiente',
        phone: `4152${runId}`,
        email: emailB,
        password: 'PasswordB123!',
        ine10Digits: makeValidIne10(runId, '852'),
        referralCodeInput: regA.data.user.referralCode,
      }),
    });
    assert.equal(regB.status, 201);
    assert.equal(regB.data.user.coupons.length, 1); // Cupón de bienvenida en tabla coupons
    customerBToken = regB.data.token;
  });

  it('5. Aislamiento Estricto Multi-Usuario: Cliente B JAMÁS puede ver ni editar direcciones ni pedidos de Cliente A', async () => {
    // Cliente A guarda su dirección privada en customer_addresses (incluyendo Departamento con numero NULL + numeroInterior)
    const addrRes = await e2eFetch('/api/profile/addresses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${customerAToken}` },
      body: JSON.stringify({
        label: 'Departamento',
        calle: 'Calle Correo',
        numero: null,
        numeroInterior: '4B',
        colonia: 'Centro',
        isDefault: true,
      }),
    });
    assert.equal(addrRes.status, 201);
    assert.equal(addrRes.data.label, 'Departamento');
    assert.equal(addrRes.data.numero, null);
    assert.equal(addrRes.data.numeroInterior, '4B');

    // Cliente A verifica SPEI y crea un pedido (con precio alterado para validar recálculo server-side)
    const speiRes = await e2eFetch('/api/orders/verify-transfer', {
      method: 'POST',
      headers: { Authorization: `Bearer ${customerAToken}` },
      body: JSON.stringify({
        trackingKey: uniqueSpeiKey,
        expectedAmount: 235,
        senderBank: 'BBVA',
        orderFolio: `RD-ISO-${runId}`,
      }),
    });
    assert.equal(speiRes.data.verified, false);

    const createOrderA = await e2eFetch('/api/orders', {
      method: 'POST',
      headers: { Authorization: `Bearer ${customerAToken}` },
      body: JSON.stringify({
        id: `ord-a-${runId}`,
        folio: `RD-ISO-${runId}`,
        orderType: 'comida',
        restaurantId: 'tacos-sebas',
        restaurantName: 'Tacos Sebastián',
        items: [{ id: 'ts-1', name: 'Orden de 4 Tacos de Bistec', price: 1, quantity: 2 }],
        subtotal: 2,
        deliveryFee: 35,
        total: 37,
        paymentMethod: 'transferencia',
        paymentStatus: 'verificado',
        bankVerification: speiRes.data,
        deliveryAddress: 'Calle Correo #14, Centro',
        status: 'nuevo',
      }),
    });
    assert.equal(createOrderA.status, 201);
    assert.equal(createOrderA.data.paymentStatus, 'pendiente');
    assert.equal(createOrderA.data.subtotal, 200); // Recalculado en servidor
    assert.equal(createOrderA.data.total, 235);
    assert.equal(createOrderA.data.customerId, customerAId);
    orderAId = createOrderA.data.id;

    // Cliente A SÍ ve su propio pedido y su dirección
    const ordersOfA = await e2eFetch('/api/orders', {
      headers: { Authorization: `Bearer ${customerAToken}` },
    });
    assert.equal(ordersOfA.status, 200);
    assert.equal(ordersOfA.data.length, 1);
    assert.equal(ordersOfA.data[0].id, orderAId);

    // Cliente B consulta GET /api/orders (incluso intentando forzar ?customerId=<customerAId>)
    const ordersOfB = await e2eFetch(`/api/orders?customerId=${encodeURIComponent(customerAId)}`, {
      headers: { Authorization: `Bearer ${customerBToken}` },
    });
    assert.equal(ordersOfB.status, 200);
    assert.equal(ordersOfB.data.length, 0); // CERO pedidos ajenos visibles

    // Cliente B intenta leer el pedido de Cliente A directamente -> 403 Forbidden
    const spyOrder = await e2eFetch(`/api/orders/${encodeURIComponent(orderAId)}`, {
      headers: { Authorization: `Bearer ${customerBToken}` },
    });
    assert.equal(spyOrder.status, 403);

    // Cliente B intenta modificar el pedido de Cliente A -> 403 Forbidden
    const tamperOrder = await e2eFetch(`/api/orders/${encodeURIComponent(orderAId)}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${customerBToken}` },
      body: JSON.stringify({ status: 'cancelado' }),
    });
    assert.equal(tamperOrder.status, 403);

    // Cliente B consulta direcciones -> NO ve las direcciones de Cliente A
    const addrsOfB = await e2eFetch('/api/profile/addresses', {
      headers: { Authorization: `Bearer ${customerBToken}` },
    });
    assert.equal(addrsOfB.status, 200);
    assert.equal(addrsOfB.data.length, 0);
  });

  it('6. Recuperación Real de Contraseña (forgot-password -> código 6 dígitos -> reset-password) y revocación de sesiones viejas', { skip: !process.env.E2E_MAILPIT_URL && 'Requiere buzón de prueba Mailpit' }, async () => {
    const forgotRes = await e2eFetch('/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email: emailA }),
    });
    assert.equal(forgotRes.status, 200);
    assert.equal(forgotRes.data.ok, true);
    assert.equal(forgotRes.data.resetCodePreview, undefined);
    const resetCode = await readMailboxCode(emailA);

    // Código incorrecto debe ser rechazado (400)
    const wrongCodeRes = await e2eFetch('/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({
        email: emailA,
        code: '000000',
        newPassword: 'NewPasswordA999!',
      }),
    });
    assert.equal(wrongCodeRes.status, 400);

    // Código correcto restablece contraseña y revoca sesiones previas
    const resetRes = await e2eFetch('/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({
        email: emailA,
        code: resetCode,
        newPassword: 'NewPasswordA999!',
      }),
    });
    assert.equal(resetRes.status, 200);
    assert.equal(resetRes.data.ok, true);
    assert.ok(resetRes.data.token);

    // El token ANTERIOR de Cliente A ahora está revocado en refresh_sessions -> 401 Unauthorized
    const oldTokenCheck = await e2eFetch('/api/auth/me', {
      headers: { Authorization: `Bearer ${customerAToken}` },
    });
    assert.equal(oldTokenCheck.status, 401);

    // La contraseña vieja ya no sirve -> 401
    const oldPassLogin = await e2eFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: emailA, password: 'PasswordA123!' }),
    });
    assert.equal(oldPassLogin.status, 401);

    // La contraseña NUEVA funciona correctamente -> 200
    const newPassLogin = await e2eFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: emailA, password: 'NewPasswordA999!' }),
    });
    assert.equal(newPassLogin.status, 200);
    customerAToken = newPassLogin.data.token;
    customerARefresh = newPassLogin.data.refreshToken;
  });

  it('7. Rotación de Refresh Token (/api/auth/refresh) y Cierre de Sesión con Revocación (/api/auth/logout)', async () => {
    const refreshRes = await e2eFetch('/api/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: customerARefresh }),
    });
    assert.equal(refreshRes.status, 200);
    assert.ok(refreshRes.data.token);
    assert.ok(refreshRes.data.refreshToken);

    const rotatedToken = refreshRes.data.token;
    const rotatedRefresh = refreshRes.data.refreshToken;

    // Logout revoca la sesión en PostgreSQL
    const logoutRes = await e2eFetch('/api/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${rotatedToken}` },
      body: JSON.stringify({ refreshToken: rotatedRefresh }),
    });
    assert.equal(logoutRes.status, 200);

    // El token revocado ya no puede consultar /api/auth/me
    const afterLogoutMe = await e2eFetch('/api/auth/me', {
      headers: { Authorization: `Bearer ${rotatedToken}` },
    });
    assert.equal(afterLogoutMe.status, 401);
  });

  it('8. Admin puede ver todas las órdenes, consultar histórico y activar/desactivar Pausa por Lluvia (503)', async () => {
    const adminOrders = await e2eFetch('/api/orders', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(adminOrders.status, 200);
    assert.ok(adminOrders.data.some((o: any) => o.id === orderAId));

    // Verificar que el Histórico de Pedidos es EXCLUSIVO para Admin (403 para clientes, 200 para Admin)
    const forbiddenHistory = await e2eFetch('/api/admin/orders/history', {
      headers: { Authorization: `Bearer ${customerBToken}` },
    });
    assert.equal(forbiddenHistory.status, 403);

    const adminHistory = await e2eFetch(
      `/api/admin/orders/history?search=${encodeURIComponent(`RD-ISO-${runId}`)}`,
      {
        headers: { Authorization: `Bearer ${adminToken}` },
      }
    );
    assert.equal(adminHistory.status, 200);
    assert.ok(Array.isArray(adminHistory.data.orders));
    assert.ok(adminHistory.data.orders.some((o: any) => o.id === orderAId));
    assert.ok(adminHistory.data.summary.totalCount >= 1);

    const enableRain = await e2eFetch('/api/settings', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ rainPauseEnabled: true }),
    });
    assert.equal(enableRain.status, 200);

    const orderDuringRain = await e2eFetch('/api/orders', {
      method: 'POST',
      headers: { Authorization: `Bearer ${customerBToken}` },
      body: JSON.stringify({
        id: `ord-rain-${runId}`,
        folio: `RD-RAIN-${runId}`,
        orderType: 'comida',
        restaurantId: 'tacos-sebas',
        restaurantName: 'Tacos Sebastián',
        items: [{ id: 'ts-4', name: 'Refresco 600ml', price: 30, quantity: 1 }],
        subtotal: 30,
        deliveryFee: 35,
        total: 65,
        paymentMethod: 'efectivo',
        paymentStatus: 'en_efectivo',
        deliveryAddress: 'Calle Correo #14',
        status: 'nuevo',
      }),
    });
    assert.equal(orderDuringRain.status, 503);

    const disableRain = await e2eFetch('/api/settings', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ rainPauseEnabled: false }),
    });
    assert.equal(disableRain.status, 200);
  });

  function options(token: string, method = 'GET', body?: object) {
    return { method, headers: { Authorization: 'Bearer ' + token }, body: body && JSON.stringify(body) };
  }

  it('9. La identidad capturada cambia a revisada después del cotejo de despacho', async () => {
    const me = await e2eFetch('/api/auth/me', options(customerBToken));
    assert.equal(me.data.user.ineVerified, false);
    const review = await e2eFetch('/api/auth/accounts/' + me.data.user.id + '/identity-review',
      options(adminToken, 'POST', { digits: makeValidIne10(runId, '852'), checkedOriginal: true }));
    assert.equal(review.status, 200);
    assert.equal((await e2eFetch('/api/auth/me', options(customerBToken))).data.user.ineVerified, true);
  });

  it('10. Un comercio despacha con folio y el cupón personal se consume una sola vez', async () => {
    const me = await e2eFetch('/api/auth/me', options(customerBToken));
    const code = me.data.user.coupons[0].code;
    const order = { restaurantId: 'tacos-sebas', restaurantName: 'Tacos Sebastián', items: [{id:'ts-1',quantity:1}],
      deliveryAddress: 'Calle Correo 14, Centro', promoCode: code, paymentMethod: 'efectivo' };
    const dispatch = () => e2eFetch('/api/dispatch-order', options(customerBToken, 'POST', order));
    const attempts = await Promise.all([dispatch(), dispatch()]);
    const created = attempts.filter(r => r.status === 201);
    assert.equal(created.length, 1);
    assert.ok(attempts.some(r => [409,422].includes(r.status)));
    assert.equal(created[0].data.total, 100);
    assert.ok(created[0].data.folio.startsWith('RD-'));
    const dispatchWithoutCoupon = () => e2eFetch('/api/dispatch-order',
      options(customerBToken, 'POST', { ...order, promoCode: '' }));
    const [first, second] = await Promise.all([dispatchWithoutCoupon(), dispatchWithoutCoupon()]);
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.ok(first.data.id && second.data.id);
    assert.notEqual(first.data.id, second.data.id);
    assert.notEqual(first.data.folio, second.data.folio);
    const history = await e2eFetch('/api/admin/orders/history?search=' + created[0].data.folio, options(adminToken));
    assert.ok(history.data.orders.some((o: any) => o.folio === created[0].data.folio));
    assert.equal((await e2eFetch('/api/auth/me', options(customerBToken))).data.user.coupons[0].used, true);
  });

  it('11. El corte solo incorpora el SPEI al confirmar y la entrega actualiza el crédito', async () => {
    const cut = async () => (await e2eFetch('/api/admin/daily-receipts', options(adminToken))).data;
    const before = await cut();
    const orderPath = '/api/orders/' + orderAId;
    assert.equal((await e2eFetch(orderPath, options(adminToken))).data.paymentStatus, 'pendiente');
    assert.equal((await e2eFetch(orderPath, options(adminToken,'PATCH',{paymentStatus:'verificado'}))).status,200);
    assert.equal((await cut()).totalTransfer - before.totalTransfer, 235);
    const rider = await e2eFetch('/api/admin/riders', options(adminToken,'POST',{name:'Moto QA',phone:'4154'+runId,
      email:'rider.'+runId+'@example.invalid',password:'RiderQA123!'}));
    assert.equal(rider.status,201);
    assert.equal((await e2eFetch(orderPath, options(adminToken,'PATCH',{assignedRiderUserId:rider.data.id}))).status,200);
    for (const status of ['recolectado','en_camino','afuera_del_domicilio','entregado']) {
      assert.equal((await e2eFetch(orderPath, options(adminToken,'PATCH',{status}))).status,200);
    }
    const users = await e2eFetch('/api/auth/accounts', options(adminToken));
    const owner = users.data.find((u: any) => u.id === customerAId);
    assert.equal(owner.completedOrdersCount,1);
    assert.equal(owner.cashLimit,400);
    assert.equal((await cut()).totalTransfer - before.totalTransfer,235);
  });

  it('12. Una campaña futura queda privada hasta que vence su programación', async () => {
    const id = 'qa-programada-' + runId;
    const post = await e2eFetch('/api/broadcasts',options(adminToken,'POST',{id,title:'Aviso de prueba',message:'Prueba',
      scheduledFor:new Date(Date.now()+2500).toISOString(),sendImmediately:false}));
    assert.equal(post.status,201);
    const contains = async (path: string, token: string) =>
      (await e2eFetch(path,options(token))).data.filter((n: any) => n.id === id).length;
    assert.equal(await contains('/api/admin/broadcasts',adminToken),1);
    assert.equal(await contains('/api/broadcasts',customerBToken),0);
    const deadline = Date.now()+12000;
    while (Date.now()<deadline && !await contains('/api/broadcasts',customerBToken)) {
      await new Promise(resolve=>setTimeout(resolve,300));
    }
    assert.equal(await contains('/api/broadcasts',customerBToken),1);
  });
  it('13. Las recuperaciones antiguas aprobadas habilitan el acceso mediante correo', {
    skip: !process.env.E2E_MAILPIT_URL && 'Requiere buzón de prueba Mailpit',
  }, async () => {
    const email = 'legacy.' + runId + '@example.invalid';
    const id = 'legacy-' + runId;
    const recovery = await e2eFetch('/api/auth/recovery', { method:'POST', body:JSON.stringify({
      id, folio:id, newEmail:email, customerName:'Cuenta histórica', phone:'4159'+runId,
      documentPhotoUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+kZQAAAABJRU5ErkJggg==',
    }) });
    assert.equal(recovery.status,201);
    assert.equal((await e2eFetch('/api/auth/recovery/'+id,options(adminToken,'PATCH',{status:'aprobada'}))).status,200);
    const request = await e2eFetch('/api/auth/forgot-password',{method:'POST',body:JSON.stringify({email})});
    assert.equal(request.status,200);
    assert.equal(request.data.resetCodePreview,undefined);
    const code = await readMailboxCode(email);
    const reset = await e2eFetch('/api/auth/reset-password',{method:'POST',
      body:JSON.stringify({ email, code, newPassword:'LegacyQA123!' }) });
    assert.equal(reset.status,200);
    assert.equal(reset.data.user.email,email);
  });
});
