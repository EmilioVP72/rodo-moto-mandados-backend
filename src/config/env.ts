import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z
    .string()
    .default('postgresql://rodo_user:rodo_secure_pass_2026@rodo-db:5432/rodo_db?schema=public'),
  REDIS_URL: z.string().default('redis://rodo-redis:6379'),
  JWT_SECRET: z
    .string()
    .min(16)
    .default('rodo_super_secret_jwt_key_sma_2026_enterprise'),
  JWT_EXPIRES_IN: z.string().default('30d'),
  ADMIN_EMAIL: z.string().default('edsoncruz14999@gmail.com'),
  ADMIN_INITIAL_PASSWORD: z.string().default('RODO2026'),
  CORS_ORIGIN: z.string().default('*'),
  UPLOADS_DIR: z.string().default('./uploads'),
});

export const env = envSchema.parse(process.env);
