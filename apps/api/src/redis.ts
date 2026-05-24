import { createClient, type RedisClientType } from 'redis';
import { config } from './config';

type RedisRole = 'session' | 'cache';

interface RedisPool {
  client: RedisClientType | null;
  reconnectAttempts: number;
  lastHealthCheck: number;
  isHealthy: boolean;
}

const HEALTH_CHECK_INTERVAL = 5_000;
const MAX_RECONNECT_ATTEMPTS = 5;
const INITIAL_RECONNECT_DELAY = 1000;

const pools: Record<RedisRole, RedisPool> = {
  session: { client: null, reconnectAttempts: 0, lastHealthCheck: 0, isHealthy: false },
  cache: { client: null, reconnectAttempts: 0, lastHealthCheck: 0, isHealthy: false },
};

async function isHealthy(client: RedisClientType): Promise<boolean> {
  try {
    await client.ping();
    return true;
  } catch {
    return false;
  }
}

function getRedisUrl(role: RedisRole): string | undefined {
  if (role === 'session') {
    return config.redisSessionUrl;
  }
  return config.redisCacheUrl;
}

async function connectRedis(role: RedisRole): Promise<RedisClientType | null> {
  const url = getRedisUrl(role);
  if (!url) {
    return null;
  }

  const pool = pools[role];

  if (pool.client) {
    const now = Date.now();
    if (pool.isHealthy && now - pool.lastHealthCheck < HEALTH_CHECK_INTERVAL) {
      return pool.client;
    }

    pool.lastHealthCheck = now;
    if (await isHealthy(pool.client)) {
      pool.isHealthy = true;
      pool.reconnectAttempts = 0;
      return pool.client;
    }
    pool.isHealthy = false;
    const staleClient = pool.client;
    pool.client = null;
    try {
      await staleClient.disconnect();
    } catch {
      // ignore disconnect errors on stale client
    }
  }

  if (pool.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error(`[Redis:${role}] Max reconnection attempts reached, giving up`);
    return null;
  }

  const delay = INITIAL_RECONNECT_DELAY * Math.pow(2, pool.reconnectAttempts);
  if (pool.reconnectAttempts > 0) {
    console.log(
      `[Redis:${role}] Reconnection attempt ${pool.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}, delay ${delay}ms`
    );
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  try {
    const newClient = createClient({
      url,
      socket: {
        connectTimeout: 3000,
        reconnectStrategy: false,
      },
    });

    await newClient.connect();

    pool.client = newClient as RedisClientType;
    pool.reconnectAttempts = 0;
    pool.isHealthy = true;
    pool.lastHealthCheck = Date.now();
    console.log(`[Redis:${role}] Connected successfully`);
    return pool.client;
  } catch (error) {
    pool.reconnectAttempts++;
    console.error(
      `[Redis:${role}] Connection attempt ${pool.reconnectAttempts} failed:`,
      error instanceof Error ? error.message : 'Unknown error'
    );
    pool.client = null;
    return null;
  }
}

/** Session/operational Redis — auth sessions, rate limits, challenges. */
export const getRedisSession = (): Promise<RedisClientType | null> => connectRedis('session');

/** Cache Redis — git metadata, API response cache, repo/user lookups. */
export const getRedisCache = (): Promise<RedisClientType | null> => connectRedis('cache');

/** @deprecated Use getRedisSession() */
export const getRedis = getRedisSession;

/** @deprecated Use getRedisSession() */
export const getRedisClient = getRedisSession;

export const initializeRedis = async (): Promise<RedisClientType> => {
  if (!config.redisSessionUrl) {
    throw new Error('REDIS_SESSION_URL (or REDIS_URL) is not configured');
  }

  const client = await getRedisSession();
  if (!client) {
    throw new Error('Failed to connect to Redis session store');
  }

  return client;
};

export const CACHE_TTL = {
  session: 60 * 60,
  gitObject: 60 * 60 * 24,
  refs: 60 * 5,
  branches: 60 * 5,
  tree: 60 * 30,
  file: 60 * 60,
  commits: 60 * 10,
  user: 60 * 5,
  repoSlug: 60 * 5,
  platformStats: 60,
  systemSetting: 30,
  profileResolve: 60 * 2,
} as const;

function cacheKey(type: string, ...parts: string[]): string {
  return `sigmagit:${type}:${parts.join(':')}`;
}

export async function getCached<T>(key: string): Promise<T | null> {
  const client = await getRedisCache();
  if (!client) return null;

  try {
    const data = await client.get(key);
    if (data) {
      return JSON.parse(data) as T;
    }
  } catch {
    // ignore cache read errors
  }
  return null;
}

export async function setCache<T>(key: string, value: T, ttl: number): Promise<void> {
  const client = await getRedisCache();
  if (!client) return;

  try {
    await client.set(key, JSON.stringify(value), { EX: ttl });
  } catch {
    // ignore cache write errors
  }
}

export async function deleteCache(key: string): Promise<void> {
  const client = await getRedisCache();
  if (!client) return;

  try {
    await client.del(key);
  } catch {
    // ignore cache delete errors
  }
}

export async function deleteCachePattern(pattern: string): Promise<void> {
  const client = await getRedisCache();
  if (!client) return;

  try {
    let cursor = '0';
    const SCAN_BATCH_SIZE = 100;
    let totalDeleted = 0;

    do {
      const result = await client.scan(cursor, {
        MATCH: pattern,
        COUNT: SCAN_BATCH_SIZE,
      });

      cursor = result.cursor;
      const keys = result.keys;

      if (keys.length > 0) {
        await client.del(keys);
        totalDeleted += keys.length;
      }

      if (cursor === '0') break;
    } while (cursor !== '0');

    if (totalDeleted > 0) {
      console.log(`[Cache] Deleted ${totalDeleted} keys for pattern ${pattern}`);
    }
  } catch (error) {
    console.error('[Cache] Error deleting pattern:', error);
  }
}

export const appCache = {
  userKey: (userId: string) => cacheKey('user', userId),
  repoSlugKey: (ownerSlug: string, repoName: string) =>
    cacheKey('repo-slug', ownerSlug, repoName.replace(/\.git$/, '')),
  platformStatsKey: () => cacheKey('platform-stats'),
  systemSettingKey: (key: string) => cacheKey('system', key),
  profileResolveKey: (username: string) => cacheKey('profile-resolve', username),

  async invalidateUser(userId: string): Promise<void> {
    await deleteCache(appCache.userKey(userId));
  },

  async invalidateRepoSlug(ownerSlug: string, repoName: string): Promise<void> {
    await deleteCache(appCache.repoSlugKey(ownerSlug, repoName));
  },

  async invalidatePlatformStats(): Promise<void> {
    await deleteCache(appCache.platformStatsKey());
  },

  async invalidateSystemSetting(key: string): Promise<void> {
    await deleteCache(appCache.systemSettingKey(key));
  },

  async invalidateProfileResolve(username: string): Promise<void> {
    await deleteCache(appCache.profileResolveKey(username));
  },
};

export const repoCache = {
  branchesKey: (userId: string, repoName: string) => cacheKey('branches', userId, repoName),

  commitsKey: (userId: string, repoName: string, branch: string, limit: number, skip: number) =>
    cacheKey('commits', userId, repoName, branch, String(limit), String(skip)),

  commitCountKey: (userId: string, repoName: string, branch: string) =>
    cacheKey('commit-count', userId, repoName, branch),

  treeKey: (userId: string, repoName: string, branch: string, path: string) =>
    cacheKey('tree', userId, repoName, branch, path || 'root'),

  fileKey: (userId: string, repoName: string, branch: string, path: string) =>
    cacheKey('file', userId, repoName, branch, path),

  refKey: (userId: string, repoName: string, ref: string) => cacheKey('ref', userId, repoName, ref),

  async invalidateRepo(userId: string, repoName: string): Promise<void> {
    await deleteCachePattern(`sigmagit:*:${userId}:${repoName}:*`);
    await deleteCachePattern(`sigmagit:*:${userId}:${repoName}`);
  },

  async invalidateBranch(userId: string, repoName: string, branch: string): Promise<void> {
    await deleteCachePattern(`sigmagit:commits:${userId}:${repoName}:${branch}:*`);
    await deleteCache(repoCache.commitCountKey(userId, repoName, branch));
    await deleteCachePattern(`sigmagit:tree:${userId}:${repoName}:${branch}:*`);
    await deleteCachePattern(`sigmagit:file:${userId}:${repoName}:${branch}:*`);
    await deleteCache(repoCache.refKey(userId, repoName, branch));
    await deleteCache(repoCache.branchesKey(userId, repoName));
  },
};
