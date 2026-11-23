import { parseImage, mayAccessOrderEvidence, isOrderFolder } from '../src/utils/evidence.ts';
import { priceFoodOrder, priceFuelRequest, matchesDisplayedQuote, initialOrderPayment } from '../src/utils/orderPricing.ts';
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
    assert.ok(!allowedOrderTransitions('ADMIN', order).includes('entregado'));
    assert.ok(!allowedOrderTransitions('ADMIN', {...order, assignedRiderUserId: null}).includes('asignado'));
  });
  it('cliente acepta una cotización emitida y confirma entrega al llegar', () => {
    assert.deepEqual(allowedOrderTransitions('CUSTOMER', {...order, status:'pendiente_cotizacion'}), ['cancelado']);
    assert.ok(allowedOrderTransitions('CUSTOMER', {...order, status:'pendiente_cotizacion', quoteOffered:true}).includes('nuevo'));
    assert.deepEqual(allowedOrderTransitions('CUSTOMER', {...order, status:'afuera_del_domicilio'}), ['entregado']);
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
