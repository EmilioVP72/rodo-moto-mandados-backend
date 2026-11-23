import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  encryptIneDigits,
  decryptIneDigits,
  hashIneForLookup,
  maskIneDigits,
  prepareIneForStorage,
  isEncryptedIne,
} from '../src/utils/ineCrypto.ts';

const TEST_SECRET = 'test_ine_encryption_master_secret_key_2026_32bytes';

describe('INE Cryptographic Protection at Rest (AES-256-GCM + HMAC-SHA256 Blind Index)', () => {
  it('cifra los 10 dígitos en formato enc:v1 sin exponer el texto plano y con IV aleatorio', () => {
    const plain = '8942105434';
    const cipher1 = encryptIneDigits(plain, TEST_SECRET);
    const cipher2 = encryptIneDigits(plain, TEST_SECRET);

    assert.equal(isEncryptedIne(cipher1), true);
    assert.equal(cipher1.includes(plain), false);
    assert.equal(cipher1.includes('5434'), false);
    // Seguridad semántica: misma entrada produce textos cifrados distintos (IV aleatorio)
    assert.notEqual(cipher1, cipher2);

    assert.equal(decryptIneDigits(cipher1, TEST_SECRET), plain);
    assert.equal(decryptIneDigits(cipher2, TEST_SECRET), plain);
  });

  it('rechaza textos cifrados manipulados o descifrados con clave incorrecta (integridad GCM)', () => {
    const cipher = encryptIneDigits('5512349872', TEST_SECRET);
    const tampered = cipher.slice(0, -2) + (cipher.endsWith('AA') ? 'BB' : 'AA');

    assert.equal(decryptIneDigits(tampered, TEST_SECRET), null);
    assert.equal(decryptIneDigits(cipher, 'otra_clave_completamente_diferente_2026'), null);
  });

  it('genera índice ciego HMAC-SHA256 determinístico para unicidad y detección de adeudos', () => {
    const hash1 = hashIneForLookup('8942105434', TEST_SECRET);
    const hash2 = hashIneForLookup('8942-1054-34', TEST_SECRET);
    const hashOther = hashIneForLookup('5512349872', TEST_SECRET);

    assert.equal(hash1.length, 64);
    assert.equal(hash1, hash2);
    assert.notEqual(hash1, hashOther);
    assert.equal(hash1.includes('8942'), false);
  });

  it('enmascara correctamente dejando visibles solo los últimos 4 dígitos para API/UI', () => {
    const prepared = prepareIneForStorage('8942105434', TEST_SECRET);
    assert.ok(prepared);
    assert.equal(isEncryptedIne(prepared.encrypted), true);
    assert.equal(prepared.hash.length, 64);

    assert.equal(maskIneDigits(prepared.encrypted, TEST_SECRET), '******5434');
    // Compatibilidad con registros legados en texto plano
    assert.equal(maskIneDigits('8942105434', TEST_SECRET), '******5434');
    assert.equal(maskIneDigits(null, TEST_SECRET), undefined);
  });
});
