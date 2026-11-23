import test from 'node:test';
import assert from 'node:assert/strict';
import { priceFoodOrder } from '../src/utils/orderPricing.ts';
test('el cupón personal descuenta productos por su importe sin absorber el envío', () => {
  const catalog = { menu:[{id:'a',name:'A',price:20}], deliveryFee:35, commissionRate:0, promoPercent:0,
    personalCoupon:{code:'AMIGO-QA',discount:35} };
  const input = { items:[{id:'a',quantity:1}], promoCode:'amigo-qa' };
  assert.equal(priceFoodOrder(input,catalog).total,35);
  assert.equal(priceFoodOrder({...input,items:[{id:'a',quantity:5}]},catalog).total,100);
  assert.throws(() => priceFoodOrder(input,{...catalog,personalCoupon:undefined}),/Cupón/);
});
