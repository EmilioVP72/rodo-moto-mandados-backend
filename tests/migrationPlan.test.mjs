import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { appliedLegacyMigrations } from '../prisma/adoption/plan.mjs';
const history = JSON.parse(readFileSync(new URL('../prisma/adoption/known-schemas.json', import.meta.url)));
test('solo registra el prefijo existente de un esquema conocido', () => {
  history.forEach((version, i) => assert.deepEqual(appliedLegacyMigrations(version.remainingSql, history), history.slice(0,i+1).map(v => v.migration)));
});
test('detiene la adopción si hay diferencias inesperadas', () => {
  assert.throws(() => appliedLegacyMigrations('ALTER TABLE orders DROP COLUMN total;', history), /Esquema desconocido/);
});
