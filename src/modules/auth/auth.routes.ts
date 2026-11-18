import { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../../infra/prisma.js';
import { env } from '../../config/env.js';
import {
  signAuthToken,
  requireAuth,
  requireAdmin,
  createUserRefreshSession,
  hashSecretSha256,
  timingSafeCompareHex,
  generateSixDigitResetCode,
  extractUserFromRequest,
} from '../../middlewares/auth.js';
import { emitAdminEvent } from '../../infra/socket.js';
import { verifyIneDigitsServer } from '../../utils/domainRules.js';

const BCRYPT_ROUNDS = 12;

function serializeUserAccount(user: any) {
  const couponsList = Array.isArray(user.coupons)
    ? user.coupons.map((c: any) => ({
        id: c.id,
        code: c.code,
        discount: c.discount,
        label: c.label,
        used: Boolean(c.used),
        earnedAt: c.earnedAt instanceof Date ? c.earnedAt.toISOString() : String(c.earnedAt),
        reason: c.reason,
      }))
    : [];

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
    ineVerifiedAt:
      user.ineVerifiedAt instanceof Date
        ? user.ineVerifiedAt.toISOString()
        : user.ineVerifiedAt || undefined,
    pendingDebt: user.pendingDebt,
    debtReason: user.debtReason || undefined,
    debtOrderFolio: user.debtOrderFolio || undefined,
    debtDate: user.debtDate || undefined,
    status: user.status,
    fraudReason: user.fraudReason || undefined,
    blockedAt:
      user.blockedAt instanceof Date ? user.blockedAt.toISOString() : user.blockedAt || undefined,
    completedOrdersCount: user.completedOrdersCount,
    referralCode: user.referralCode || undefined,
    referredByCode: user.referredByCode || undefined,
    referralRewardsCount: user.referralRewardsCount,
    coupons: couponsList,
    addresses: Array.isArray(user.addresses) ? user.addresses : undefined,
    favoriteRestaurantIds: Array.isArray(user.favorites)
      ? user.favorites.map((f: any) => f.restaurantId)
      : undefined,
    createdAt: user.createdAt instanceof Date ? user.createdAt.toISOString() : String(user.createdAt),
  };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // =========================================================================
  // 1. REGISTRO DE NUEVO USUARIO (CON TRANSACCIÓN RELACIONAL + SESIÓN)
  // =========================================================================
  app.post('/api/auth/register', async (request, reply) => {
    const schema = z.object({
      name: z.string().trim().min(2, 'Ingresa tu nombre completo.'),
      phone: z.string().trim().min(8, 'Ingresa un teléfono celular válido (10 dígitos).'),
      email: z.string().trim().email('Ingresa un correo electrónico válido.'),
      password: z.string().min(6, 'La contraseña debe tener al menos 6 caracteres.'),
      ine10Digits: z.string().min(10, 'Ingresa los 10 dígitos del reverso de tu INE.'),
      referralCodeInput: z.string().optional(),
    });

    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message || 'Datos de registro inválidos.';
      return reply.status(400).send({ error: firstIssue });
    }

    const cleanEmail = parsed.data.email.toLowerCase();
    const cleanPhone = parsed.data.phone;
    const cleanDigits = parsed.data.ine10Digits.replace(/[^0-9]/g, '');

    const ineCheck = verifyIneDigitsServer(cleanDigits);
    if (!ineCheck.valid) {
      return reply.status(400).send({ error: ineCheck.reason });
    }

    // Verificar INE duplicado o con adeudo en PostgreSQL
    const existingByIne = await prisma.user.findUnique({
      where: { ine10Digits: cleanDigits },
      include: { coupons: true },
    });

    if (existingByIne) {
      if (existingByIne.pendingDebt > 0 || existingByIne.status === 'bloqueado_fraude') {
        return reply.status(403).send({
          error: `⚠️ INE BLOQUEADO POR ADEUDO: La credencial terminación ${cleanDigits.slice(-4)} tiene un adeudo pendiente de $${existingByIne.pendingDebt.toFixed(2)} MXN (Folio ${existingByIne.debtOrderFolio || 'S/N'}).`,
          blockedAccount: serializeUserAccount(existingByIne),
        });
      }

      return reply.status(409).send({
        error: `⚠️ CREDENCIAL YA REGISTRADA: Estos 10 dígitos de INE ya están vinculados a otra cuenta activa (${existingByIne.email.slice(0, 3)}***). Inicia sesión o recupera tu contraseña.`,
        blockedAccount: serializeUserAccount(existingByIne),
      });
    }

    // Verificar correo duplicado en PostgreSQL
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
      return reply.status(409).send({
        error: 'Este correo electrónico ya está registrado. Inicia sesión o usa "Recuperar contraseña".',
      });
    }

    const passwordHash = await bcrypt.hash(parsed.data.password, BCRYPT_ROUNDS);
    const phoneDigits = cleanPhone.replace(/[^0-9]/g, '');
    const accountId = `cust-${phoneDigits}-${Date.now().toString(36).slice(-4)}`;
    const uniqueRefSuffix = `${phoneDigits.slice(-4) || '2026'}${Math.random().toString(36).substring(2, 4).toUpperCase()}`;
    const myReferralCode = `RODO-${uniqueRefSuffix}`;

    // Ejecutar creación de usuario + cupones de referido de forma atómica en PostgreSQL
    const createdUser = await prisma.$transaction(async (tx) => {
      let referredByCode: string | null = null;
      let referrerId: string | null = null;

      if (parsed.data.referralCodeInput?.trim()) {
        const refCode = parsed.data.referralCodeInput.trim().toUpperCase();
        const referrer = await tx.user.findUnique({
          where: { referralCode: refCode },
        });
        if (referrer && referrer.email !== cleanEmail && referrer.ine10Digits !== cleanDigits) {
          referredByCode = refCode;
          referrerId = referrer.id;
        }
      }

      const newUser = await tx.user.create({
        data: {
          id: accountId,
          name: parsed.data.name,
          phone: cleanPhone,
          email: cleanEmail,
          passwordHash,
          role: 'CUSTOMER',
          ineVerified: true,
          ine10Digits: cleanDigits,
          inePhotoUploaded: true,
          ineVerifiedAt: new Date(),
          pendingDebt: 0,
          status: 'activo',
          completedOrdersCount: 0,
          referralCode: myReferralCode,
          referredByCode,
          referralRewardsCount: 0,
        },
      });

      if (referrerId && referredByCode) {
        await tx.coupon.create({
          data: {
            userId: newUser.id,
            code: `BIENVENIDA-${uniqueRefSuffix}`,
            discount: 35,
            label: '$35 MXN OFF por invitación de amigo',
            reason: `Invitado con código ${referredByCode}`,
          },
        });

        await tx.coupon.create({
          data: {
            userId: referrerId,
            code: `AMIGO-${Math.random().toString(36).substring(2, 7).toUpperCase()}`,
            discount: 35,
            label: `$35 MXN OFF por invitar a ${parsed.data.name.split(' ')[0]}`,
            reason: 'Referido verificado con INE',
          },
        });

        await tx.user.update({
          where: { id: referrerId },
          data: { referralRewardsCount: { increment: 1 } },
        });
      }

      return tx.user.findUniqueOrThrow({
        where: { id: newUser.id },
        include: { coupons: true, addresses: true, favorites: true },
      });
    });

    const session = await createUserRefreshSession({
      userId: createdUser.id,
      userAgent: request.headers['user-agent'],
      ipAddress: request.ip,
    });

    const token = signAuthToken({
      sub: createdUser.id,
      email: createdUser.email,
      role: createdUser.role,
      name: createdUser.name,
      phone: createdUser.phone,
      sid: session.sessionId,
    });

    const serialized = serializeUserAccount(createdUser);
    emitAdminEvent('accounts:updated', serialized);

    return reply.status(201).send({
      token,
      refreshToken: session.refreshToken,
      isAdmin: false,
      user: serialized,
    });
  });

  // =========================================================================
  // 2. INICIO DE SESIÓN CON CREDENCIALES REALES (BCRYPT + REFRESH SESSION)
  // =========================================================================
  app.post('/api/auth/login', async (request, reply) => {
    const schema = z.object({
      email: z.string().trim().min(1),
      password: z.string().min(1),
    });

    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Ingresa tu correo y contraseña.' });
    }

    const cleanIdentifier = parsed.data.email.toLowerCase();
    const cleanPass = parsed.data.password;

    const isAdminAlias =
      cleanIdentifier === env.ADMIN_EMAIL.toLowerCase() ||
      cleanIdentifier === 'admin@rodo.com' ||
      cleanIdentifier === 'admin';

    const lookupEmail = isAdminAlias ? env.ADMIN_EMAIL.toLowerCase() : cleanIdentifier;
    const phoneDigits = cleanIdentifier.replace(/[^0-9]/g, '');

    let user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: lookupEmail },
          ...(phoneDigits.length >= 8 ? [{ phone: phoneDigits }] : []),
        ],
      },
      include: { coupons: true, addresses: true, favorites: true },
    });

    // Migración automática si el soporte aprobó una solicitud de cambio de correo
    if (!user && !isAdminAlias) {
      const approvedRecovery = await prisma.accountRecoveryRequest.findFirst({
        where: { newEmail: lookupEmail, status: 'aprobada' },
      });

      if (approvedRecovery) {
        const passwordHash = await bcrypt.hash(cleanPass, BCRYPT_ROUNDS);
        const recPhone = approvedRecovery.phone.replace(/[^0-9]/g, '');
        user = await prisma.user.create({
          data: {
            id: `cust-${recPhone || Date.now()}`,
            name: approvedRecovery.customerName,
            phone: approvedRecovery.phone,
            email: lookupEmail,
            passwordHash,
            role: 'CUSTOMER',
            ineVerified: true,
            ine10Digits: approvedRecovery.ine10Digits || null,
            inePhotoUploaded: true,
            ineVerifiedAt: new Date(),
            status: 'activo',
          },
          include: { coupons: true, addresses: true, favorites: true },
        });
      }
    }

    if (!user) {
      return reply.status(401).send({
        error: 'Correo o contraseña incorrectos.',
      });
    }

    // Verificar bloqueo por deuda o fraude (solo para clientes)
    if (user.role !== 'ADMIN' && (user.status === 'bloqueado_fraude' || user.pendingDebt > 0)) {
      return reply.status(403).send({
        error: `Acceso bloqueado: Esta cuenta (INE ****${(user.ine10Digits || '').slice(-4)}) registra un adeudo pendiente de $${user.pendingDebt.toFixed(2)} MXN. Liquida el saldo para reactivar tu servicio.`,
        blockedAccount: serializeUserAccount(user),
      });
    }

    // Verificación criptográfica de contraseña (bcrypt)
    let isPasswordValid = await bcrypt.compare(cleanPass, user.passwordHash);

    // Para el administrador, permitir también el passcode configurado en Setting.adminPasscode
    if (!isPasswordValid && user.role === 'ADMIN') {
      const settingsDoc = await prisma.setting.findUnique({ where: { id: 'general' } });
      const configuredPasscode = (settingsDoc?.payload as any)?.adminPasscode;
      if (configuredPasscode && cleanPass === String(configuredPasscode)) {
        isPasswordValid = true;
      }
    }

    if (!isPasswordValid) {
      return reply.status(401).send({
        error: 'Correo o contraseña incorrectos. Si olvidaste tu contraseña, usa "Recuperar contraseña".',
      });
    }

    const session = await createUserRefreshSession({
      userId: user.id,
      userAgent: request.headers['user-agent'],
      ipAddress: request.ip,
    });

    const token = signAuthToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      phone: user.phone,
      sid: session.sessionId,
    });

    return reply.send({
      token,
      refreshToken: session.refreshToken,
      isAdmin: user.role === 'ADMIN',
      user: serializeUserAccount(user),
    });
  });

  // =========================================================================
  // 3. RENOVACIÓN DE SESIÓN (REFRESH TOKEN ROTATION) Y LOGOUT CON REVOCACIÓN
  // =========================================================================
  app.post('/api/auth/refresh', async (request, reply) => {
    const schema = z.object({ refreshToken: z.string().min(20) });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Refresh token inválido.' });
    }

    const incomingHash = hashSecretSha256(parsed.data.refreshToken);
    const existingSession = await prisma.refreshSession.findUnique({
      where: { tokenHash: incomingHash },
      include: {
        user: {
          include: { coupons: true, addresses: true, favorites: true },
        },
      },
    });

    if (
      !existingSession ||
      existingSession.revokedAt !== null ||
      existingSession.expiresAt < new Date()
    ) {
      return reply.status(401).send({ error: 'Sesión expirada o revocada. Inicia sesión nuevamente.' });
    }

    if (
      existingSession.user.role !== 'ADMIN' &&
      (existingSession.user.status === 'bloqueado_fraude' || existingSession.user.pendingDebt > 0)
    ) {
      return reply.status(403).send({ error: 'Tu cuenta se encuentra bloqueada.' });
    }

    // Revocar sesión anterior y emitir nueva sesión rotada
    await prisma.refreshSession.update({
      where: { id: existingSession.id },
      data: { revokedAt: new Date() },
    });

    const nextSession = await createUserRefreshSession({
      userId: existingSession.user.id,
      userAgent: request.headers['user-agent'],
      ipAddress: request.ip,
    });

    const token = signAuthToken({
      sub: existingSession.user.id,
      email: existingSession.user.email,
      role: existingSession.user.role,
      name: existingSession.user.name,
      phone: existingSession.user.phone,
      sid: nextSession.sessionId,
    });

    return reply.send({
      token,
      refreshToken: nextSession.refreshToken,
      isAdmin: existingSession.user.role === 'ADMIN',
      user: serializeUserAccount(existingSession.user),
    });
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const body = (request.body || {}) as { refreshToken?: string; allDevices?: boolean };
    const authUser = extractUserFromRequest(request);
    const now = new Date();

    if (body.allDevices && authUser) {
      await prisma.refreshSession.updateMany({
        where: { userId: authUser.sub, revokedAt: null },
        data: { revokedAt: now },
      });
      return reply.send({ ok: true, revokedAll: true });
    }

    if (authUser?.sid) {
      await prisma.refreshSession
        .updateMany({
          where: { id: authUser.sid, revokedAt: null },
          data: { revokedAt: now },
        })
        .catch(() => {});
    }

    if (body.refreshToken) {
      const tokenHash = hashSecretSha256(body.refreshToken);
      await prisma.refreshSession
        .updateMany({
          where: { tokenHash, revokedAt: null },
          data: { revokedAt: now },
        })
        .catch(() => {});
    }

    return reply.send({ ok: true });
  });

  // =========================================================================
  // 4. RECUPERACIÓN REAL DE CONTRASEÑA (FORGOT PASSWORD -> 6-DIGIT CODE -> RESET)
  // =========================================================================
  app.post('/api/auth/forgot-password', async (request, reply) => {
    const schema = z.object({
      email: z.string().trim().email('Ingresa un correo electrónico válido.'),
    });

    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message || 'Correo inválido.' });
    }

    const cleanEmail = parsed.data.email.toLowerCase();
    const user = await prisma.user.findUnique({ where: { email: cleanEmail } });

    // Respuesta uniforme anti-enumeración si el correo no existe
    if (!user) {
      return reply.send({
        ok: true,
        message:
          'Si el correo existe en RODO Moto Mandados, generamos un código de verificación de 6 dígitos válido por 15 minutos.',
      });
    }

    // Invalidar códigos previos sin usar del mismo usuario
    await prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    const resetCode = generateSixDigitResetCode();
    const codeHash = hashSecretSha256(resetCode);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutos

    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        codeHash,
        expiresAt,
      },
    });

    const hasSmtpConfigured = Boolean(process.env.SMTP_HOST);

    return reply.send({
      ok: true,
      message:
        'Código de recuperación generado. Tienes 15 minutos para ingresar el código de 6 dígitos y establecer tu nueva contraseña.',
      expiresInMinutes: 15,
      // Cuando aún no hay servidor SMTP externo configurado, devolvemos el código para pruebas/autoservicio
      ...(!hasSmtpConfigured ? { deliveryMode: 'local_preview', resetCodePreview: resetCode } : {}),
    });
  });

  app.post('/api/auth/reset-password', async (request, reply) => {
    const schema = z.object({
      email: z.string().trim().email('Correo inválido.'),
      code: z.string().trim().regex(/^\d{6}$/, 'El código debe tener exactamente 6 dígitos.'),
      newPassword: z.string().min(6, 'La nueva contraseña debe tener al menos 6 caracteres.'),
    });

    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message || 'Datos inválidos.' });
    }

    const cleanEmail = parsed.data.email.toLowerCase();
    const user = await prisma.user.findUnique({ where: { email: cleanEmail } });
    if (!user) {
      return reply.status(400).send({ error: 'Código inválido o expirado.' });
    }

    const latestToken = await prisma.passwordResetToken.findFirst({
      where: { userId: user.id, usedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    if (!latestToken || latestToken.expiresAt < new Date()) {
      return reply.status(400).send({
        error: 'El código de recuperación expiró. Solicita un código nuevo.',
      });
    }

    if (latestToken.attempts >= 5) {
      await prisma.passwordResetToken.update({
        where: { id: latestToken.id },
        data: { usedAt: new Date() },
      });
      return reply.status(429).send({
        error: 'Demasiados intentos fallidos. Solicita un nuevo código de recuperación.',
      });
    }

    const submittedHash = hashSecretSha256(parsed.data.code);
    const isCodeValid = timingSafeCompareHex(submittedHash, latestToken.codeHash);

    if (!isCodeValid) {
      await prisma.passwordResetToken.update({
        where: { id: latestToken.id },
        data: { attempts: { increment: 1 } },
      });
      return reply.status(400).send({ error: 'El código de 6 dígitos es incorrecto.' });
    }

    const newPasswordHash = await bcrypt.hash(parsed.data.newPassword, BCRYPT_ROUNDS);
    const now = new Date();

    // Transacción atómica: actualizar contraseña + quemar token + revocar todas las sesiones anteriores
    const updatedUser = await prisma.$transaction(async (tx) => {
      await tx.passwordResetToken.update({
        where: { id: latestToken.id },
        data: { usedAt: now },
      });

      await tx.refreshSession.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: now },
      });

      return tx.user.update({
        where: { id: user.id },
        data: { passwordHash: newPasswordHash },
        include: { coupons: true, addresses: true, favorites: true },
      });
    });

    const freshSession = await createUserRefreshSession({
      userId: updatedUser.id,
      userAgent: request.headers['user-agent'],
      ipAddress: request.ip,
    });

    const token = signAuthToken({
      sub: updatedUser.id,
      email: updatedUser.email,
      role: updatedUser.role,
      name: updatedUser.name,
      phone: updatedUser.phone,
      sid: freshSession.sessionId,
    });

    return reply.send({
      ok: true,
      message: 'Contraseña restablecida exitosamente. Todas las sesiones anteriores fueron cerradas.',
      token,
      refreshToken: freshSession.refreshToken,
      isAdmin: updatedUser.role === 'ADMIN',
      user: serializeUserAccount(updatedUser),
    });
  });

  // =========================================================================
  // 5. PERFIL PRIVADO DEL USUARIO AUTENTICADO (AISLAMIENTO ESTRICTO POR SESIÓN)
  // =========================================================================
  app.get('/api/auth/me', { preHandler: [requireAuth] }, async (request, reply) => {
    const authUser = request.authUser!;
    const user = await prisma.user.findUnique({
      where: { id: authUser.sub },
      include: {
        coupons: { orderBy: { earnedAt: 'desc' } },
        addresses: { orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }] },
        favorites: true,
        _count: {
          select: {
            orders: true,
            sessions: { where: { revokedAt: null, expiresAt: { gt: new Date() } } },
          },
        },
      },
    });

    if (!user) {
      return reply.status(404).send({ error: 'Usuario no encontrado.' });
    }

    return reply.send({
      user: serializeUserAccount(user),
      stats: {
        totalOrders: user._count.orders,
        activeSessions: user._count.sessions,
      },
    });
  });

  app.patch('/api/auth/me', { preHandler: [requireAuth] }, async (request, reply) => {
    const schema = z.object({
      name: z.string().trim().min(2).optional(),
      phone: z.string().trim().min(8).optional(),
      currentPassword: z.string().optional(),
      newPassword: z.string().min(6).optional(),
    });

    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message || 'Datos inválidos.' });
    }

    const authUser = request.authUser!;
    const existing = await prisma.user.findUnique({ where: { id: authUser.sub } });
    if (!existing) {
      return reply.status(404).send({ error: 'Usuario no encontrado.' });
    }

    const updateData: Record<string, any> = {};
    if (parsed.data.name) updateData.name = parsed.data.name;
    if (parsed.data.phone) updateData.phone = parsed.data.phone;

    if (parsed.data.newPassword) {
      if (!parsed.data.currentPassword) {
        return reply.status(400).send({ error: 'Ingresa tu contraseña actual para cambiarla.' });
      }
      const matches = await bcrypt.compare(parsed.data.currentPassword, existing.passwordHash);
      if (!matches) {
        return reply.status(401).send({ error: 'La contraseña actual es incorrecta.' });
      }
      updateData.passwordHash = await bcrypt.hash(parsed.data.newPassword, BCRYPT_ROUNDS);
    }

    const updated = await prisma.user.update({
      where: { id: authUser.sub },
      data: updateData,
      include: { coupons: true, addresses: true, favorites: true },
    });

    return reply.send({ user: serializeUserAccount(updated) });
  });

  // DIRECCIONES PRIVADAS DEL CLIENTE
  app.get('/api/profile/addresses', { preHandler: [requireAuth] }, async (request, reply) => {
    const addresses = await prisma.customerAddress.findMany({
      where: { userId: request.authUser!.sub },
      orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
    });
    return reply.send(addresses);
  });

  app.post('/api/profile/addresses', { preHandler: [requireAuth] }, async (request, reply) => {
    const schema = z.object({
      label: z.string().trim().min(1).max(60).default('Casa'),
      calle: z.string().trim().min(2).max(160),
      numero: z.string().trim().min(1).max(40),
      colonia: z.string().trim().min(2).max(120),
      referencias: z.string().trim().max(300).optional(),
      lat: z.number().optional(),
      lng: z.number().optional(),
      isDefault: z.boolean().optional(),
    });

    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Completa calle, número y colonia.' });
    }

    const userId = request.authUser!.sub;
    const created = await prisma.$transaction(async (tx) => {
      if (parsed.data.isDefault) {
        await tx.customerAddress.updateMany({
          where: { userId },
          data: { isDefault: false },
        });
      }
      return tx.customerAddress.create({
        data: {
          userId,
          label: parsed.data.label,
          calle: parsed.data.calle,
          numero: parsed.data.numero,
          colonia: parsed.data.colonia,
          referencias: parsed.data.referencias || null,
          lat: parsed.data.lat ?? null,
          lng: parsed.data.lng ?? null,
          isDefault: Boolean(parsed.data.isDefault),
        },
      });
    });

    return reply.status(201).send(created);
  });

  app.delete('/api/profile/addresses/:id', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await prisma.customerAddress.deleteMany({
      where: { id, userId: request.authUser!.sub },
    });
    if (result.count === 0) {
      return reply.status(404).send({ error: 'Dirección no encontrada en tu perfil.' });
    }
    return reply.send({ ok: true, id });
  });

  // FAVORITOS PRIVADOS DEL CLIENTE
  app.get('/api/profile/favorites', { preHandler: [requireAuth] }, async (request, reply) => {
    const favs = await prisma.userFavorite.findMany({
      where: { userId: request.authUser!.sub },
      select: { restaurantId: true },
    });
    return reply.send(favs.map((f) => f.restaurantId));
  });

  app.post('/api/profile/favorites/:restaurantId', { preHandler: [requireAuth] }, async (request, reply) => {
    const { restaurantId } = request.params as { restaurantId: string };
    const restExists = await prisma.restaurant.findUnique({ where: { id: restaurantId } });
    if (!restExists) {
      return reply.status(404).send({ error: 'Restaurante no encontrado.' });
    }

    await prisma.userFavorite.upsert({
      where: {
        userId_restaurantId: {
          userId: request.authUser!.sub,
          restaurantId,
        },
      },
      update: {},
      create: {
        userId: request.authUser!.sub,
        restaurantId,
      },
    });
    return reply.status(201).send({ ok: true, restaurantId });
  });

  app.delete('/api/profile/favorites/:restaurantId', { preHandler: [requireAuth] }, async (request, reply) => {
    const { restaurantId } = request.params as { restaurantId: string };
    await prisma.userFavorite.deleteMany({
      where: { userId: request.authUser!.sub, restaurantId },
    });
    return reply.send({ ok: true, restaurantId });
  });

  // SESIONES ACTIVAS DEL USUARIO AUTENTICADO
  app.get('/api/profile/sessions', { preHandler: [requireAuth] }, async (request, reply) => {
    const sessions = await prisma.refreshSession.findMany({
      where: {
        userId: request.authUser!.sub,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: {
        id: true,
        userAgent: true,
        ipAddress: true,
        createdAt: true,
        expiresAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    return reply.send(
      sessions.map((s) => ({
        ...s,
        isCurrent: s.id === request.authUser!.sid,
      }))
    );
  });

  // =========================================================================
  // 6. ADMINISTRACIÓN CENTRALIZADA DE CUENTAS Y BLOQUEOS (EXCLUSIVO ADMIN RBAC)
  // =========================================================================
  app.get('/api/auth/accounts', { preHandler: [requireAdmin] }, async (_request, reply) => {
    const users = await prisma.user.findMany({
      where: { role: 'CUSTOMER' },
      include: { coupons: true },
      orderBy: { updatedAt: 'desc' },
    });
    return reply.send(users.map(serializeUserAccount));
  });

  app.post('/api/auth/accounts', { preHandler: [requireAdmin] }, async (request, reply) => {
    const body = request.body as any;
    if (!body || !body.email) {
      return reply.status(400).send({ error: 'Datos de cuenta inválidos' });
    }
    const cleanEmail = String(body.email).trim().toLowerCase();
    const id = body.id || `cust-${Date.now()}`;
    const defaultHash = await bcrypt.hash(cryptoRandomFallback(), 10);

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
        blockedAt: body.blockedAt ? new Date(body.blockedAt) : null,
        completedOrdersCount: Number(body.completedOrdersCount ?? 0),
        referralCode: body.referralCode || null,
        referredByCode: body.referredByCode || null,
        referralRewardsCount: Number(body.referralRewardsCount ?? 0),
      },
      create: {
        id,
        name: body.name || 'Cliente RODO',
        phone: body.phone || '',
        email: cleanEmail,
        passwordHash: defaultHash,
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
        blockedAt: body.blockedAt ? new Date(body.blockedAt) : null,
        completedOrdersCount: Number(body.completedOrdersCount ?? 0),
        referralCode: body.referralCode || null,
        referredByCode: body.referredByCode || null,
        referralRewardsCount: Number(body.referralRewardsCount ?? 0),
      },
      include: { coupons: true },
    });

    const serialized = serializeUserAccount(saved);
    emitAdminEvent('accounts:updated', serialized);
    return reply.send(serialized);
  });

  // SOLICITUDES DE RECUPERACIÓN CON SOPORTE INE
  app.get('/api/auth/recovery', { preHandler: [requireAdmin] }, async (request, reply) => {
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

    const oldEmailClean = String(body.oldEmail || '').trim().toLowerCase();
    const matchedUser = oldEmailClean
      ? await prisma.user.findUnique({ where: { email: oldEmailClean }, select: { id: true } })
      : null;

    const created = await prisma.accountRecoveryRequest.upsert({
      where: { id: body.id },
      update: {
        status: body.status || 'pendiente',
      },
      create: {
        id: body.id,
        folio: body.folio,
        userId: matchedUser?.id || null,
        customerName: body.customerName || 'Cliente',
        phone: body.phone || '',
        oldEmail: oldEmailClean,
        newEmail: String(body.newEmail || '').trim().toLowerCase(),
        reason: body.reason || null,
        documentPhotoUrl: body.documentPhotoUrl || null,
        ine10Digits: body.ine10Digits || null,
        status: 'pendiente',
        createdAt: body.createdAt || new Date().toISOString(),
      },
    });

    emitAdminEvent('recovery:updated', created);
    return reply.status(201).send(created);
  });

  app.patch('/api/auth/recovery/:id', { preHandler: [requireAdmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      status: 'aprobada' | 'rechazada';
      adminNotes?: string;
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
        reviewedBy: request.authUser!.email,
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
            ...(cleanOld ? [{ email: cleanOld }] : []),
            ...(cleanPhone.length >= 8 ? [{ phone: { contains: cleanPhone } }] : []),
          ],
        },
      });

      if (matchedOld) {
        await prisma.user.update({
          where: { id: matchedOld.id },
          data: {
            email: cleanNew,
            name: existing.customerName || matchedOld.name,
            phone: existing.phone || matchedOld.phone,
            status: 'activo',
          },
        });
      }
    }

    emitAdminEvent('recovery:updated', updated);
    return reply.send(updated);
  });

  // LISTA NEGRA CENTRALIZADA (EXCLUSIVO ADMIN)
  app.get('/api/auth/blocked-customers', { preHandler: [requireAdmin] }, async (_request, reply) => {
    const blockedUsers = await prisma.user.findMany({
      where: {
        OR: [{ status: 'bloqueado_fraude' }, { pendingDebt: { gt: 0 } }],
      },
      orderBy: { updatedAt: 'desc' },
    });

    const list = blockedUsers.map((u) => ({
      identifier: u.phone || u.email,
      customerName: u.name,
      reason: u.fraudReason || u.debtReason || 'Bloqueado por seguridad o adeudo pendiente',
      blockedAt: u.blockedAt ? u.blockedAt.toISOString() : u.updatedAt.toISOString(),
    }));
    return reply.send(list);
  });

  app.post('/api/auth/blocked-customers', { preHandler: [requireAdmin] }, async (request, reply) => {
    const body = request.body as {
      identifier?: string;
      customerName?: string;
      reason?: string;
    };
    const identifier = String(body?.identifier || '').trim();
    if (!identifier) {
      return reply.status(400).send({ error: 'Identificador (teléfono o correo) requerido.' });
    }

    const cleanPhone = identifier.replace(/[^0-9]/g, '');
    const isEmail = identifier.includes('@');
    const cleanEmail = isEmail ? identifier.toLowerCase() : `blocked-${cleanPhone || Date.now()}@rodo.local`;
    const now = new Date();
    const reason = body?.reason || 'Actividad sospechosa o intento de fraude detectado';

    const existing = await prisma.user.findFirst({
      where: {
        OR: [
          ...(isEmail ? [{ email: cleanEmail }] : []),
          ...(cleanPhone.length >= 8 ? [{ phone: { contains: cleanPhone } }] : []),
        ],
      },
    });

    let updatedUser;
    if (existing) {
      updatedUser = await prisma.user.update({
        where: { id: existing.id },
        data: {
          status: 'bloqueado_fraude',
          fraudReason: reason,
          blockedAt: now,
        },
        include: { coupons: true },
      });
      // Revocar sesiones activas inmediatamente al bloquear al usuario
      await prisma.refreshSession.updateMany({
        where: { userId: existing.id, revokedAt: null },
        data: { revokedAt: now },
      });
    } else {
      const randomHash = await bcrypt.hash(cryptoRandomFallback(), 10);
      updatedUser = await prisma.user.create({
        data: {
          id: `cust-blocked-${Date.now()}`,
          name: body?.customerName || 'Cliente Bloqueado',
          phone: cleanPhone || identifier,
          email: cleanEmail,
          passwordHash: randomHash,
          role: 'CUSTOMER',
          status: 'bloqueado_fraude',
          fraudReason: reason,
          blockedAt: now,
        },
        include: { coupons: true },
      });
    }

    emitAdminEvent('accounts:updated', serializeUserAccount(updatedUser));
    return reply.status(201).send({
      identifier,
      customerName: updatedUser.name,
      reason,
      blockedAt: now.toISOString(),
    });
  });

  app.delete('/api/auth/blocked-customers/:identifier', { preHandler: [requireAdmin] }, async (request, reply) => {
    const { identifier } = request.params as { identifier: string };
    const cleanId = decodeURIComponent(identifier || '').trim();
    const cleanPhone = cleanId.replace(/[^0-9]/g, '');

    const matched = await prisma.user.findMany({
      where: {
        OR: [
          { email: cleanId.toLowerCase() },
          ...(cleanPhone.length >= 8 ? [{ phone: { contains: cleanPhone } }] : []),
        ],
      },
    });

    for (const u of matched) {
      const updated = await prisma.user.update({
        where: { id: u.id },
        data: {
          status: 'activo',
          pendingDebt: 0,
          fraudReason: null,
          debtReason: null,
          blockedAt: null,
        },
        include: { coupons: true },
      });
      emitAdminEvent('accounts:updated', serializeUserAccount(updated));
    }

    return reply.send({ ok: true, identifier: cleanId });
  });
}

function cryptoRandomFallback(): string {
  return `rodo-internal-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
