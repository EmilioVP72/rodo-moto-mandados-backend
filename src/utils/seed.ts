import bcrypt from 'bcryptjs';
import { prisma } from '../infra/prisma.js';
import { env } from '../config/env.js';

/**
 * Inicialización limpia de producción:
 * Garantiza únicamente la cuenta maestra de Administrador definida en .env
 * (ADMIN_EMAIL / ADMIN_INITIAL_PASSWORD), sin inyectar clientes falsos ni cuentas demo.
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
  } catch (err) {
    console.error('[Seed] Warning during initial database seed:', err);
  }
}
