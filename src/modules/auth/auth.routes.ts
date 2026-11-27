import { recoveryMessage, recoveryReceipt, resetMailTransport } from '../../infra/resetMail.js';
import { saveImage } from '../uploads/storage.js';
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
  generateSecureRefreshToken,
  extractUserFromRequest,
} from '../../middlewares/auth.js';
import crypto from 'node:crypto';
import { getCache, setCache, invalidateCache } from '../../infra/redis.js';
import {
  createAdminStepUpToken,
  isAdminStepUpAction,
} from '../../utils/adminStepUp.js';
import {
  REFRESH_COOKIE_NAME,
  parseCookieValue,
  isSecureCookieRequest,
  buildRefreshTokenCookieHeader,
  buildClearRefreshTokenCookieHeader,
} from '../../utils/refreshCookie.js';
import { emitAdminEvent } from '../../infra/socket.js';
import { verifyIneDigitsServer, getServerCustomerCashLimit } from '../../utils/domainRules.js';
import {
  prepareIneForStorage,
  maskIneDigits,
  encryptIneDigits,
  normalizeIneDigits,
  decryptIneDigits,
} from '../../utils/ineCrypto.js';

const BCRYPT_ROUNDS = 12;
const LOGIN_LOCKOUT_MAX_ATTEMPTS = 6;
const LOGIN_LOCKOUT_WINDOW_SEC = 15 * 60;

function isRequestHttps(request: { protocol?: string; headers: Record<string, unknown> }): boolean {
  return isSecureCookieRequest(
    request.protocol,
    request.headers['x-forwarded-proto'] as string | string[] | undefined,
    process.env.FORCE_SECURE_COOKIES === 'true'
  );
}

// Respaldo en memoria para bloqueos de fuerza bruta y retos OTP cuando Redis no está activo
const fallbackLoginAttempts = new Map<string, { count: number; expiresAt: number }>();
const fallbackAdminOtpChallenges = new Map<
  string,
  { codeHash: string; actionType: string; adminUserId: string; attempts: number; expiresAt: number }
>();

async function getFailedLoginCount(identifierKey: string): Promise<number> {
  const redisKey = `rodo:sec:loginfail:${identifierKey}`;
  const fromRedis = await getCache<{ count: number }>(redisKey);
  if (fromRedis && typeof fromRedis.count === 'number') {
    return fromRedis.count;
  }
  const mem = fallbackLoginAttempts.get(identifierKey);
  if (!mem) return 0;
  if (Date.now() > mem.expiresAt) {
    fallbackLoginAttempts.delete(identifierKey);
    return 0;
  }
  return mem.count;
}

async function recordFailedLoginAttempt(identifierKey: string): Promise<number> {
  const nextCount = (await getFailedLoginCount(identifierKey)) + 1;
  const redisKey = `rodo:sec:loginfail:${identifierKey}`;
  await setCache(redisKey, { count: nextCount }, LOGIN_LOCKOUT_WINDOW_SEC);
  fallbackLoginAttempts.set(identifierKey, {
    count: nextCount,
    expiresAt: Date.now() + LOGIN_LOCKOUT_WINDOW_SEC * 1000,
  });
  return nextCount;
}

async function clearFailedLoginAttempts(identifierKey: string): Promise<void> {
  fallbackLoginAttempts.delete(identifierKey);
  await invalidateCache(`rodo:sec:loginfail:${identifierKey}`);
}

