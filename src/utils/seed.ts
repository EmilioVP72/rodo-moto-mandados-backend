import bcrypt from 'bcryptjs';
import { prisma } from '../infra/prisma.js';
import { env } from '../config/env.js';
import {
  isEncryptedIne,
  prepareIneForStorage,
  encryptIneDigits,
  normalizeIneDigits,
} from './ineCrypto.js';

/**
 * Migra automáticamente cualquier INE que haya quedado en texto plano (legado)
 * a formato cifrado AES-256-GCM + índice ciego HMAC-SHA256 en PostgreSQL.
 */
async function migrateLegacyPlaintextIneRecords(): Promise<void> {
  const usersWithIne = await prisma.user.findMany({
    where: { ine10Digits: { not: null } },
    select: { id: true, ine10Digits: true, ine10DigitsHash: true },
  });

  let migratedUsers = 0;
  for (const u of usersWithIne) {
    if (!u.ine10Digits) continue;
    const needsEncryption = !isEncryptedIne(u.ine10Digits);
    const needsHash = !u.ine10DigitsHash;
    if (!needsEncryption && !needsHash) continue;

    const prepared = prepareIneForStorage(u.ine10Digits);
    if (!prepared) continue;

    await prisma.user.update({
      where: { id: u.id },
      data: {
        ine10Digits: needsEncryption ? prepared.encrypted : u.ine10Digits,
        ine10DigitsHash: prepared.hash,
      },
    });
    migratedUsers++;
  }

  const recoveriesWithIne = await prisma.accountRecoveryRequest.findMany({
    where: { ine10Digits: { not: null } },
    select: { id: true, ine10Digits: true },
  });

  let migratedRecoveries = 0;
  for (const r of recoveriesWithIne) {
    if (!r.ine10Digits || isEncryptedIne(r.ine10Digits)) continue;
    const clean = normalizeIneDigits(r.ine10Digits);
    if (!clean) continue;

    await prisma.accountRecoveryRequest.update({
      where: { id: r.id },
      data: { ine10Digits: encryptIneDigits(clean) },
    });
    migratedRecoveries++;
  }

  if (migratedUsers > 0 || migratedRecoveries > 0) {
    console.log(
      `[Security] Migrated legacy plaintext INE records to AES-256-GCM (users: ${migratedUsers}, recovery: ${migratedRecoveries})`
    );
  }
}

/**
 * Inicialización limpia de producción:
 * - Garantiza únicamente la cuenta maestra de Administrador definida en .env
 * - Cifra cualquier INE legado en texto plano que exista en la BD
 */
export async function runInitialDatabaseSeed(): Promise<void> {
  try {
    const adminEmail = env.ADMIN_EMAIL.trim().toLowerCase();
    const existingAdmin = await prisma.user.findUnique({ where: { email: adminEmail } });
    if (!existingAdmin) {
      const passwordHash = await bcrypt.hash(env.ADMIN_INITIAL_PASSWORD, 12);
      await prisma.user.create({
        data: {
          id: 'admin-master-rodo',
          name: 'Administrador Central RODO',
          phone: '4151019920',
          email: adminEmail,
          passwordHash,
          role: 'ADMIN',
          ineVerified: true,
          status: 'activo',
        },
      });
      console.log(`[Seed] Master Admin account initialized (${adminEmail})`);
    }

    await migrateLegacyPlaintextIneRecords();
  } catch (err) {
    console.error('[Seed] Warning during initial database seed:', err);
  }
}
