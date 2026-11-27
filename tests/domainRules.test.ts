import { riderRegistration, riderChanges } from '../src/modules/riders/validation.ts';
import { parseImage, mayAccessOrderEvidence, isOrderFolder } from '../src/utils/evidence.ts';
import { priceFoodOrder, priceFuelRequest, matchesDisplayedQuote, initialOrderPayment } from '../src/utils/orderPricing.ts';
import {
  canAdvanceRestaurantTrackingStatus,
  createRiderTicketToken,
  isRestaurantTicketOrder,
  verifyRiderTicketToken,
} from '../src/utils/riderTicketToken.ts';
import {
  createAdminStepUpToken,
  verifyAdminStepUpToken,
} from '../src/utils/adminStepUp.ts';
import {
  REFRESH_COOKIE_NAME,
  parseCookieValue,
  isSecureCookieRequest,
  buildRefreshTokenCookieHeader,
  buildClearRefreshTokenCookieHeader,
} from '../src/utils/refreshCookie.ts';
import {
  isSafeHttpOrUploadUrl,
  validateDispatchSettingsPayload,
  validateRestaurantPayload,
  validatePartnerLocalPayload,
} from '../src/utils/inputSanitizer.ts';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyIneDigitsServer,
  getServerCustomerCashLimit,
  validateSpeiTrackingKeyFormat,
  validateGpsCoordinates,
  getRiderGpsPing,
  canRiderTransitionOrderStatus, allowedOrderTransitions,
} from '../src/utils/domainRules.ts';

