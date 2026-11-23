import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PrismaClient } from '@prisma/client';
import { appliedLegacyMigrations } from './adoption/plan.mjs';

const require = createRequire(import.meta.url);
const cli = require.resolve('prisma/build/index.js');
const db = new PrismaClient();
function migrate(args, capture = false) {
  return execFileSync(process.execPath, [cli, 'migrate', ...args], {
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8',
  });
}

try {
  // Serialize adoption across replicas. Prisma uses a separate lock for deploy.
  await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(127824851, 730531)`;
    const [schema] = await tx.$queryRaw`
      SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema()
        AND table_name = '_prisma_migrations') AS tracked,
        EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relkind IN ('r','v','m','S','p')) AS populated
    `;
    if (!schema.tracked && schema.populated) {
      const diff = migrate(['diff', '--from-schema-datasource', 'prisma/schema.prisma',
        '--to-schema-datamodel', 'prisma/adoption/schema.prisma', '--script'], true);
      const known = JSON.parse(readFileSync(new URL('./adoption/known-schemas.json', import.meta.url), 'utf8'));
      const applied = appliedLegacyMigrations(diff, known);
      for (const name of applied) migrate(['resolve', '--applied', name]);
    }
    migrate(['deploy']);
  }, { timeout: 300000 });
} finally {
  await db.$disconnect();
}
