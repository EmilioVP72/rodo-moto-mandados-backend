// Compare Prisma-generated SQL without changing any identifiers or literals.
// The engine can enumerate independent tables in a different order after introspection.
// Compare complete generated operations, without executing or rewriting their SQL.
function operations(sql) {
  return JSON.stringify(sql.replaceAll('\r\n', '\n').split(/^-- [^\n]*$/m)
    .map(block => block.trim()).filter(Boolean).sort());
}

export function appliedLegacyMigrations(diff, knownSchemas) {
  const index = knownSchemas.findIndex(entry => operations(entry.remainingSql) === operations(diff));
  if (index < 0) throw new Error('Esquema desconocido. Revisa las diferencias y prepara una migración antes de desplegar.');
  return knownSchemas.slice(0, index + 1).map(entry => entry.migration);
}