describe('Backend Domain Rules & Security Unit Tests', () => {
  describe('1. verifyIneDigitsServer (Validación Antifraude INE 10 Dígitos)', () => {
    it('rechaza números con menos o más de 10 dígitos', () => {
      assert.equal(verifyIneDigitsServer('12345').valid, false);
      assert.equal(verifyIneDigitsServer('123456789012').valid, false);
    });

    it('rechaza secuencias triviales o repetitivas (0000000000, 1234567890, 9876543210)', () => {
      assert.equal(verifyIneDigitsServer('0000000000').valid, false);
      assert.equal(verifyIneDigitsServer('9999999999').valid, false);
      assert.equal(verifyIneDigitsServer('1234567890').valid, false);
      assert.equal(verifyIneDigitsServer('0123456789').valid, false);
      assert.equal(verifyIneDigitsServer('9876543210').valid, false);
    });

    it('rechaza patrones de baja entropía con menos de 3 dígitos distintos (ej. 1212121212)', () => {
      const res = verifyIneDigitsServer('1212121212');
      assert.equal(res.valid, false);
    });

    it('rechaza dígitos verificadores matemáticamente incorrectos según estándar OACI 9303 / INE', () => {
      // Para '894210543', el dígito verificador OACI 7-3-1 es 4 (y Luhn es 2). Con '9' al final debe fallar:
      const invalidChecksum = verifyIneDigitsServer('8942105439');
      assert.equal(invalidChecksum.valid, false);
    });

    it('acepta credenciales INE válidas de 10 dígitos con dígito verificador oficial y limpia guiones', () => {
      assert.equal(verifyIneDigitsServer('8942105434').valid, true);
      assert.equal(verifyIneDigitsServer('8942-1054-38').valid, true);
      assert.equal(verifyIneDigitsServer('5512349872').valid, true);
    });
  });

  describe('2. getServerCustomerCashLimit (Política Escalonada de Límite en Efectivo)', () => {
    it('asigna $300 MXN al primer pedido (0 órdenes previas entregadas)', () => {
      assert.equal(getServerCustomerCashLimit(0), 300);
      assert.equal(getServerCustomerCashLimit(-1), 300);
    });

    it('asigna $400 MXN al segundo pedido (1 orden previa entregada)', () => {
      assert.equal(getServerCustomerCashLimit(1), 400);
    });

    it('asigna $500 MXN al tercer pedido (2 órdenes previas entregadas)', () => {
      assert.equal(getServerCustomerCashLimit(2), 500);
    });

    it('asigna $1,000 MXN a clientes frecuentes (3 o más órdenes entregadas)', () => {
      assert.equal(getServerCustomerCashLimit(3), 1000);
      assert.equal(getServerCustomerCashLimit(15), 1000);
    });
  });

  describe('3. validateSpeiTrackingKeyFormat (Verificación de Claves de Rastreo SPEI)', () => {
    it('rechaza claves vacías, menores a 6 caracteres o con caracteres especiales inválidos', () => {
      assert.equal(validateSpeiTrackingKeyFormat('').valid, false);
      assert.equal(validateSpeiTrackingKeyFormat('AB12').valid, false);
      assert.equal(validateSpeiTrackingKeyFormat('SPEI$%#12345').valid, false);
    });

    it('bloquea patrones de fraude comunes o claves de prueba (123456, 000000, PRUEBA, AAAAAAA)', () => {
      assert.equal(validateSpeiTrackingKeyFormat('123456').valid, false);
      assert.equal(validateSpeiTrackingKeyFormat('000000').valid, false);
      assert.equal(validateSpeiTrackingKeyFormat('11111111').valid, false);
      assert.equal(validateSpeiTrackingKeyFormat('PRUEBA').valid, false);
      assert.equal(validateSpeiTrackingKeyFormat('TEST00').valid, false);
      assert.equal(validateSpeiTrackingKeyFormat('AAAAAAA').valid, false);
    });

    it('acepta y normaliza claves de rastreo SPEI reales interbancarias', () => {
      const res = validateSpeiTrackingKeyFormat('  bbva20261118994821  ');
      assert.equal(res.valid, true);
      assert.equal(res.cleanKey, 'BBVA20261118994821');
    });
  });

  describe('5. validateGpsCoordinates (Validación de Coordenadas GPS en Vivo del Repartidor)', () => {
    it('rechaza valores nulos, vacíos, NaN o fuera del globo terráqueo (-90..90, -180..180)', () => {
      assert.equal(validateGpsCoordinates(null, -100.74).valid, false);
      assert.equal(validateGpsCoordinates('', '').valid, false);
      assert.equal(validateGpsCoordinates('abc', -100.74).valid, false);
      assert.equal(validateGpsCoordinates(95.5, -100.74).valid, false);
      assert.equal(validateGpsCoordinates(20.91, -195.0).valid, false);
    });

    it('valida coordenadas dentro de San Miguel de Allende y marca isWithinSmaRegion = true', () => {
      const check = validateGpsCoordinates(20.91441234, -100.74371234);
      assert.equal(check.valid, true);
      assert.equal(check.isWithinSmaRegion, true);
      assert.equal(check.lat, 20.914412);
      assert.equal(check.lng, -100.743712);
    });

    it('valida coordenadas válidas fuera de la región pero marca isWithinSmaRegion = false', () => {
      const check = validateGpsCoordinates(19.4326, -99.1332); // CDMX
      assert.equal(check.valid, true);
      assert.equal(check.isWithinSmaRegion, false);
    });
  });

  describe('6. Rider order status transitions', () => {
    it('permits only the assigned rider delivery progression', () => {
      assert.equal(canRiderTransitionOrderStatus('asignado', 'recolectado'), true);
      assert.equal(canRiderTransitionOrderStatus('recolectado', 'en_camino'), true);
      assert.equal(canRiderTransitionOrderStatus('en_camino', 'afuera_del_domicilio'), true);
      assert.equal(canRiderTransitionOrderStatus('afuera_del_domicilio', 'entregado'), true);
    });

    it('rejects skipped, reversed, and administrative transitions', () => {
      assert.equal(canRiderTransitionOrderStatus('asignado', 'entregado'), false);
      assert.equal(canRiderTransitionOrderStatus('en_camino', 'asignado'), false);
      assert.equal(canRiderTransitionOrderStatus('entregado', 'en_camino'), false);
      assert.equal(canRiderTransitionOrderStatus('nuevo', 'cancelado'), false);
    });
  });
});

describe('Autorización del GPS', () => {
  const rider = { role: 'RIDER', sub: 'moto', sid: 'session', exp: 2 };
  const point = { orderId: 'order', lat: 20.9, lng: -100.7 };
  it('exige rol, sesión y token vigente', () => {
    for (const user of [undefined, { ...rider, role: 'CUSTOMER' }, { ...rider, sid: '' }, { ...rider, exp: 1 }]) {
      assert.equal(getRiderGpsPing(user, point, 1000), null);
    }
  });
  it('vincula el emisor a su identidad autenticada y valida el pedido y las coordenadas', () => {
    assert.deepEqual(getRiderGpsPing(rider, point, 1000), { orderId: 'order', riderId: 'moto',
      sessionId: 'session', coordinates: { lat: 20.9, lng: -100.7 } });
    assert.equal(getRiderGpsPing(rider, { ...point, lat: [] }, 1000), null);
    assert.equal(getRiderGpsPing(rider, { ...point, orderId: '' }, 1000), null);
  });
});

