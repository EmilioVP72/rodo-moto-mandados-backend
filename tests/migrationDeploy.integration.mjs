import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { PrismaClient } from '@prisma/client';

const url = process.env.MIGRATION_TEST_URL;
const cli = createRequire(import.meta.url).resolve('prisma/build/index.js');
const migrations = readdirSync('prisma/migrations').filter(name => /^\d/.test(name)).sort();

test('despliega y conserva datos en bases vacías y las cuatro versiones de db push', { skip: !url, timeout: 240000 }, async () => {
  const target = new URL(url);
  assert.ok(['127.0.0.1','localhost'].includes(target.hostname), 'Usa PostgreSQL local de prueba.');
  const admin = new PrismaClient({ datasourceUrl: url });
  try {
    for (const prefix of [0, 1, 2, 3, 4, -1]) {
      const name = 'rodo_test_' + randomUUID().replaceAll('-', '');
      await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
      target.pathname = '/' + name;
      const db = new PrismaClient({ datasourceUrl: target.href });
      const env = { ...process.env, DATABASE_URL: target.href };
      const node = (...args) => execFileSync(process.execPath, args, { env, encoding: 'utf8', stdio: 'pipe' });
      try {
        if (prefix < 0) {
          await db.$executeRawUnsafe('CREATE TABLE unexpected_fixture (id integer)');
          assert.throws(() => node('prisma/deploy.mjs'), /Esquema desconocido/);
          const [result] = await db.$queryRaw`SELECT to_regclass('_prisma_migrations') IS NULL AS untouched`;
          assert.equal(result.untouched, true);
          continue;
        }
        for (const migration of migrations.slice(0, prefix)) {
          node(cli, 'db', 'execute', '--schema', 'prisma/schema.prisma', '--file', `prisma/migrations/${migration}/migration.sql`);
        }
        if (prefix) await db.$executeRaw`INSERT INTO settings (id,payload,"updatedAt") VALUES ('fixture','{"kept":1}'::jsonb,NOW())`;
        try { node('prisma/deploy.mjs'); } catch (error) {
          console.error('Prefijo', prefix, node(cli, 'migrate', 'diff', '--from-schema-datasource','prisma/schema.prisma','--to-schema-datamodel','prisma/adoption/schema.prisma','--script'));
          throw error;
        }
        node('prisma/deploy.mjs');
        node(cli, 'migrate', 'diff', '--from-schema-datasource','prisma/schema.prisma','--to-schema-datamodel','prisma/schema.prisma','--exit-code');
        const [result] = await db.$queryRaw`SELECT count(*)::int AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL`;
        assert.equal(result.n, migrations.length);
        if (prefix) assert.deepEqual((await db.setting.findUniqueOrThrow({where:{id:'fixture'}})).payload, { kept:1 });
      } finally {
        await db.$disconnect();
        await admin.$executeRawUnsafe(`DROP DATABASE "${name}"`);
      }
    }
  } finally { await admin.$disconnect(); }
});
