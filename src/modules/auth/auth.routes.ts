import { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../../infra/prisma.js';
import { env } from '../../config/env.js';
import { signAuthToken, optionalAuth, requireAuth } from '../../middlewares/auth.js';
import { broadcastEvent } from '../../infra/socket.js';

/**
 * Validación matemática del reverso de credencial INE (10 dígitos) en el servidor
 */
function verifyIneDigitsServer(digits: string): { valid: boolean; reason?: string } {
  const clean = digits.replace(/[^0-9]/g, '');
  if (clean.length !== 10) {
    return { valid: false, reason: 'El número del reverso del INE debe tener exactamente 10 dígitos.' };
  }
  if (/^(\d)\1{9}$/.test(clean) || clean === '1234567890' || clean === '0123456789') {
    return {
      valid: false,
      reason: 'Secuencia numérica inválida. Ingresa los 10 dígitos reales del reverso de tu INE.',
    };
  }
  return { valid: true };
}

function serializeUserAccount(user: any) {
  return {
    id: user.id,
    name: user.name,
    phone: user.phone,
    email: user.email,
    role: user.role,
    ineVerified: user.ineVerified,
    ineDigits: user.ine10Digits || undefined,
    ine10Digits: user.ine10Digits || undefined,
    inePhotoUploaded: user.inePhotoUploaded,
    ineVerifiedAt: user.ineVerifiedAt || undefined,
    pendingDebt: user.pendingDebt,
    debtReason: user.debtReason || undefined,
    debtOrderFolio: user.debtOrderFolio || undefined,
    debtDate: user.debtDate || undefined,
    status: user.status,
    fraudReason: user.fraudReason || undefined,
    blockedAt: user.blockedAt || undefined,
    completedOrdersCount: user.completedOrdersCount,
    referralCode: user.referralCode || undefined,
    referredByCode: user.referredByCode || undefined,
    referralRewardsCount: user.referralRewardsCount,
    coupons: Array.isArray(user.coupons) ? user.coupons : [],
    createdAt: user.createdAt instanceof Date ? user.createdAt.toISOString() : String(user.createdAt),
  };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // 1. INICIO DE SESIÓN (CLIENTES Y ADMINISTRADORES)
  app.post('/api/auth/login', async (request, reply) => {
    const schema = z.object({
      email: z.string().min(1),
      password: z.string().min(1),
    });

    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Ingresa tu correo y contraseña.' });
    }

    const cleanEmail = parsed.data.email.trim().toLowerCase();
    const cleanPass = parsed.data.password.trim();

    // Verificar si es login de Administrador contra la base de datos o configuración maestra
    const isMasterAdminAlias =
      cleanEmail === env.ADMIN_EMAIL.toLowerCase() ||
      cleanEmail === 'admin@rodo.com' ||
      cleanEmail === 'admin';

    if (isMasterAdminAlias) {
      const adminUser = await prisma.user.findUnique({
        where: { email: env.ADMIN_EMAIL.toLowerCase() },
      });

      const settingsDoc = await prisma.setting.findUnique({ where: { id: 'general' } });
      const configuredPasscode = (settingsDoc?.payload as any)?.adminPasscode || env.ADMIN_INITIAL_PASSWORD;

      let isAdminValid = false;
      if (adminUser?.passwordHash) {
        isAdminValid = await bcrypt.compare(cleanPass, adminUser.passwordHash);
      }
      if (!isAdminValid && (cleanPass === configuredPasscode || cleanPass === env.ADMIN_INITIAL_PASSWORD)) {
        isAdminValid = true;
      }

      if (!isAdminValid) {
        return reply.status(401).send({ error: 'Código o contraseña incorrecta para la cuenta de Administrador.' });
      }

      const token = signAuthToken({
        sub: adminUser?.id || 'admin-master',
        email: env.ADMIN_EMAIL.toLowerCase(),
        role: 'ADMIN',
        name: adminUser?.name || 'Administrador Central RODO',
        phone: adminUser?.phone || '4151019920',
      });

      return reply.send({
        token,
        isAdmin: true,
        user: adminUser ? serializeUserAccount(adminUser) : {
          id: 'admin-master',
          name: 'Administrador Central RODO',
          email: env.ADMIN_EMAIL.toLowerCase(),
          phone: '4151019920',
          role: 'ADMIN',
        },
      });
    }

    // Buscar cuenta de cliente en PostgreSQL (por correo o teléfono)
    let user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: cleanEmail },
          { phone: cleanEmail.replace(/[^0-9]/g, '') || '__no_match__' },
        ],
      },
    });

    // Si no existe aún como usuario pero tiene una solicitud de recuperación aprobada:
    if (!user) {
      const approvedRecovery = await prisma.accountRecoveryRequest.findFirst({
        where: {
          newEmail: cleanEmail,
          status: 'aprobada',
        },
      });

      if (approvedRecovery) {
        const passwordHash = await bcrypt.hash(cleanPass, 10);
        const cleanPhone = approvedRecovery.phone.replace(/[^0-9]/g, '');
        user = await prisma.user.create({
          data: {
            id: `cust-${cleanPhone || Date.now()}`,
            name: approvedRecovery.customerName,
            phone: approvedRecovery.phone,
            email: cleanEmail,
            passwordHash,
            role: 'CUSTOMER',
            ineVerified: true,
            ine10Digits: approvedRecovery.ine10Digits || '0000000000',
            inePhotoUploaded: true,
            ineVerifiedAt: approvedRecovery.reviewedAt || new Date().toISOString(),
            status: 'activo',
          },
        });
      }
    }

    if (!user) {
      return reply.status(404).send({
        error: 'No encontramos una cuenta registrada con ese correo. Por favor regístrate con tu INE (10 dígitos) o usa Recuperar Cuenta.',
      });
    }

    // Validar bloqueo por deuda o fraude
    if (user.status === 'bloqueado_fraude' || user.pendingDebt > 0) {
      return reply.status(403).send({
        error: `Acceso bloqueado: Esta cuenta (INE ****${(user.ine10Digits || '').slice(-4)}) registra un adeudo pendiente de $${user.pendingDebt.toFixed(2)} MXN. Liquida el saldo para reactivar tu servicio.`,
        blockedAccount: serializeUserAccount(user),
      });
    }

    // Si la cuenta tenía passwordHash, verificarlo; si era cuenta migrada sin hash, asignarle el hash actual
    if (user.passwordHash) {
      const validPass = await bcrypt.compare(cleanPass, user.passwordHash);
      if (!validPass) {
        return reply.status(401).send({
          error: 'Contraseña incorrecta. Si la olvidaste, haz clic en "¿Olvidaste tu contraseña? Recuperar cuenta".',
        });
      }
    } else {
      const newHash = await bcrypt.hash(cleanPass, 10);
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: newHash },
      });
    }

    const token = signAuthToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      phone: user.phone,
    });

    return reply.send({
      token,
      isAdmin: user.role === 'ADMIN',
      user: serializeUserAccount(user),
    });
  });

  // 2. REGISTRO DE CLIENTE CON VALIDACIÓN ANTIFRAUDE DE INE (10 DÍGITOS) EN BASE DE DATOS CENTRAL
  app.post('/api/auth/register', async (request, reply) => {
    const schema = z.object({
      name: z.string().min(2),
      phone: z.string().min(8),
      email: z.string().email(),
      password: z.string().min(4),
      ine10Digits: z.string().min(10),
      referralCodeInput: z.string().optional(),
    });

    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Completa todos los campos obligatorios (Nombre, Teléfono, Correo, Contraseña y 10 dígitos del INE).',
      });
    }

    const cleanEmail = parsed.data.email.trim().toLowerCase();
    const cleanPhone = parsed.data.phone.trim();
    const cleanDigits = parsed.data.ine10Digits.replace(/[^0-9]/g, '');

    const ineCheck = verifyIneDigitsServer(cleanDigits);
    if (!ineCheck.valid) {
      return reply.status(400).send({ error: ineCheck.reason });
    }

    // Verificar en PostgreSQL si ya existe una cuenta con ese INE o correo
    const existingByIne = await prisma.user.findFirst({
      where: { ine10Digits: cleanDigits },
    });

    if (existingByIne) {
      if (existingByIne.pendingDebt > 0 || existingByIne.status === 'bloqueado_fraude') {
        return reply.status(403).send({
          error: `⚠️ INE BLOQUEADO POR ADEUDO: La credencial terminación ${cleanDigits.slice(-4)} tiene un adeudo pendiente de $${existingByIne.pendingDebt.toFixed(2)} MXN (Folio ${existingByIne.debtOrderFolio || 'S/N'}). No es posible crear otra cuenta hasta liquidar el adeudo.`,
          blockedAccount: serializeUserAccount(existingByIne),
        });
      }

      if (existingByIne.email.toLowerCase() !== cleanEmail) {
        return reply.status(409).send({
          error: `⚠️ CREDENCIAL YA REGISTRADA: Estos 10 dígitos de INE ya están vinculados a otra cuenta activa (${existingByIne.email.slice(0, 3)}***). Solo se permite una cuenta por identificación oficial.`,
          blockedAccount: serializeUserAccount(existingByIne),
        });
      }
    }

    const existingByEmail = await prisma.user.findUnique({
      where: { email: cleanEmail },
    });

    if (existingByEmail) {
      if (existingByEmail.pendingDebt > 0 || existingByEmail.status === 'bloqueado_fraude') {
        return reply.status(403).send({
          error: `Esta cuenta registra un adeudo pendiente de $${existingByEmail.pendingDebt.toFixed(2)} MXN.`,
          blockedAccount: serializeUserAccount(existingByEmail),
        });
      }
    }

    const passwordHash = await bcrypt.hash(parsed.data.password.trim(), 10);
    const phoneDigits = cleanPhone.replace(/[^0-9]/g, '');
    const accountId = existingByEmail?.id || `cust-${phoneDigits || Date.now()}`;
    const referralSuffix = (phoneDigits.slice(-4) || Math.floor(1000 + Math.random() * 9000).toString());
    const myReferralCode = `RODO-${referralSuffix}`;

    const coupons: any[] = [];
    let referredByCode: string | undefined;

    // Procesar código de referido si fue ingresado
    if (parsed.data.referralCodeInput?.trim()) {
      const refCode = parsed.data.referralCodeInput.trim().toUpperCase();
      const referrer = await prisma.user.findFirst({
        where: { referralCode: refCode },
      });

      if (referrer && referrer.email !== cleanEmail && referrer.ine10Digits !== cleanDigits) {
        referredByCode = refCode;
        const welcomeCoupon = {
          id: `cpn-welcome-${Date.now()}`,
          code: `BIENVENIDA-${referralSuffix}`,
          discount: 35,
          label: '$35 MXN OFF por invitación de amigo',
          used: false,
          earnedAt: new Date().toISOString(),
          reason: `Invitado con código ${refCode}`,
        };
        coupons.push(welcomeCoupon);

        const referrerCoupons = Array.isArray(referrer.coupons) ? [...(referrer.coupons as any[])] : [];
        referrerCoupons.push({
          id: `cpn-ref-${Date.now()}`,
          code: `AMIGO-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
          discount: 35,
          label: `$35 MXN OFF por invitar a ${parsed.data.name.trim().split(' ')[0]}`,
          used: false,
          earnedAt: new Date().toISOString(),
          reason: `Referido verificado con INE`,
        });

        await prisma.user.update({
          where: { id: referrer.id },
          data: {
            referralRewardsCount: { increment: 1 },
            coupons: referrerCoupons,
          },
        });
      }
    }

    const createdUser = await prisma.user.upsert({
      where: { email: cleanEmail },
      update: {
        name: parsed.data.name.trim(),
        phone: cleanPhone,
        passwordHash,
        ineVerified: true,
        ine10Digits: cleanDigits,
        inePhotoUploaded: true,
        ineVerifiedAt: new Date().toISOString(),
      },
      create: {
        id: accountId,
        name: parsed.data.name.trim(),
        phone: cleanPhone,
        email: cleanEmail,
        passwordHash,
        role: 'CUSTOMER',
        ineVerified: true,
        ine10Digits: cleanDigits,
        inePhotoUploaded: true,
        ineVerifiedAt: new Date().toISOString(),
        pendingDebt: 0,
        status: 'activo',
        completedOrdersCount: 0,
        referralCode: myReferralCode,
        referredByCode,
        referralRewardsCount: 0,
        coupons,
      },
    });

    const token = signAuthToken({
      sub: createdUser.id,
      email: createdUser.email,
      role: createdUser.role,
      name: createdUser.name,
      phone: createdUser.phone,
    });

    broadcastEvent('accounts:updated', serializeUserAccount(createdUser));

    return reply.status(201).send({
      token,
      isAdmin: false,
      user: serializeUserAccount(createdUser),
    });
  });

  // 3. PERFIL DE SESIÓN ACTUAL
  app.get('/api/auth/me', { preHandler: [requireAuth] }, async (request, reply) => {
    const authUser = request.authUser!;
    const user = await prisma.user.findUnique({ where: { id: authUser.sub } });
    if (!user) {
      return reply.send({
        user: {
          id: authUser.sub,
          email: authUser.email,
          name: authUser.name,
          phone: authUser.phone || '',
          role: authUser.role,
        },
      });
    }
    return reply.send({ user: serializeUserAccount(user) });
  });

  // 4. GESTIÓN CENTRALIZADA DE CUENTAS INE, ADEUDOS Y BLOQUEOS ANTIFRAUDE
  app.get('/api/auth/accounts', { preHandler: [optionalAuth] }, async (_request, reply) => {
    const users = await prisma.user.findMany({
      where: { role: 'CUSTOMER' },
      orderBy: { updatedAt: 'desc' },
    });
    return reply.send(users.map(serializeUserAccount));
  });

  app.post('/api/auth/accounts', { preHandler: [optionalAuth] }, async (request, reply) => {
    const body = request.body as any;
    if (!body || !body.email) {
      return reply.status(400).send({ error: 'Datos de cuenta inválidos' });
    }
    const cleanEmail = String(body.email).trim().toLowerCase();
    const id = body.id || `cust-${Date.now()}`;

    const saved = await prisma.user.upsert({
      where: { email: cleanEmail },
      update: {
        name: body.name || 'Cliente RODO',
        phone: body.phone || '',
        ineVerified: Boolean(body.ineVerified ?? true),
        ine10Digits: body.ine10Digits || body.ineDigits || null,
        inePhotoUploaded: Boolean(body.inePhotoUploaded ?? true),
        pendingDebt: Number(body.pendingDebt ?? 0),
        debtReason: body.debtReason || null,
        debtOrderFolio: body.debtOrderFolio || null,
        debtDate: body.debtDate || null,
        status: body.status === 'bloqueado_fraude' ? 'bloqueado_fraude' : 'activo',
        fraudReason: body.fraudReason || null,
        blockedAt: body.blockedAt || null,
        completedOrdersCount: Number(body.completedOrdersCount ?? 0),
        referralCode: body.referralCode || null,
        referredByCode: body.referredByCode || null,
        referralRewardsCount: Number(body.referralRewardsCount ?? 0),
        coupons: Array.isArray(body.coupons) ? body.coupons : [],
      },
      create: {
        id,
        name: body.name || 'Cliente RODO',
        phone: body.phone || '',
        email: cleanEmail,
        role: 'CUSTOMER',
        ineVerified: Boolean(body.ineVerified ?? true),
        ine10Digits: body.ine10Digits || body.ineDigits || null,
        inePhotoUploaded: Boolean(body.inePhotoUploaded ?? true),
        pendingDebt: Number(body.pendingDebt ?? 0),
        debtReason: body.debtReason || null,
        debtOrderFolio: body.debtOrderFolio || null,
        debtDate: body.debtDate || null,
        status: body.status === 'bloqueado_fraude' ? 'bloqueado_fraude' : 'activo',
        fraudReason: body.fraudReason || null,
        blockedAt: body.blockedAt || null,
        completedOrdersCount: Number(body.completedOrdersCount ?? 0),
        referralCode: body.referralCode || null,
        referredByCode: body.referredByCode || null,
        referralRewardsCount: Number(body.referralRewardsCount ?? 0),
        coupons: Array.isArray(body.coupons) ? body.coupons : [],
      },
    });

    const serialized = serializeUserAccount(saved);
    broadcastEvent('accounts:updated', serialized);
    return reply.send(serialized);
  });

  // 5. SOLICITUDES DE RECUPERACIÓN DE CUENTA Y REVISIÓN DE SOPORTE
  app.get('/api/auth/recovery', async (request, reply) => {
    const { newEmail, status } = request.query as { newEmail?: string; status?: string };
    const whereClause: any = {};
    if (newEmail) whereClause.newEmail = newEmail.trim().toLowerCase();
    if (status) whereClause.status = status;

    const list = await prisma.accountRecoveryRequest.findMany({
      where: whereClause,
      orderBy: { storedAt: 'desc' },
      take: 100,
    });
    return reply.send(list);
  });

  app.post('/api/auth/recovery', async (request, reply) => {
    const body = request.body as any;
    if (!body?.id || !body?.folio || !body?.newEmail) {
      return reply.status(400).send({ error: 'Datos de solicitud incompletos.' });
    }

    const created = await prisma.accountRecoveryRequest.upsert({
      where: { id: body.id },
      update: {
        status: body.status || 'pendiente',
        adminNotes: body.adminNotes || null,
        reviewedBy: body.reviewedBy || null,
        reviewedAt: body.reviewedAt || null,
      },
      create: {
        id: body.id,
        folio: body.folio,
        customerName: body.customerName || 'Cliente',
        phone: body.phone || '',
        oldEmail: (body.oldEmail || '').trim().toLowerCase(),
        newEmail: (body.newEmail || '').trim().toLowerCase(),
        reason: body.reason || null,
        documentPhotoUrl: body.documentPhotoUrl || null,
        ine10Digits: body.ine10Digits || null,
        status: body.status || 'pendiente',
        createdAt: body.createdAt || new Date().toISOString(),
      },
    });

    broadcastEvent('recovery:updated', created);
    return reply.status(201).send(created);
  });

  app.patch('/api/auth/recovery/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      status: 'aprobada' | 'rechazada';
      adminNotes?: string;
      reviewedBy?: string;
    };

    const existing = await prisma.accountRecoveryRequest.findUnique({ where: { id } });
    if (!existing) {
      return reply.status(404).send({ error: 'Solicitud no encontrada.' });
    }

    const now = new Date().toISOString();
    const updated = await prisma.accountRecoveryRequest.update({
      where: { id },
      data: {
        status: body.status,
        adminNotes: body.adminNotes || '',
        reviewedBy: body.reviewedBy || env.ADMIN_EMAIL,
        reviewedAt: now,
      },
    });

    if (body.status === 'aprobada') {
      const cleanOld = existing.oldEmail.trim().toLowerCase();
      const cleanNew = existing.newEmail.trim().toLowerCase();
      const cleanPhone = existing.phone.replace(/[^0-9]/g, '');

      const matchedOld = await prisma.user.findFirst({
        where: {
          OR: [
            { email: cleanOld },
            { phone: { contains: cleanPhone || '__none__' } },
          ],
        },
      });

      const newDigits =
        (existing.ine10Digits && existing.ine10Digits.replace(/[^0-9]/g, '').length === 10
          ? existing.ine10Digits.replace(/[^0-9]/g, '')
          : matchedOld?.ine10Digits) || '0000000000';

      await prisma.user.upsert({
        where: { email: cleanNew },
        update: {
          name: existing.customerName || matchedOld?.name || 'Cliente RODO',
          phone: existing.phone || matchedOld?.phone || '',
          ineVerified: true,
          ine10Digits: newDigits,
          inePhotoUploaded: true,
          ineVerifiedAt: now,
          status: 'activo',
        },
        create: {
          id: `cust-${cleanPhone || Date.now()}`,
          name: existing.customerName || matchedOld?.name || 'Cliente RODO',
          phone: existing.phone || matchedOld?.phone || '',
          email: cleanNew,
          role: 'CUSTOMER',
          ineVerified: true,
          ine10Digits: newDigits,
          inePhotoUploaded: true,
          ineVerifiedAt: now,
          pendingDebt: matchedOld?.pendingDebt || 0,
          status: 'activo',
          completedOrdersCount: matchedOld?.completedOrdersCount || 0,
          referralCode: matchedOld?.referralCode || `RODO-${cleanPhone.slice(-4) || '2026'}`,
          referralRewardsCount: matchedOld?.referralRewardsCount || 0,
          coupons: matchedOld?.coupons || [],
        },
      });
    }

    broadcastEvent('recovery:updated', updated);
    return reply.send(updated);
  });
}
