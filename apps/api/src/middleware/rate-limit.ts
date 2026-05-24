import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import {
  RateLimiterRedis,
  RateLimiterMemory,
  RateLimiterAbstract,
  RateLimiterRes,
} from 'rate-limiter-flexible';
import { config } from '../config';
import { getRedisSession } from '../redis';
import type { AuthVariables } from './auth';

type RateLimitContext = Context<{ Variables: AuthVariables }>;

export type RateLimitTier = 'general' | 'auth' | 'write' | 'search' | 'unauth' | 'api-key';

interface RateLimitConfig {
  keyPrefix: string;
  points: number;
  duration: number;
  blockDuration: number;
}

const RATE_LIMIT_CONFIGS: Record<RateLimitTier, RateLimitConfig> = {
  general: {
    keyPrefix: 'rl_general',
    points: config.rateLimit.general,
    duration: 60,
    blockDuration: 0,
  },
  auth: {
    keyPrefix: 'rl_auth',
    points: config.rateLimit.auth,
    duration: 60,
    blockDuration: 3600,
  },
  write: {
    keyPrefix: 'rl_write',
    points: config.rateLimit.write,
    duration: 60,
    blockDuration: 1800,
  },
  search: {
    keyPrefix: 'rl_search',
    points: config.rateLimit.search,
    duration: 60,
    blockDuration: 0,
  },
  unauth: {
    keyPrefix: 'rl_unauth',
    points: config.rateLimit.unauth,
    duration: 60,
    blockDuration: 0,
  },
  'api-key': {
    keyPrefix: 'rl_apikey',
    points: config.rateLimit.apiKey,
    duration: 60,
    blockDuration: 0,
  },
};

const limiters = new Map<RateLimitTier, RateLimiterAbstract>();

async function getLimiter(tier: RateLimitTier): Promise<RateLimiterAbstract> {
  const existing = limiters.get(tier);
  if (existing) return existing;

  const tierConfig = RATE_LIMIT_CONFIGS[tier];
  const redis = await getRedisSession();

  let limiter: RateLimiterAbstract;

  if (redis) {
    limiter = new RateLimiterRedis({
      storeClient: redis,
      keyPrefix: tierConfig.keyPrefix,
      points: tierConfig.points,
      duration: tierConfig.duration,
      blockDuration: tierConfig.blockDuration,
      useRedisPackage: true,
    });
  } else {
    limiter = new RateLimiterMemory({
      keyPrefix: tierConfig.keyPrefix,
      points: tierConfig.points,
      duration: tierConfig.duration,
      blockDuration: tierConfig.blockDuration,
    });
  }

  limiters.set(tier, limiter);
  return limiter;
}

function isGitProtocolPath(path: string): boolean {
  return (
    path.includes('info/refs') ||
    path.includes('git-upload-pack') ||
    path.includes('git-receive-pack')
  );
}

function isRunnerHeartbeat(path: string): boolean {
  return /^\/api\/runners\/[^/]+\/heartbeat$/.test(path);
}

function isExcludedPath(path: string): boolean {
  if (path === '/health' || path === '/api/health' || path === '/api/status' || path === '/ws') {
    return true;
  }
  if (path.startsWith('/api/internal/')) {
    return true;
  }
  if (isGitProtocolPath(path)) {
    return true;
  }
  if (isRunnerHeartbeat(path)) {
    return true;
  }
  return false;
}

function hasSessionCookie(c: RateLimitContext): boolean {
  const cookieHeader = c.req.header('cookie');
  if (!cookieHeader) return false;
  return cookieHeader.includes('sigmagit');
}

function isAuthenticated(c: RateLimitContext): boolean {
  const user = c.get('user');
  if (user) return true;
  if (c.req.header('x-api-key')) return true;
  return hasSessionCookie(c);
}

export function getClientIp(c: RateLimitContext): string {
  if (config.trustProxy) {
    const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (forwarded) return forwarded;
  }

  return c.req.header('x-real-ip') || c.req.header('cf-connecting-ip') || 'unknown';
}