describe('Precios y pagos de pedidos', () => {
  const catalog = { menu: [{ id: 't', name: 'Taco', price: 20, customizations: [{ id: 'q', name: 'Queso', type: 'extra', price: 5 }] }], deliveryFee: 35, commissionRate: 15, promoPercent: 0 };
  it('usa el catálogo para el producto personalizado y cobra el modificador una sola vez', () => {
    const items = [{ id: 't-1234567890123', quantity: 2, price: 1, unitExtraPrice: 50, selectedModifiers: [{ id: 'q', price: 0 }] }];
    const result = priceFoodOrder({ items, promoCode: 'ENVIOGRATIS' }, catalog);
    assert.equal(result.total, 50);
    assert.equal(result.items[0].price, 25);
    assert.equal(result.deliveryFee, 0);
  });
  it('rechaza artículos desconocidos, cantidades negativas y cupones inexistentes', () => {
    for (const items of [[{ id: 'otro', quantity: 1 }], [{ id: 't', quantity: -1 }]]) assert.throws(() => priceFoodOrder({ items }, catalog));
    assert.throws(() => priceFoodOrder({ items: [{ id: 't', quantity: 1 }], promoCode: 'inventado' }, catalog));
  });
  it('registra la referencia como pendiente hasta confirmación de despacho', () => {
    assert.equal(initialOrderPayment('transferencia','BBVA72819').bankVerification?.verified, false);
    assert.equal(initialOrderPayment('transferencia').paymentStatus, 'pendiente');
    assert.equal(initialOrderPayment('efectivo').paymentStatus, 'en_efectivo');
  });
});

it('cobra el combustible al precio configurado y deja el viaje para cotización de despacho', () => {
  assert.deepEqual(priceFuelRequest(2, 'premium', { premiumPricePerLiter: 27 }), {
    liters: 2, fuelType: 'premium', fuelPricePerLiter: 27, fuelTotal: 54, serviceTravelFee: 0,
  });
  assert.throws(() => priceFuelRequest(0, 'premium', {}));
});

describe('Transiciones autorizadas por rol', () => {
  const order = { status: 'nuevo', assignedRiderUserId: 'r1', paymentMethod: 'efectivo', paymentStatus: 'en_efectivo' };
  it('despacho asigna desde nuevo pero no puede saltar a entregado', () => {
    assert.ok(allowedOrderTransitions('ADMIN', order).includes('asignado'));
    assert.ok(allowedOrderTransitions('ADMIN', order).includes('afuera_del_domicilio'));
    assert.ok(allowedOrderTransitions('ADMIN', {...order, assignedRiderUserId: null, assignedRiderName: 'Moto 1'}).includes('asignado'));
    assert.ok(!allowedOrderTransitions('ADMIN', order).includes('entregado'));
    assert.ok(!allowedOrderTransitions('ADMIN', {...order, assignedRiderUserId: null}).includes('asignado'));
  });
  it('cliente acepta una cotización emitida pero nunca puede marcar completado ni cambiar estatus', () => {
    assert.deepEqual(allowedOrderTransitions('CUSTOMER', {...order, status:'pendiente_cotizacion'}), ['cancelado']);
    assert.ok(allowedOrderTransitions('CUSTOMER', {...order, status:'pendiente_cotizacion', quoteOffered:true}).includes('nuevo'));
    assert.deepEqual(allowedOrderTransitions('CUSTOMER', {...order, status:'afuera_del_domicilio'}), []);
    assert.deepEqual(allowedOrderTransitions('CUSTOMER', {...order, status:'en_camino'}), []);
    assert.deepEqual(allowedOrderTransitions('CUSTOMER', {...order, status:'asignado'}), []);
  });
  it('mantiene cerrados los estados finales y exige pago para repartir una transferencia', () => {
    for (const role of ['ADMIN','CUSTOMER','RIDER']) assert.deepEqual(allowedOrderTransitions(role, {...order, status:'entregado'}), []);
    assert.deepEqual(allowedOrderTransitions('RIDER', {...order, status:'asignado', paymentMethod:'transferencia', paymentStatus:'pendiente'}), []);
  });
});

