import crypto from 'node:crypto';

const DEFAULT_STEP_UP_SECRET = 'rodo_super_secret_jwt_key_sma_2026_enterprise';

export const ALLOWED_ADMIN_STEP_UP_ACTIONS = [
  'cancel_order_fraud',
  'block_customer',
  'change_bank_clabe',
  'modify_surcharge',
  'authorize_high_cash',
  'admin_login',
] as const;

export type AdminStepUpAction = (typeof ALLOWED_ADMIN_STEP_UP_ACTIONS)[number];

export function isAdminStepUpAction(val: unknown): val is AdminStepUpAction {
  return (
    typeof val === 'string' &&
    (ALLOWED_ADMIN_STEP_UP_ACTIONS as readonly string[]).includes(val)
  );
}

/**
 * Emite un token criptográfico de segundo factor (Step-Up) de corta duración (5 min)
 * vinculado exclusivamente al ID del administrador y al tipo de acción autorizada.
 */
export function createAdminStepUpToken(
  adminUserId: string,
  actionType: AdminStepUpAction,
  secret: string = process.env.JWT_SECRET || DEFAULT_STEP_UP_SECRET,
  validityMs: number = 5 * 60 * 1000,
  nowMs: number = Date.now()
): string {
  const expiresAt = nowMs + validityMs;
  const nonce = crypto.randomBytes(8).toString('hex');
  const payload = `${adminUserId}|${actionType}|${expiresAt}|${nonce}`;
  const payloadB64 = Buffer.from(payload, 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', secret)
    .update(`rodo-admin-stepup-v1:${payloadB64}`)
    .digest('base64url');
  return `${payloadB64}.${sig}`;
}

export function verifyAdminStepUpToken(
  token: unknown,
  expectedAdminUserId: string,
  expectedAction: AdminStepUpAction,
  secret: string = process.env.JWT_SECRET || DEFAULT_STEP_UP_SECRET,
  nowMs: number = Date.now()
): boolean {
  if (typeof token !== 'string' || !token.includes('.')) return false;
  const parts = token.trim().split('.');
  if (parts.length !== 2) return false;
  const [payloadB64, providedSig] = parts;
  if (!payloadB64 || !providedSig) return false;

  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(`rodo-admin-stepup-v1:${payloadB64}`)
    .digest('base64url');

  const sigBufA = Buffer.from(expectedSig, 'utf8');
  const sigBufB = Buffer.from(providedSig, 'utf8');
  if (sigBufA.length !== sigBufB.length || !crypto.timingSafeEqual(sigBufA, sigBufB)) {
    return false;
  }

  try {
    const decoded = Buffer.from(payloadB64, 'base64url').toString('utf8');
    const [adminId, actionType, expStr] = decoded.split('|');
    const expiresAt = Number(expStr);
    if (!adminId || !actionType || !Number.isFinite(expiresAt)) return false;
    if (adminId !== expectedAdminUserId) return false;
    if (actionType !== expectedAction) return false;
    if (nowMs > expiresAt) return false;
    return true;
  } catch {
    return false;
  }
}
