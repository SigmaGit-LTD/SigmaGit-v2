import { createClient, type RedisClientType } from "redis";
import { config } from "./config";

let redis: RedisClientType | null = null;
let reconnectAttempts = 0;
let lastHealthCheck = 0;
let isRedisHealthy = false;
const HEALTH_CHECK_INTERVAL = 5_000;
const MAX_RECONNECT_ATTEMPTS = 5;
const INITIAL_RECONNECT_DELAY = 1000;

async function isHealthy(client: RedisClientType): Promise<boolean> {
  try {
    await client.ping();
    return true;
  } catch {
    return false;
  }
}

export const getRedis = async (): Promise<RedisClientType | null> => {
  if (!config.redisUrl) {
    return null;
  }

  if (redis) {
    const now = Date.now();
    if (isRedisHealthy && (now - lastHealthCheck) < HEALTH_CHECK_INTERVAL) {
      return redis;
    }

    lastHealthCheck = now;
    if (await isHealthy(redis)) {
      isRedisHealthy = true;
      reconnectAttempts = 0;
      return redis;
    }
    isRedisHealthy = false;
  }

  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error("[Redis] Max reconnection attempts reached, giving up");
    return null;
  }

  const delay = INITIAL_RECONNECT_DELAY * Math.pow(2, reconnectAttempts);

  if (reconnectAttempts > 0) {
    console.log(`[Redis] Reconnection attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}, delay ${delay}ms`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  try {
    const newClient = createClient({
      url: config.redisUrl,
      socket: {
        connectTimeout: 3000,
        reconnectStrategy: false,
      },
    });

    await newClient.connect();

    redis = newClient as RedisClientType;
    reconnectAttempts = 0;
    isRedisHealthy = true;
    lastHealthCheck = Date.now();
    console.log("[Redis] Connected successfully");
    return redis;
  } catch (error) {
    reconnectAttempts++;
    console.error(`[Redis] Connection attempt ${reconnectAttempts} failed:`, error instanceof Error ? error.message : "Unknown error");
    redis = null;
    return null;
  }
};

/** @deprecated Use getRedis() */
export const getRedisClient = getRedis;

export const initializeRedis = async (): Promise<RedisClientType> => {
  if (!config.redisUrl) {
    throw new Error("REDIS_URL is not configured");
  }

  const client = await getRedis();
  if (!client) {
    throw new Error("Failed to connect to Redis");
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
} as const;

function cacheKey(type: string, ...parts: string[]): string {
  return `sigmagit:${type}:${parts.join(":")}`;
}

export async function getCached<T>(key: string): Promise<T | null> {
  const client = await getRedis();
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
  const client = await getRedis();
  if (!client) return;

  try {
    await client.set(key, JSON.stringify(value), { EX: ttl });
  } catch {
    // ignore cache write errors
  }
}

export async function deleteCache(key: string): Promise<void> {
  const client = await getRedis();
  if (!client) return;

  try {
    await client.del(key);
  } catch {
    // ignore cache delete errors
  }
}

export async function deleteCachePattern(pattern: string): Promise<void> {
  const client = await getRedis();
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

export const repoCache = {
  branchesKey: (userId: string, repoName: string) =>
    cacheKey("branches", userId, repoName),

  commitsKey: (userId: string, repoName: string, branch: string, limit: number, skip: number) =>
    cacheKey("commits", userId, repoName, branch, String(limit), String(skip)),

  commitCountKey: (userId: string, repoName: string, branch: string) =>
    cacheKey("commit-count", userId, repoName, branch),

  treeKey: (userId: string, repoName: string, branch: string, path: string) =>
    cacheKey("tree", userId, repoName, branch, path || "root"),

  fileKey: (userId: string, repoName: string, branch: string, path: string) =>
    cacheKey("file", userId, repoName, branch, path),

  refKey: (userId: string, repoName: string, ref: string) =>
    cacheKey("ref", userId, repoName, ref),

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