export function resolveRateLimitTier(c: RateLimitContext): RateLimitTier | null {
  const path = c.req.path;
  const method = c.req.method;

  if (isExcludedPath(path)) {
    return null;
  }

  if (path.startsWith('/api/auth/')) {
    return 'auth';
  }

  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    return 'write';
  }

  if (method === 'GET' && path.startsWith('/api/search')) {
    return 'search';
  }

  if (isAuthenticated(c)) {
    return 'general';
  }

  return 'unauth';
}

function getRateLimitKey(c: RateLimitContext, tier: RateLimitTier): string {
  if (tier === 'auth' || tier === 'unauth') {
    return getClientIp(c);
  }

  const user = c.get('user');
  if (user) {
    return `user:${user.id}`;
  }

  if (c.req.header('x-api-key')) {
    return `apikey:${c.req.header('x-api-key')}`;
  }

  if (hasSessionCookie(c)) {
    return `session:${getClientIp(c)}`;
  }

  return getClientIp(c);
}

function setRateLimitHeaders(c: RateLimitContext, res: RateLimiterRes, tierConfig: RateLimitConfig) {
  c.header('RateLimit-Limit', String(tierConfig.points));
  c.header('RateLimit-Remaining', String(Math.max(0, res.remainingPoints)));
  c.header('RateLimit-Reset', String(Math.ceil(res.msBeforeNext / 1000)));
  c.header('RateLimit-Policy', `${tierConfig.points};w=${tierConfig.duration}`);
}

function rateLimitExceeded(c: RateLimitContext, res: RateLimiterRes) {
  const retryAfter = Math.ceil(res.msBeforeNext / 1000);
  c.header('Retry-After', String(retryAfter));
  return c.json({ error: 'Too many requests', retryAfter }, 429);
}

type ConsumeResult =
  | { status: 'ok' }
  | { status: 'limited'; res: RateLimiterRes }
  | { status: 'error' };

async function consumeTier(c: RateLimitContext, tier: RateLimitTier): Promise<ConsumeResult> {
  const limiter = await getLimiter(tier);
  const tierConfig = RATE_LIMIT_CONFIGS[tier];
  const key = getRateLimitKey(c, tier);

  try {
    const res = await limiter.consume(key);
    setRateLimitHeaders(c, res, tierConfig);
    return { status: 'ok' };
  } catch (err) {
    if (err instanceof RateLimiterRes) {
      setRateLimitHeaders(c, err, tierConfig);
      return { status: 'limited', res: err };
    }
    console.error(`[RateLimit] Limiter error (${tier}):`, err);
    return { status: 'error' };
  }
}

async function getAuthLimiterState(c: RateLimitContext): Promise<RateLimiterRes | null> {
  try {
    const limiter = await getLimiter('auth');
    const res = await limiter.get(getClientIp(c));
    if (!res) return null;

    setRateLimitHeaders(c, res, RATE_LIMIT_CONFIGS.auth);
    if (res.remainingPoints <= 0) {
      return res;
    }
    return null;
  } catch (err) {
    if (err instanceof RateLimiterRes) {
      setRateLimitHeaders(c, err, RATE_LIMIT_CONFIGS.auth);
      return err;
    }
    console.error('[RateLimit] Auth pre-check error:', err);
    return null;
  }
}

async function consumeAuthOnFailure(c: RateLimitContext): Promise<void> {
  const limiter = await getLimiter('auth');
  const tierConfig = RATE_LIMIT_CONFIGS.auth;
  const key = getClientIp(c);

  try {
    const res = await limiter.consume(key);
    setRateLimitHeaders(c, res, tierConfig);
  } catch (err) {
    if (err instanceof RateLimiterRes) {
      setRateLimitHeaders(c, err, tierConfig);
      return;
    }
    console.error('[RateLimit] Auth failure limiter error:', err);
  }
}