describe('Evidencia de pedidos', () => {
  const order = { customerId: 'cliente', assignedRiderUserId: 'r1' };
  it('limita acceso a la orden propia, a despacho y al repartidor asignado', () => {
    assert.ok(mayAccessOrderEvidence({ role:'CUSTOMER', sub:'cliente' }, order, 'proofs'));
    assert.ok(mayAccessOrderEvidence({ role:'ADMIN', sub:'admin' }, order, 'transfers'));
    assert.ok(mayAccessOrderEvidence({ role:'RIDER', sub:'r1' }, order, 'signatures'));
    assert.ok(!mayAccessOrderEvidence({ role:'CUSTOMER', sub:'otro' }, order, 'proofs'));
    assert.ok(!mayAccessOrderEvidence({ role:'RIDER', sub:'r2' }, order, 'proofs'));
    assert.ok(!mayAccessOrderEvidence({ role:'RIDER', sub:'r1' }, order, 'transfers'));
    assert.ok(!isOrderFolder('recovery'));
  });
  it('valida el contenido, el tipo declarado y el tamaño del archivo', () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvE0AAAAASUVORK5CYII=';
    assert.ok(parseImage(png));
    assert.equal(parseImage(png.replace('png','jpeg')), null);
    assert.equal(parseImage('data:image/png;base64,SG9sYQ=='), null);
    assert.equal(parseImage('data:image/png;base64,' + 'A'.repeat(5600000)), null);
  });
});

it('acepta solo el importe y la versión de la cotización que vio el cliente', () => {
  assert.ok(matchesDisplayedQuote(89, 'v2', 89, 'v2'));
  assert.ok(!matchesDisplayedQuote(89, 'v2', 49, 'v1'));
  assert.ok(!matchesDisplayedQuote(89, 'v2', 89, 'v1'));
  assert.ok(matchesDisplayedQuote(89, undefined, 89, undefined));
});

it('valida altas y permite editar disponibilidad sin cambiar la contraseña del repartidor', () => {
  const input = { name: '  Moto Centro  ', phone: '+52 415 111 2233', email: '  MOTO@example.invalid ', password: 'Registro123' };
  const parsed = riderRegistration.parse(input);
  assert.equal(parsed.name, 'Moto Centro');
  assert.equal(parsed.email, 'moto@example.invalid');
  assert.equal(riderRegistration.safeParse({ ...input, phone: 'teléfono' }).success, false);
  assert.equal(riderChanges.parse({ available: false }).available, false);
  assert.equal(riderChanges.safeParse({}).success, false);
  assert.equal(riderChanges.safeParse({ role: 'ADMIN' }).success, false);
});

