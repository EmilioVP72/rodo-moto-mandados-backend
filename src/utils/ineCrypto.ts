import crypto from 'crypto';

const ENCRYPTION_PREFIX = 'enc:v1:';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit IV recomendado por NIST para AES-GCM
const FALLBACK_DEV_SECRET = 'rodo_super_secret_jwt_key_sma_2026_enterprise';

function getMasterSecret(overrideSecret?: string): string {
  const fromEnv = (process.env.INE_ENCRYPTION_KEY || '').trim() || (process.env.JWT_SECRET || '').trim();
  return (overrideSecret || fromEnv || FALLBACK_DEV_SECRET).trim();
}

/**
 * Deriva claves independientes de 256 bits por separación de dominio:
 * - "enc:v1": clave simétrica para cifrado autenticado AES-256-GCM
 * - "idx:v1": clave HMAC-SHA256 para índice ciego único/antifraude
 */
function deriveDomainKey(domain: 'enc:v1' | 'idx:v1', overrideSecret?: string): Buffer {
  const master = getMasterSecret(overrideSecret);
  return crypto.createHash('sha256').update(`${domain}:${master}`, 'utf8').digest();
}

export function isEncryptedIne(value?: string | null): boolean {
  return typeof value === 'string' && value.startsWith(ENCRYPTION_PREFIX);
}

export function normalizeIneDigits(raw?: string | null): string {
  return String(raw || '').replace(/[^0-9]/g, '');
}

/**
 * Cifra los dígitos de la INE con AES-256-GCM (IV aleatorio de 96 bits + AuthTag de 128 bits).
 * Formato almacenado en PostgreSQL: enc:v1:<iv_b64url>:<tag_b64url>:<cipher_b64url>
 */
export function encryptIneDigits(rawDigits: string, overrideSecret?: string): string {
  const clean = normalizeIneDigits(rawDigits);
  if (!clean) {
    throw new Error('No se pueden cifrar dígitos de INE vacíos.');
  }

  const key = deriveDomainKey('enc:v1', overrideSecret);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(clean, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${ENCRYPTION_PREFIX}${iv.toString('base64url')}:${authTag.toString('base64url')}:${encrypted.toString('base64url')}`;
}

/**
 * Descifra un valor cifrado AES-256-GCM. Si recibe un valor legado en texto plano
 * (antes de activar el cifrado), lo devuelve normalizado para permitir migración transparente.
 */
export function decryptIneDigits(storedValue?: string | null, overrideSecret?: string): string | null {
  if (!storedValue) return null;

  if (!isEncryptedIne(storedValue)) {
    const legacyClean = normalizeIneDigits(storedValue);
    return legacyClean || null;
  }

  const parts = storedValue.slice(ENCRYPTION_PREFIX.length).split(':');
  if (parts.length !== 3) {
    return null;
  }

  try {
    const [ivB64, tagB64, cipherB64] = parts;
    const key = deriveDomainKey('enc:v1', overrideSecret);
    const iv = Buffer.from(ivB64, 'base64url');
    const authTag = Buffer.from(tagB64, 'base64url');
    const encrypted = Buffer.from(cipherB64, 'base64url');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    return decrypted || null;
  } catch {
    return null;
  }
}

/**
 * Índice ciego determinístico HMAC-SHA256 para búsquedas O(1) y restricción @unique
 * (evita cuentas duplicadas y bloquea INE con adeudos sin guardar texto plano).
 */
export function hashIneForLookup(rawDigits: string, overrideSecret?: string): string {
  const clean = normalizeIneDigits(rawDigits);
  if (!clean) {
    throw new Error('No se puede calcular índice HMAC de una INE vacía.');
  }

  const key = deriveDomainKey('idx:v1', overrideSecret);
  return crypto.createHmac('sha256', key).update(clean, 'utf8').digest('hex');
}

/**
 * Devuelve la representación enmascarada segura para APIs y UI (ej. ******5434).
 * Jamás expone los 10 dígitos completos ni el texto cifrado al navegador.
 */
export function maskIneDigits(storedOrPlain?: string | null, overrideSecret?: string): string | undefined {
  if (!storedOrPlain) return undefined;
  const plain = decryptIneDigits(storedOrPlain, overrideSecret);
  if (!plain) return '**********';
  const last4 = plain.slice(-4);
  return `******${last4}`;
}

/**
 * Prepara los dígitos de INE para guardado seguro en PostgreSQL:
 * - encrypted: cadena AES-256-GCM para columna `ine10Digits`
 * - hash: HMAC-SHA256 determinístico para columna única `ine10DigitsHash`
 */
export function prepareIneForStorage(
  rawDigits?: string | null,
  overrideSecret?: string
): { encrypted: string; hash: string } | null {
  if (!rawDigits) return null;
  const plain = isEncryptedIne(rawDigits)
    ? decryptIneDigits(rawDigits, overrideSecret)
    : normalizeIneDigits(rawDigits);
  if (!plain || plain.length < 4) return null;

  return {
    encrypted: encryptIneDigits(plain, overrideSecret),
    hash: hashIneForLookup(plain, overrideSecret),
  };
}