function serializeRecoveryRequest(rec: any) {
  return {
    ...rec,
    ine10Digits: maskIneDigits(rec.ine10Digits) || null,
  };
}

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

  const maskedIne = maskIneDigits(user.ine10Digits);

  return {
    id: user.id,
    name: user.name,
    phone: user.phone,
    email: user.email,
    role: user.role,
    ineVerified: Boolean(user.ineReviewedBy && user.ineVerified),
    ineDigits: maskedIne,
    ine10Digits: maskedIne,
    inePhotoUploaded: user.inePhotoUploaded,
    ineVerifiedAt: !user.ineReviewedBy ? undefined :
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
    cashLimit: getServerCustomerCashLimit(user.completedOrdersCount),
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
      password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres.'),
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

    // Cifrar INE con AES-256-GCM y generar índice ciego HMAC-SHA256 para búsqueda única/antifraude
    const preparedIne = prepareIneForStorage(cleanDigits);
    if (!preparedIne) {
      return reply.status(400).send({ error: 'No se pudieron procesar los 10 dígitos de tu INE.' });
    }

    // Verificar INE duplicado o con adeudo en PostgreSQL usando índice ciego HMAC (sin texto plano)
    const existingByIne = await prisma.user.findUnique({
      where: { ine10DigitsHash: preparedIne.hash },
      include: { coupons: true },
    });

    if (existingByIne) {
      if (existingByIne.pendingDebt > 0 || existingByIne.status === 'bloqueado_fraude') {
        return reply.status(403).send({
          error:
            'Esta credencial registra una restricción o adeudo pendiente en el sistema. Inicia sesión con tu cuenta registrada o contacta a soporte RODO.',
        });
      }

      return reply.status(409).send({
        error:
          'Esta credencial ya está vinculada a una cuenta registrada. Inicia sesión o usa "Recuperar contraseña".',
      });
    }

    // Verificar correo duplicado en PostgreSQL
    const existingByEmail = await prisma.user.findUnique({
      where: { email: cleanEmail },
    });

    if (existingByEmail) {
      if (existingByEmail.pendingDebt > 0 || existingByEmail.status === 'bloqueado_fraude') {
        return reply.status(403).send({
          error:
            'Esta cuenta registra una restricción o adeudo pendiente. Inicia sesión o contacta a soporte RODO.',
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
        if (referrer && referrer.email !== cleanEmail && referrer.ine10DigitsHash !== preparedIne.hash) {
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
          ineVerified: false,
          ine10Digits: preparedIne.encrypted,
          ine10DigitsHash: preparedIne.hash,
          inePhotoUploaded: false,
          ineVerifiedAt: null,
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

    reply.header('Set-Cookie', buildRefreshTokenCookieHeader(session.refreshToken, isRequestHttps(request)));

    return reply.status(201).send({
      token,
      refreshToken: session.refreshToken,
      isAdmin: false,
      user: serialized,
    });
  });

  // =========================================================================
  // 2. INICIO DE SESIÓN CON CREDENCIALES REALES (BCRYPT + BLOQUEO FUERZA BRUTA)
  // =========================================================================
  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 15, timeWindow: '15 minutes' } } },
    async (request, reply) => {
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
      const lockoutKey = lookupEmail;
      if ((await getFailedLoginCount(lockoutKey)) >= LOGIN_LOCKOUT_MAX_ATTEMPTS) {
        return reply.status(429).send({
          error:
            'Demasiados intentos fallidos en esta cuenta. Por seguridad espera 15 minutos o usa "Recuperar contraseña".',
        });
      }

      const phoneDigits = cleanIdentifier.replace(/[^0-9]/g, '');

      const user = await prisma.user.findFirst({
        where: {
          NOT: { role: 'RIDER', rider: { is: { deletedAt: { not: null } } } },
          OR: [
            { email: lookupEmail },
            ...(phoneDigits.length >= 8 ? [{ phone: phoneDigits }] : []),
          ],
        },
        include: { coupons: true, addresses: true, favorites: true },
      });

      if (!user) {
        await recordFailedLoginAttempt(lockoutKey);
        return reply.status(401).send({
          error: 'Correo o contraseña incorrectos.',
        });
      }

      // 1) SIEMPRE verificar primero la contraseña con bcrypt antes de informar estado de bloqueo/adeudo
      const isPasswordValid = await bcrypt.compare(cleanPass, user.passwordHash);

      if (!isPasswordValid) {
        await recordFailedLoginAttempt(lockoutKey);
        return reply.status(401).send({
          error: 'Correo o contraseña incorrectos. Si olvidaste tu contraseña, usa "Recuperar contraseña".',
        });
      }

      await clearFailedLoginAttempts(lockoutKey);

      // 2) Solo tras probar la contraseña correcta, informar bloqueo por deuda o fraude sin exponer PII completa
      if (user.role !== 'ADMIN' && (user.status === 'bloqueado_fraude' || user.pendingDebt > 0)) {
        return reply.status(403).send({
          error:
            user.pendingDebt > 0
              ? `Acceso bloqueado: Tu cuenta registra un adeudo pendiente de $${user.pendingDebt.toFixed(2)} MXN${
                  user.debtOrderFolio ? ` (Folio ${user.debtOrderFolio})` : ''
                }. Liquida el saldo con soporte RODO para reactivar tu servicio.`
              : 'Acceso bloqueado: Tu cuenta se encuentra suspendida por seguridad. Contacta a soporte RODO.',
          debtSummary:
            user.pendingDebt > 0
              ? {
                  pendingDebt: user.pendingDebt,
                  debtOrderFolio: user.debtOrderFolio || null,
                  debtReason: user.debtReason || null,
                }
              : undefined,
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

      reply.header('Set-Cookie', buildRefreshTokenCookieHeader(session.refreshToken, isRequestHttps(request)));

      return reply.send({
        token,
        refreshToken: session.refreshToken,
        isAdmin: user.role === 'ADMIN',
        user: serializeUserAccount(user),
      });
    }
  );

  // =========================================================================
  // 3. RENOVACIÓN DE SESIÓN (REFRESH TOKEN ROTATION) Y LOGOUT CON REVOCACIÓN
  // =========================================================================
  app.post('/api/auth/refresh', async (request, reply) => {
    const bodyObj = (request.body && typeof request.body === 'object' ? request.body : {}) as {
      refreshToken?: unknown;
    };
    const bodyRefreshToken = typeof bodyObj.refreshToken === 'string' ? bodyObj.refreshToken.trim() : '';
    const cookieRefreshToken = parseCookieValue(request.headers.cookie, REFRESH_COOKIE_NAME) || '';
    const rawRefreshToken = bodyRefreshToken || cookieRefreshToken;

    if (!rawRefreshToken || rawRefreshToken.length < 20) {
      return reply.status(400).send({ error: 'Refresh token inválido.' });
    }

    const incomingHash = hashSecretSha256(rawRefreshToken);
    const existingSession = await prisma.refreshSession.findUnique({
      where: { tokenHash: incomingHash },
      include: {
        user: {
          include: { coupons: true, addresses: true, favorites: true, rider: { select: { deletedAt: true } } },
        },
      },
    });

    if (
      !existingSession ||
      existingSession.user.rider?.deletedAt ||
      existingSession.revokedAt !== null ||
      existingSession.expiresAt < new Date()
    ) {
      reply.header('Set-Cookie', buildClearRefreshTokenCookieHeader(isRequestHttps(request)));
      return reply.status(401).send({ error: 'Sesión expirada o revocada. Inicia sesión nuevamente.' });
    }

    if (
      existingSession.user.role !== 'ADMIN' &&
      (existingSession.user.status === 'bloqueado_fraude' || existingSession.user.pendingDebt > 0)
    ) {
      reply.header('Set-Cookie', buildClearRefreshTokenCookieHeader(isRequestHttps(request)));
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

    reply.header('Set-Cookie', buildRefreshTokenCookieHeader(nextSession.refreshToken, isRequestHttps(request)));

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
    const cookieRefreshToken = parseCookieValue(request.headers.cookie, REFRESH_COOKIE_NAME) || '';
    const rawRefreshToken = body.refreshToken || cookieRefreshToken;
    const now = new Date();

    reply.header('Set-Cookie', buildClearRefreshTokenCookieHeader(isRequestHttps(request)));

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

    if (rawRefreshToken) {
      const tokenHash = hashSecretSha256(rawRefreshToken);
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
  app.post('/api/auth/forgot-password', { config: { rateLimit: { max: 8, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const schema = z.object({
      email: z.string().trim().email('Ingresa un correo electrónico válido.'),
    });

    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message || 'Correo inválido.' });
    }

    const mail = resetMailTransport();
    if (!mail) return reply.code(503).send({ error: 'La recuperación por correo está temporalmente fuera de servicio.' });
    const email = parsed.data.email.toLowerCase();
    let user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      // Solicitudes aprobadas de la instalación anterior pueden no tener cuenta relacional.
      const legacy = await prisma.accountRecoveryRequest.findFirst({
        where: { newEmail: email, status: 'aprobada', userId: null }, orderBy: { storedAt: 'desc' },
      });
      if (legacy) {
        const identity = prepareIneForStorage(decryptIneDigits(legacy.ine10Digits));
        await prisma.user.createMany({ data: [{
          name: legacy.customerName, email, phone: legacy.phone,
          passwordHash: await bcrypt.hash(generateSecureRefreshToken(), BCRYPT_ROUNDS),
          role: 'CUSTOMER', ine10Digits: identity?.encrypted, ine10DigitsHash: identity?.hash,
        }], skipDuplicates: true });
        user = await prisma.user.findUnique({ where: { email } });
        if (user) await prisma.accountRecoveryRequest.updateMany({
          where: { id: legacy.id, userId: null }, data: { userId: user.id },
        });
      }
    }
    if (!user || (user.role === 'RIDER' && !await prisma.rider.findFirst({
      where: { userId: user.id, deletedAt: null }, select: { id: true },
    }))) return reply.send(recoveryReceipt);
    const code = generateSixDigitResetCode();
    const token = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id} FOR UPDATE`;
      await tx.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });
      return tx.passwordResetToken.create({ data: {
        userId: user.id, codeHash: hashSecretSha256(code), expiresAt: new Date(Date.now() + 900000),
      } });
    });
    try {
      await mail.sendMail(recoveryMessage(user.email, code, process.env.SMTP_FROM!));
    } catch {
      console.error('[Correo] Falló la entrega de un código de recuperación.');
      await prisma.passwordResetToken.update({ where: { id: token.id }, data: { usedAt: new Date() } });
    }
    return reply.send(recoveryReceipt);
  });

  app.post(
    '/api/auth/reset-password',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const schema = z.object({
        email: z.string().trim().email('Correo inválido.'),
        code: z.string().trim().regex(/^\d{6}$/, 'El código debe tener exactamente 6 dígitos.'),
        newPassword: z.string().min(8, 'La nueva contraseña debe tener al menos 8 caracteres.'),
      });

    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message || 'Datos inválidos.' });
    }

    const cleanEmail = parsed.data.email.toLowerCase();
    const user = await prisma.user.findFirst({ where: { email: cleanEmail, NOT: { role: 'RIDER', rider: { is: { deletedAt: { not: null } } } } } });
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
      const claimed = await tx.passwordResetToken.updateMany({
        where: { id: latestToken.id, usedAt: null, attempts: { lt: 5 }, expiresAt: { gt: now } },
        data: { usedAt: now },
      });

      if (!claimed.count) return null;
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

    if (!updatedUser) return reply.code(400).send({ error: 'Código inválido o expirado.' });
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

    reply.header('Set-Cookie', buildRefreshTokenCookieHeader(freshSession.refreshToken, isRequestHttps(request)));

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
        newPassword: z.string().min(8, 'La nueva contraseña debe tener al menos 8 caracteres.').optional(),
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
      // Revocar sesiones activas en otros dispositivos al cambiar la contraseña
      await prisma.refreshSession.updateMany({
        where: {
          userId: authUser.sub,
          revokedAt: null,
          ...(authUser.sid ? { id: { not: authUser.sid } } : {}),
        },
        data: { revokedAt: new Date() },
      });
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
      numero: z.string().trim().max(40).nullable().optional(),
      numeroInterior: z.string().trim().max(40).nullable().optional(),
      colonia: z.string().trim().min(2).max(120),
      referencias: z.string().trim().max(300).nullable().optional(),
      lat: z.number().nullable().optional(),
      lng: z.number().nullable().optional(),
      isDefault: z.boolean().optional(),
    });

    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Completa al menos la calle y la colonia.' });
    }

    const cleanNumero = parsed.data.numero?.trim() || null;
    const cleanNumeroInterior = parsed.data.numeroInterior?.trim() || null;
    const cleanReferencias = parsed.data.referencias?.trim() || null;

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
          numero: cleanNumero,
          numeroInterior: cleanNumeroInterior,
          colonia: parsed.data.colonia,
          referencias: cleanReferencias,
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

  app.post('/api/auth/accounts/:id/identity-review', { preHandler: [requireAdmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = z.object({ digits: z.string().regex(/^\d{10}$/), checkedOriginal: z.literal(true) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Confirma la revisión del documento original y captura sus diez dígitos.' });
    const identity = prepareIneForStorage(parsed.data.digits)!;
    const result = await prisma.user.updateMany({
      where: { id, role: 'CUSTOMER', ine10DigitsHash: identity.hash },
      data: { ineReviewedBy: request.authUser!.sub, ineVerified: true, ineVerifiedAt: new Date() },
    });
    if (!result.count) return reply.code(409).send({ error: 'El documento presentado no coincide con el registro.' });
    return reply.send({ ok: true });
  });

  app.post('/api/auth/accounts', { preHandler: [requireAdmin] }, async (request, reply) => {
    const body = request.body as any;
    if (!body || !body.email) {
      return reply.status(400).send({ error: 'Datos de cuenta inválidos' });
    }
    const cleanEmail = String(body.email).trim().toLowerCase();
    const id = body.id || `cust-${Date.now()}`;
    const defaultHash = await bcrypt.hash(cryptoRandomFallback(), 10);
    const rawIneInput = typeof (body.ine10Digits || body.ineDigits) === 'string'
      ? String(body.ine10Digits || body.ineDigits)
      : '';
    const preparedAdminIne =
      rawIneInput && !rawIneInput.includes('*') ? prepareIneForStorage(rawIneInput) : null;

    const saved = await prisma.user.upsert({
      where: { email: cleanEmail },
      update: {
        name: body.name || 'Cliente RODO',
        phone: body.phone || '',
        ...(preparedAdminIne
          ? {
              ineReviewedBy: null,
              ineVerified: false,
              ineVerifiedAt: null,
              ine10Digits: preparedAdminIne.encrypted,
              ine10DigitsHash: preparedAdminIne.hash,
            }
          : {}),
        inePhotoUploaded: Boolean(body.inePhotoUploaded ?? false),
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
        ineVerified: false,
        ine10Digits: preparedAdminIne?.encrypted || null,
        ine10DigitsHash: preparedAdminIne?.hash || null,
        inePhotoUploaded: Boolean(body.inePhotoUploaded ?? false),
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
    return reply.send(list.map(serializeRecoveryRequest));
  });

  app.post('/api/auth/recovery', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const body = request.body as any;
    if (!body?.id || !body?.folio || !body?.newEmail) {
      return reply.status(400).send({ error: 'Datos de solicitud incompletos.' });
    }

    const oldEmailClean = String(body.oldEmail || '').trim().toLowerCase();
    const matchedUser = oldEmailClean
      ? await prisma.user.findUnique({ where: { email: oldEmailClean }, select: { id: true } })
      : null;

    const rawRecoveryIne = typeof body.ine10Digits === 'string' ? body.ine10Digits : '';
    const cleanRecoveryIne = !rawRecoveryIne.includes('*') ? normalizeIneDigits(rawRecoveryIne) : '';
    const encryptedRecoveryIne = cleanRecoveryIne ? encryptIneDigits(cleanRecoveryIne) : null;

    if (!z.string().email().safeParse(body.newEmail).success || !body.customerName || !body.phone) {
      return reply.code(400).send({ error: 'Completa tu nombre, teléfono y correo.' });
    }
    const image = await saveImage('recovery', body.documentPhotoUrl);
    if (!image) return reply.code(400).send({ error: 'Adjunta una identificación JPG, PNG o WebP de hasta 4 MB.' });
    const created = await prisma.accountRecoveryRequest.create({
      data: {
        id: body.id,
        folio: body.folio,
        userId: matchedUser?.id || null,
        customerName: body.customerName || 'Cliente',
        phone: body.phone || '',
        oldEmail: oldEmailClean,
        newEmail: String(body.newEmail || '').trim().toLowerCase(),
        reason: body.reason || null,
        documentPhotoUrl: image.url,
        ine10Digits: encryptedRecoveryIne,
        status: 'pendiente',
        createdAt: body.createdAt || new Date().toISOString(),
      },
    }).catch(async error => { await image.discard(); throw error; });

    const serializedRecovery = serializeRecoveryRequest(created);
    emitAdminEvent('recovery:updated', serializedRecovery);
    return reply.status(201).send({ id: created.id, folio: created.folio, status: created.status });
  });

  app.patch('/api/auth/recovery/:id', { preHandler: [requireAdmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsedBody = z
      .object({
        status: z.enum(['aprobada', 'rechazada']),
        adminNotes: z.string().max(500).optional(),
      })
      .safeParse(request.body);
    if (!parsedBody.success) {
      return reply.status(400).send({ error: 'Estado de revisión inválido.' });
    }
    const body = parsedBody.data;

    const existing = await prisma.accountRecoveryRequest.findUnique({ where: { id } });
    if (!existing) {
      return reply.status(404).send({ error: 'Solicitud no encontrada.' });
    }

    if (body.status === 'aprobada') {
      const cleanOld = existing.oldEmail.trim().toLowerCase();
      const cleanNew = existing.newEmail.trim().toLowerCase();
      const cleanPhone = existing.phone.replace(/[^0-9]/g, '');

      // 1. Buscar exclusivamente cuentas CUSTOMER por coincidencia EXACTA (jamás ADMIN ni RIDER ni contains parcial)
      const matchedOld = existing.userId
        ? await prisma.user.findFirst({ where: { id: existing.userId, role: 'CUSTOMER' } })
        : await prisma.user.findFirst({
            where: {
              role: 'CUSTOMER',
              OR: [
                ...(cleanOld ? [{ email: cleanOld }] : []),
                ...(cleanPhone.length >= 10 ? [{ phone: cleanPhone }] : []),
              ],
            },
          });

      // 2. Evitar colisión o robo de correo perteneciente a otra cuenta existente
      const emailOwner = await prisma.user.findUnique({ where: { email: cleanNew } });
      if (emailOwner && emailOwner.id !== matchedOld?.id) {
        return reply.status(409).send({
          error: 'El nuevo correo solicitado ya pertenece a otra cuenta registrada en el sistema.',
        });
      }

      if (matchedOld) {
        // 3. Si la cuenta tiene INE registrada, verificar coincidencia criptográfica del hash INE antes de transferir el correo
        if (matchedOld.ine10DigitsHash) {
          const submittedIne = prepareIneForStorage(decryptIneDigits(existing.ine10Digits));
          if (!submittedIne || submittedIne.hash !== matchedOld.ine10DigitsHash) {
            return reply.status(409).send({
              error:
                'Bloqueo anti-suplantación: Los 10 dígitos de INE de la solicitud no coinciden con la credencial registrada del titular.',
            });
          }
        }

        const revokeAt = new Date();
        await prisma.$transaction([
          prisma.user.update({
            where: { id: matchedOld.id },
            data: {
              email: cleanNew,
              name: existing.customerName || matchedOld.name,
              phone: existing.phone || matchedOld.phone,
              // Preservar bloqueos por adeudo o fraude; no reactivar cuentas deudoras automáticamente
              status:
                matchedOld.status === 'bloqueado_fraude' || matchedOld.pendingDebt > 0
                  ? matchedOld.status
                  : 'activo',
            },
          }),
          // Revocar todas las sesiones anteriores al cambiar el correo de acceso
          prisma.refreshSession.updateMany({
            where: { userId: matchedOld.id, revokedAt: null },
            data: { revokedAt: revokeAt },
          }),
        ]);
      }
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

    const serializedUpdatedRecovery = serializeRecoveryRequest(updated);
    emitAdminEvent('recovery:updated', serializedUpdatedRecovery);
    return reply.send(serializedUpdatedRecovery);
  });

  // =========================================================================
  // 7. SEGUNDO FACTOR (STEP-UP OTP) EN SERVIDOR PARA ACCIONES CRÍTICAS ADMIN
  // =========================================================================
  app.post(
    '/api/auth/admin/otp-challenge',
    { preHandler: [requireAdmin], config: { rateLimit: { max: 15, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const body = (request.body || {}) as { actionType?: unknown };
      if (!isAdminStepUpAction(body.actionType)) {
        return reply.status(400).send({ error: 'Tipo de acción de seguridad inválido.' });
      }

      const challengeId = `sotp-${crypto.randomUUID()}`;
      const otpCode = generateSixDigitResetCode();
      const codeHash = hashSecretSha256(otpCode);
      const ttlSec = 90;
      const expiresAt = Date.now() + ttlSec * 1000;
      const record = {
        codeHash,
        actionType: body.actionType,
        adminUserId: request.authUser!.sub,
        attempts: 0,
        expiresAt,
      };

      await setCache(`rodo:sec:sotp:${challengeId}`, record, ttlSec);
      fallbackAdminOtpChallenges.set(challengeId, record);

      const mail = resetMailTransport();
      let sentByEmail = false;
      if (mail && process.env.SMTP_FROM) {
        try {
          await mail.sendMail(
            recoveryMessage(request.authUser!.email, otpCode, process.env.SMTP_FROM)
          );
          sentByEmail = true;
        } catch {
          sentByEmail = false;
        }
      }

      return reply.status(201).send({
        challengeId,
        expiresAt,
        deliveryChannel: sentByEmail ? 'email' : 'panel',
        // Si no hay servidor SMTP configurado en el entorno, se entrega únicamente a la sesión ADMIN autenticada
        ...(sentByEmail ? {} : { otpCode }),
      });
    }
  );

  app.post(
    '/api/auth/admin/otp-verify',
    { preHandler: [requireAdmin], config: { rateLimit: { max: 15, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const parsed = z
        .object({
          challengeId: z.string().min(8).max(100),
          code: z.string().trim().regex(/^\d{6}$/, 'El código debe tener 6 dígitos.'),
        })
        .safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Datos de verificación OTP inválidos.' });
      }

      const redisKey = `rodo:sec:sotp:${parsed.data.challengeId}`;
      const record =
        (await getCache<{
          codeHash: string;
          actionType: string;
          adminUserId: string;
          attempts: number;
          expiresAt: number;
        }>(redisKey)) || fallbackAdminOtpChallenges.get(parsed.data.challengeId);

      if (!record || Date.now() > record.expiresAt) {
        fallbackAdminOtpChallenges.delete(parsed.data.challengeId);
        await invalidateCache(redisKey);
        return reply.status(400).send({ error: 'El desafío OTP expiró (+90 seg). Genera uno nuevo.' });
      }

      if (record.adminUserId !== request.authUser!.sub || !isAdminStepUpAction(record.actionType)) {
        return reply.status(403).send({ error: 'Este desafío OTP pertenece a otra sesión.' });
      }

      if (record.attempts >= 5) {
        fallbackAdminOtpChallenges.delete(parsed.data.challengeId);
        await invalidateCache(redisKey);
        return reply.status(429).send({ error: 'Demasiados intentos incorrectos. Solicita un nuevo código.' });
      }

      const inputHash = hashSecretSha256(parsed.data.code);
      if (!timingSafeCompareHex(inputHash, record.codeHash)) {
        const updatedRecord = { ...record, attempts: record.attempts + 1 };
        const remainingSec = Math.max(1, Math.ceil((record.expiresAt - Date.now()) / 1000));
        await setCache(redisKey, updatedRecord, remainingSec);
        fallbackAdminOtpChallenges.set(parsed.data.challengeId, updatedRecord);
        return reply.status(400).send({ error: 'Código OTP incorrecto. Verifica los 6 dígitos.' });
      }

      // Quemar el desafío de un solo uso y emitir stepUpToken firmado en servidor
      fallbackAdminOtpChallenges.delete(parsed.data.challengeId);
      await invalidateCache(redisKey);

      const stepUpToken = createAdminStepUpToken(
        request.authUser!.sub,
        record.actionType,
        env.JWT_SECRET
      );
      return reply.send({ ok: true, stepUpToken });
    }
  );

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
  return `rodo-internal-${crypto.randomBytes(24).toString('hex')}`;
}
