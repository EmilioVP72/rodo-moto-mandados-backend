import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const INSECURE_DEFAULT_JWT_SECRET = 'rodo_super_secret_jwt_key_sma_2026_enterprise';
const INSECURE_DEFAULT_INE_KEY = 'rodo_ine_aes256_gcm_local_key_2026_enterprise';
const INSECURE_DEFAULT_ADMIN_PASS = 'RODO2026';

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().default(4000),
    HOST: z.string().default('0.0.0.0'),
    DATABASE_URL: z
      .string()
      .default('postgresql://rodo_user:rodo_secure_pass_2026@rodo-db:5432/rodo_db?schema=public'),
    REDIS_URL: z.string().default('redis://rodo-redis:6379'),
    JWT_SECRET: z.string().min(16).default(INSECURE_DEFAULT_JWT_SECRET),
    INE_ENCRYPTION_KEY: z.preprocess(
      (val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
      z.string().min(16).optional()
    ),
    JWT_EXPIRES_IN: z.string().default('30m'),
    ADMIN_EMAIL: z.string().default('edsoncruz14999@gmail.com'),
    ADMIN_INITIAL_PASSWORD: z.string().default(INSECURE_DEFAULT_ADMIN_PASS),
    CORS_ORIGIN: z.string().default('*'),
    UPLOADS_DIR: z.string().default('./uploads'),
  })
  .superRefine((val, ctx) => {
    // En producción real, abortar el arranque si se usan secretos por defecto o débiles (fail-closed)
    if (val.NODE_ENV !== 'production' || process.env.ALLOW_DEV_DEFAULTS === 'true') {
      return;
    }

    if (
      val.JWT_SECRET === INSECURE_DEFAULT_JWT_SECRET ||
      val.JWT_SECRET.startsWith('CAMBIA_') ||
      val.JWT_SECRET.length < 32
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_SECRET'],
        message:
          'En producción JWT_SECRET debe ser un secreto único aleatorio de al menos 32 caracteres.',
      });
    }

    if (
      !val.INE_ENCRYPTION_KEY ||
      val.INE_ENCRYPTION_KEY === INSECURE_DEFAULT_INE_KEY ||
      val.INE_ENCRYPTION_KEY.startsWith('CAMBIA_') ||
      val.INE_ENCRYPTION_KEY.length < 32 ||
      val.INE_ENCRYPTION_KEY === val.JWT_SECRET
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['INE_ENCRYPTION_KEY'],
        message:
          'En producción INE_ENCRYPTION_KEY es obligatoria (mín. 32 caracteres y distinta de JWT_SECRET).',
      });
    }

    if (
      val.ADMIN_INITIAL_PASSWORD === INSECURE_DEFAULT_ADMIN_PASS ||
      val.ADMIN_INITIAL_PASSWORD.startsWith('CAMBIA_') ||
      val.ADMIN_INITIAL_PASSWORD.length < 8
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ADMIN_INITIAL_PASSWORD'],
        message:
          'En producción ADMIN_INITIAL_PASSWORD debe cambiarse por una contraseña segura de al menos 8 caracteres.',
      });
    }
  });

export const env = envSchema.parse(process.env);
