import { Redis } from 'ioredis';
import { env } from '../config/env.js';

let redisClient: Redis | null = null;
let isRedisReady = false;

export function getRedisClient(): Redis | null {
  if (!redisClient) {
    try {
      redisClient = new Redis(env.REDIS_URL, {
        maxRetriesPerRequest: 2,
        enableOfflineQueue: false,
        lazyConnect: true,
      });

      redisClient.on('connect', () => {
        isRedisReady = true;
        console.log('[Redis] Connected to Redis cache');
      });

      redisClient.on('error', (err: Error) => {
        isRedisReady = false;
        console.warn('[Redis] Cache warning (falling back to DB):', err.message);
      });

      redisClient.connect().catch(() => {
        isRedisReady = false;
      });
    } catch {
      isRedisReady = false;
    }
  }
  return isRedisReady ? redisClient : null;
}

export async function getCache<T>(key: string): Promise<T | null> {
  try {
    const client = getRedisClient();
    if (!client) return null;
    const raw = await client.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export async function setCache(key: string, value: unknown, ttlSeconds = 300): Promise<void> {
  try {
    const client = getRedisClient();
    if (!client) return;
    await client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch {
    // Non-blocking cache write
  }
}

export async function invalidateCache(patternOrKey: string): Promise<void> {
  try {
    const client = getRedisClient();
    if (!client) return;
    if (patternOrKey.includes('*')) {
      const keys = await client.keys(patternOrKey);
      if (keys.length > 0) {
        await client.del(...keys);
      }
    } else {
      await client.del(patternOrKey);
    }
  } catch {
    // Non-blocking cache invalidation
  }
}