async function handleAuthTier(c: RateLimitContext, next: () => Promise<void>) {
  const blocked = await getAuthLimiterState(c);
  if (blocked) {
    return rateLimitExceeded(c, blocked);
  }

  await next();

  const status = c.res.status;
  if (status >= 400 && status < 500) {
    await consumeAuthOnFailure(c);
  }
}

function createTierRateLimiter(tier: RateLimitTier, skipPaths: string[] = []) {
  return createMiddleware(async (c, next) => {
    const path = c.req.path;
    if (skipPaths.some((p) => path === p || path.startsWith(p))) {
      await next();
      return;
    }

    const result = await consumeTier(c, tier);
    if (result.status === 'limited') {
      return rateLimitExceeded(c, result.res);
    }

    await next();
  });
}

export const rateLimitMiddleware = createMiddleware(async (c, next) => {
  const tier = resolveRateLimitTier(c);

  if (!tier) {
    await next();
    return;
  }

  if (tier === 'auth') {
    return handleAuthTier(c, next);
  }

  const result = await consumeTier(c, tier);
  if (result.status === 'limited') {
    return rateLimitExceeded(c, result.res);
  }

  await next();
});

export const authRateLimitOnFailure = createMiddleware(async (c, next) => {
  if (!c.req.path.startsWith('/api/auth/')) {
    await next();
    return;
  }

  return handleAuthTier(c, next);
});

export const generalRateLimit = rateLimitMiddleware;
export const authRateLimit = createTierRateLimiter('auth', ['/ws']);
export const writeRateLimit = createTierRateLimiter('write', ['/ws']);

export const apiKeyRateLimit = createMiddleware(async (c, next) => {
  const apiKey = c.req.header('x-api-key');
  if (!apiKey) {
    await next();
    return;
  }

  const limiter = await getLimiter('api-key');
  const tierConfig = RATE_LIMIT_CONFIGS['api-key'];

  try {
    const res = await limiter.consume(`apikey:${apiKey}`);
    setRateLimitHeaders(c, res, tierConfig);
    await next();
  } catch (err) {
    if (err instanceof RateLimiterRes) {
      setRateLimitHeaders(c, err, tierConfig);
      const retryAfter = Math.ceil(err.msBeforeNext / 1000);
      c.header('Retry-After', String(retryAfter));
      return c.json({ error: 'API key rate limit exceeded', retryAfter }, 429);
    }
    console.error('[RateLimit] API key limiter error:', err);
    await next();
  }
});

export function unauthenticatedRateLimit() {
  return createMiddleware(async (c, next) => {
    if (isExcludedPath(c.req.path) || isAuthenticated(c)) {
      await next();
      return;
    }

    const result = await consumeTier(c, 'unauth');
    if (result.status === 'limited') {
      return rateLimitExceeded(c, result.res);
    }

    await next();
  });
}

let activeRestRequests = 0;
let activeGitRequests = 0;

function isConcurrencyExcludedPath(path: string): boolean {
  return (
    path === '/health' ||
    path === '/api/health' ||
    path === '/api/status' ||
    path === '/ws'
  );
}

export function concurrencyLimiter() {
  return createMiddleware(async (c, next) => {
    const path = c.req.path;

    if (isConcurrencyExcludedPath(path)) {
      await next();
      return;
    }

    const isGit = isGitProtocolPath(path);
    const maxConcurrent = isGit ? config.maxConcurrentGit : config.maxConcurrentRest;
    const activeCount = isGit ? activeGitRequests : activeRestRequests;

    if (activeCount >= maxConcurrent) {
      return c.json({ error: 'Server busy, try again later', retryAfter: 5 }, 503);
    }

    if (isGit) {
      activeGitRequests++;
    } else {
      activeRestRequests++;
    }

    try {
      await next();
    } finally {
      if (isGit) {
        activeGitRequests--;
      } else {
        activeRestRequests--;
      }
    }
  });
}

export default rateLimitMiddleware;
