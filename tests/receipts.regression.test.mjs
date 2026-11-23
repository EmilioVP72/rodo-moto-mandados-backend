import test from 'node:test';
import assert from 'node:assert/strict';
import { dailyReceipts } from '../src/utils/dailyReceipts.ts';
test('el corte separa deuda y SPEI pendiente y usa el día local del cobro', () => {
  const now = new Date('2026-11-24T03:00:00Z');
  const row = { status:'nuevo', orderType:'comida', paymentMethod:'transferencia', paymentStatus:'pendiente',
    total:235, subtotal:200, commissionAmount:0, payload:{}, statusHistory:[] };
  const paid = { ...row, paymentStatus:'verificado', payload:{bankVerification:{verifiedAt:'2026-11-23T07:00:00Z'}} };
  const debt = { ...row, status:'cancelado_con_deuda', statusHistory:[{toStatus:'cancelado_con_deuda',createdAt:now}] };
  const cut = dailyReceipts([row,paid,debt],now);
  assert.equal(cut.totalVolume,235);
  assert.equal(cut.totalCommissions,0);
  assert.equal(cut.supplierTotal,200);
  assert.equal(cut.debtTotal,235);
  assert.equal(dailyReceipts([paid],new Date('2026-11-24T08:00Z')).count,0);
});