describe('Token exclusivo de repartidor y estatus de pedidos de restaurante', () => {
  const secret = 'test_rider_ticket_secret_key_2026';

  it('valida el token del repartidor asignado y lo invalida si se cambia de repartidor', () => {
    const tokenRider1 = createRiderTicketToken('ord-100', 'rider-1', secret);
    assert.ok(tokenRider1.length === 32);
    assert.equal(verifyRiderTicketToken('ord-100', 'rider-1', tokenRider1, secret), true);
    assert.equal(verifyRiderTicketToken('ord-100', 'rider-2', tokenRider1, secret), false);
    assert.equal(verifyRiderTicketToken('ord-101', 'rider-1', tokenRider1, secret), false);
    assert.equal(verifyRiderTicketToken('ord-100', 'rider-1', 'invalido', secret), false);
  });

  it('aplica el flujo de estatus solo a tickets de restaurantes y solo hacia adelante', () => {
    assert.equal(isRestaurantTicketOrder({ orderType: 'comida' }), true);
    assert.equal(isRestaurantTicketOrder({ orderType: 'pedido_personalizado' }), true);
    assert.equal(isRestaurantTicketOrder({ orderType: 'envio' }), false);
    assert.equal(isRestaurantTicketOrder({ orderType: 'solicitud_local' }), false);
    assert.equal(isRestaurantTicketOrder({ orderType: 'auxilio_gasolina' }), false);

    assert.equal(canAdvanceRestaurantTrackingStatus(null, 'asignado', 'recibido'), true);
    assert.equal(canAdvanceRestaurantTrackingStatus('recibido', 'asignado', 'en_cocina'), true);
    assert.equal(canAdvanceRestaurantTrackingStatus('en_cocina', 'en_preparacion', 'en_camino'), true);
    assert.equal(canAdvanceRestaurantTrackingStatus('en_camino', 'en_camino', 'completado'), true);
    assert.equal(canAdvanceRestaurantTrackingStatus('en_camino', 'en_camino', 'en_cocina'), false);
    assert.equal(canAdvanceRestaurantTrackingStatus('completado', 'entregado', 'completado'), false);
    assert.equal(canAdvanceRestaurantTrackingStatus('recibido', 'cancelado', 'en_cocina'), false);
  });

  it('valida el token de segundo factor administrativo (Step-Up OTP) en el servidor', () => {
    const secret = 'test_step_up_secret_key_2026_32_chars_min';
    const now = 1_700_000_000_000;
    const token = createAdminStepUpToken('admin-1', 'cancel_order_fraud', secret, 300_000, now);

    assert.equal(verifyAdminStepUpToken(token, 'admin-1', 'cancel_order_fraud', secret, now + 10_000), true);
    assert.equal(verifyAdminStepUpToken(token, 'otro-admin', 'cancel_order_fraud', secret, now + 10_000), false);
    assert.equal(verifyAdminStepUpToken(token, 'admin-1', 'block_customer', secret, now + 10_000), false);
    assert.equal(verifyAdminStepUpToken(token, 'admin-1', 'cancel_order_fraud', secret, now + 301_000), false);
    assert.equal(verifyAdminStepUpToken('token-falso.firma', 'admin-1', 'cancel_order_fraud', secret, now), false);
  });

  it('construye y lee cookies HttpOnly SameSite=Strict para rotación de Refresh Token', () => {
    const headerHttps = buildRefreshTokenCookieHeader('rt_secreto_1234567890123456', true);
    assert.ok(headerHttps.includes(`${REFRESH_COOKIE_NAME}=rt_secreto_1234567890123456`));
    assert.ok(headerHttps.includes('HttpOnly'));
    assert.ok(headerHttps.includes('SameSite=Strict'));
    assert.ok(headerHttps.includes('Path=/api/auth'));
    assert.ok(headerHttps.includes('Secure'));

    const headerHttp = buildRefreshTokenCookieHeader('rt_dev_1234567890123456', false);
    assert.ok(!headerHttp.includes('Secure'));
    assert.equal(
      parseCookieValue(`foo=1; ${REFRESH_COOKIE_NAME}=rt_dev_1234567890123456; bar=2`, REFRESH_COOKIE_NAME),
      'rt_dev_1234567890123456'
    );
    assert.ok(buildClearRefreshTokenCookieHeader(true).includes('Max-Age=0'));
    assert.equal(isSecureCookieRequest('http', 'https, http'), true);
    assert.equal(isSecureCookieRequest('http', undefined), false);
  });

  it('bloquea esquemas peligrosos (javascript:, data:text/html) y valida esquemas Zod en settings y catálogo', () => {
    assert.equal(isSafeHttpOrUploadUrl('https://maps.google.com/?q=20.91,-100.74'), true);
    assert.equal(isSafeHttpOrUploadUrl('/uploads/restaurants/foto.webp'), true);
    assert.equal(isSafeHttpOrUploadUrl('/assets/logo.png'), true);
    assert.equal(isSafeHttpOrUploadUrl(''), true);
    assert.equal(isSafeHttpOrUploadUrl('javascript:alert(document.cookie)'), false);
    assert.equal(isSafeHttpOrUploadUrl('data:text/html;base64,PHNjcmlwdD4='), false);
    assert.equal(isSafeHttpOrUploadUrl('data:image/svg+xml;base64,PHN2Zz4='), false);
    assert.equal(isSafeHttpOrUploadUrl('/uploads/../etc/passwd'), false);
    assert.equal(isSafeHttpOrUploadUrl('//evil.example/payload.js'), false);

    const okSettings = validateDispatchSettingsPayload({
      rainPauseEnabled: true,
      baseDeliveryTariff: 40,
      adminPasscode: 'intento_inyeccion',
      campoDesconocido: 'se_descarta',
    });
    assert.equal(okSettings.success, true);
    if (okSettings.success) {
      assert.equal(okSettings.data.rainPauseEnabled, true);
      assert.equal(okSettings.data.adminPasscode, undefined);
      assert.equal(okSettings.data.campoDesconocido, undefined);
    }

    const badSettings = validateDispatchSettingsPayload({ baseDeliveryTariff: -50 });
    assert.equal(badSettings.success, false);

    const badRestaurant = validateRestaurantPayload({
      name: 'Local Prueba',
      mapsUrl: 'javascript:alert(1)',
    });
    assert.equal(badRestaurant.success, false);

    const okRestaurant = validateRestaurantPayload({
      name: 'Tacos Centro',
      establishmentType: 'restaurante',
      category: 'Tacos',
      deliveryFee: 35,
      commissionRate: 15,
      mapsUrl: 'https://maps.app.goo.gl/ejemplo',
      image: '/uploads/restaurants/tacos.jpg',
      menu: [{ id: 'm1', name: 'Orden Pastor', description: '5 tacos', price: 85 }],
    });
    assert.equal(okRestaurant.success, true);

    const badLocal = validatePartnerLocalPayload({ name: 'Local X', code: 'abc' });
    assert.equal(badLocal.success, false);

    // Fotos Base64 grandes (> 4 KB, ej. subidas desde dispositivo en AdminPanel), campos nulos y especificaciones sin límite
    const largeBase64Photo = 'data:image/jpeg;base64,' + 'A'.repeat(60_000);
    const restWithSpecsAndBase64 = validateRestaurantPayload({
      id: 'rest-3lx8ez',
      name: 'Alitas y Comida China Express',
      establishmentType: 'restaurante',
      category: 'Alitas',
      deliveryFee: 35,
      commissionRate: 15,
      image: largeBase64Photo,
      mapsUrl: 'maps.app.goo.gl/ejemploRuta',
      closureReason: null,
      bankDetails: null,
      customServiceHours: { open: '09:00:00', close: '21:00:00', enabled: false },
      workingDays: [],
      menu: [
        {
          id: 'item-alitas',
          name: 'Alitas Grandes',
          description: null,
          price: 165,
          image: largeBase64Photo,
          optionGroups: [
            {
              id: 'grp-salsas',
              name: 'Salsas a elegir',
              required: true,
              hasLimit: false,
              minSelect: 1,
              maxSelect: 0,
              options: ['BBQ', 'Buffalo', 'Mango Habanero'],
            },
          ],
        },
      ],
    });
    assert.equal(restWithSpecsAndBase64.success, true);
  });

  it('valida especificaciones de platillos (optionGroups con o sin límite) en priceFoodOrder', () => {
    const customCatalog = {
      deliveryFee: 35,
      commissionRate: 15,
      promoPercent: 0,
      menu: [
        {
          id: 'china-2g',
          name: 'Paquete 2 Guisados Especial',
          price: 130,
          optionGroups: [
            { id: 'base', name: 'Base', required: true, hasLimit: true, minSelect: 1, maxSelect: 1, options: ['Arroz', 'Pasta'] },
            { id: 'guis', name: 'Guisados', required: true, hasLimit: true, minSelect: 2, maxSelect: 2, allowRepeat: true, options: ['Pollo Naranja', 'Res Brócoli'] },
          ],
        },
        {
          id: 'alitas-gde',
          name: 'Alitas Grandes 12 pzs',
          price: 165,
          optionGroups: [
            { id: 'salsas', name: 'Salsas', required: true, hasLimit: true, minSelect: 1, maxSelect: 2, options: ['BBQ', 'Buffalo', 'Mango Habanero'] },
          ],
        },
      ],
    };

    // Falla si se omiten las especificaciones obligatorias
    assert.throws(() =>
      priceFoodOrder({ items: [{ id: 'china-2g', quantity: 1 }] }, customCatalog)
    );

    // Pasa con 1 base + 2 porciones repetidas del mismo guisado (sin exigir comboDetails legado)
    const okChina = priceFoodOrder(
      {
        items: [
          {
            id: 'china-2g-1700000000000',
            quantity: 1,
            selectedOptionGroups: [
              { groupId: 'base', selections: [{ option: 'Pasta', quantity: 1 }] },
              { groupId: 'guis', selections: [{ option: 'Pollo Naranja', quantity: 2 }] },
            ],
          },
        ],
      },
      customCatalog
    );
    assert.equal(okChina.subtotal, 130);

    // Falla en alitas si envía 3 salsas cuando el límite máximo es 2
    assert.throws(() =>
      priceFoodOrder(
        {
          items: [
            {
              id: 'alitas-gde',
              quantity: 1,
              selectedOptionGroups: [
                {
                  groupId: 'salsas',
                  selections: [
                    { option: 'BBQ', quantity: 1 },
                    { option: 'Buffalo', quantity: 1 },
                    { option: 'Mango Habanero', quantity: 1 },
                  ],
                },
              ],
            },
          ],
        },
        customCatalog
      )
    );
  });
});
