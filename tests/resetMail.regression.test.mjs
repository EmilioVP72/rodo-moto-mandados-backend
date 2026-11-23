import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryMessage, recoveryReceipt, resetMailTransport } from '../src/infra/resetMail.ts';

test('el código solo forma parte del mensaje dirigido al buzón', () => {
  const message = recoveryMessage('destino@example.test', '123456', 'rodo@example.test');
  assert.equal(message.to, 'destino@example.test');
  assert.match(message.text, /123456/);
  assert.deepEqual(Object.keys(recoveryReceipt).sort(), ['message', 'ok']);
  assert.equal(resetMailTransport({}), null);
  assert.equal(resetMailTransport({ SMTP_HOST: 'localhost', SMTP_FROM: message.from }).options.requireTLS, true);
});
