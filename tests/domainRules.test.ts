import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyIneDigitsServer,
  getServerCustomerCashLimit,
  validateSpeiTrackingKeyFormat,
  recalculateOrderTotalsServer,
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

  describe('4. recalculateOrderTotalsServer (Blindaje Contra Manipulación de Precios en Cliente)', () => {
    const sampleCatalog = [
      { id: 'ts-1', price: 100 }, // Orden de 4 Tacos de Bistec ($100)
      { id: 'ts-4', price: 30 },  // Refresco 600ml ($30)
    ];

    it('ignora precios falsos enviados desde el navegador ($0 o $1) y recalcula con precios oficiales del catálogo', () => {
      const tamperedClientItems = [
        { id: 'ts-1', price: 0, quantity: 2, unitExtraPrice: 15 }, // Cliente intenta mandar $0, pero en catálogo cuesta $100 + $15 extra = $115 x 2 = $230
        { id: 'ts-4', price: 1, quantity: 1 },                     // Cliente intenta mandar $1, pero en catálogo cuesta $30 x 1 = $30
      ];

      const result = recalculateOrderTotalsServer({
        items: tamperedClientItems,
        catalogMenu: sampleCatalog,
        deliveryFee: 35,
        tipAmount: 20,
        promoDiscountApplied: 0,
      });

      assert.equal(result.verifiedSubtotal, 260); // $230 + $30
      assert.equal(result.calculatedTotal, 315);  // $260 + $35 envío + $20 propina
    });

    it('aplica descuentos promocionales correctamente sin permitir totales negativos', () => {
      const items = [{ id: 'ts-4', price: 30, quantity: 1 }];
      const result = recalculateOrderTotalsServer({
        items,
        catalogMenu: sampleCatalog,
        deliveryFee: 35,
        tipAmount: 0,
        promoDiscountApplied: 500, // Descuento mayor al subtotal + envío
      });

      assert.equal(result.verifiedSubtotal, 30);
      assert.equal(result.calculatedTotal, 0);
    });

    it('respeta cotizaciones personalizadas o auxilio de gasolina cuando isCustomOrSpecialOrder es true', () => {
      const result = recalculateOrderTotalsServer({
        items: [],
        deliveryFee: 50,
        isCustomOrSpecialOrder: true,
        fallbackSubtotal: 49,
        fallbackTotal: 99,
      });

      assert.equal(result.verifiedSubtotal, 49);
      assert.equal(result.calculatedTotal, 99);
    });
  });
});
