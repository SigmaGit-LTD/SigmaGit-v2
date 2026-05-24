import { createMiddleware } from 'hono/factory';

const MAX_REQUEST_SIZE = 100 * 1024 * 1024; // 100MB
const MAX_RESPONSE_SIZE = 50 * 1024 * 1024; // 50MB
const MEMORY_THRESHOLD = 0.92; // 92% of heap
// Don't reject based on ratio alone until the heap is meaningfully large.
// Bun starts with a small heap that grows on demand, so heapUsed/heapTotal
// can spike above 80% at startup even when there's no real memory pressure.
// Set to 1GB so we only start rejecting when we're truly close to 2GB ceiling.
const MIN_HEAP_TO_ENFORCE = 1024 * 1024 * 1024; // 1 GB
export const GIT_PUSH_SIZE_LIMIT = 100 * 1024 * 1024; // 100MB
export const GIT_MAX_OBJECTS_PER_PUSH = 50000;
export const GIT_MAX_UPLOAD_PACK_OBJECTS = 10000;
export const GIT_MAX_DELTA_DEPTH = 100;
export const GIT_MAX_OBJECT_BYTES = 10 * 1024 * 1024; // 10MB per object in pack
export const MAX_FILE_CACHE_BYTES = 256 * 1024; // 256KB — skip Redis cache above this
export const MAX_FILE_SERVE_BYTES = 1024 * 1024; // 1MB — refuse to load larger blobs as text
export const MAX_COMPRESS_BYTES = 256 * 1024; // skip gzip when Content-Length exceeds this
export const MAX_DIFF_FILES = 100;
export const MAX_DIFF_FILE_BYTES = 512 * 1024; // 512KB inflated text per file
export const MAX_DIFF_LINES = 5000; // max lines diffed per file
export const REGISTRY_MAX_CHUNK_BYTES = 50 * 1024 * 1024; // 50MB per upload chunk
export const REGISTRY_MAX_BLOB_BYTES = 512 * 1024 * 1024; // 512MB total blob
export const MAX_LOCAL_LIST_KEYS = 10_000;

export function shouldRejectRequest(): boolean {
  try {
    const usage = process.memoryUsage();
    const total = usage.heapTotal;
    const used = usage.heapUsed;
    // Only enforce the threshold once the heap has grown to a meaningful size,
    // otherwise Bun's small startup heap makes the ratio always look critical.
    return total >= MIN_HEAP_TO_ENFORCE && (used / total) > MEMORY_THRESHOLD;
  } catch {
    return false;
  }
}

export function getMemoryUsage(): { used: number; total: number; percent: number } {
  const usage = process.memoryUsage();
  const used = usage.heapUsed;
  const total = usage.heapTotal;
  // In Bun/Node.js, heapUsed can exceed heapTotal during heap growth
  // This is normal - cap the percentage at 1.0 for display purposes
  const percent = total > 0 ? Math.min(used / total, 1.0) : 0;
  return {
    used,
    total,
    percent,
  };
}

export const memoryMiddleware = createMiddleware(async (c, next) => {
  if (shouldRejectRequest()) {
    console.warn('[Memory] Threshold exceeded, rejecting request');
    return c.json({ error: 'Server busy, please try again later' }, 503);
  }

  await next();
});

export const requestSizeMiddleware = createMiddleware(async (c, next) => {
  const contentLength = c.req.header('content-length');

  if (contentLength) {
    const size = parseInt(contentLength, 10);

    if (size > MAX_REQUEST_SIZE) {
      console.warn(`[Request] Size ${size} exceeds limit ${MAX_REQUEST_SIZE}`);
      return c.json({ error: 'Request body too large' }, 413);
    }

    const path = c.req.path;

    if (path.includes('git-receive-pack') && size > GIT_PUSH_SIZE_LIMIT) {
      console.warn(`[Git] Push size ${size} exceeds limit ${GIT_PUSH_SIZE_LIMIT}`);
      return c.json({ error: 'Git pack too large, maximum is 100MB' }, 413);
    }
  }

  await next();
});

export const responseSizeMiddleware = createMiddleware(async (c, next) => {
  await next();

  const responseSize = c.res.headers.get('content-length');

  if (responseSize) {
    const size = parseInt(responseSize, 10);

    if (size > MAX_RESPONSE_SIZE) {
      console.warn(`[Response] Size ${size} exceeds limit ${MAX_RESPONSE_SIZE}`);
    }
  }
});

export const gitLimitsMiddleware = createMiddleware(async (c, next) => {
  const path = c.req.path;

  if (path.includes('git-receive-pack')) {
    c.set('maxObjects', GIT_MAX_OBJECTS_PER_PUSH);
    c.set('maxDeltaDepth', GIT_MAX_DELTA_DEPTH);
  }

  await next();
});

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMsg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(errorMsg));
    }, timeoutMs);

    promise
      .then(resolve)
      .catch(reject)
      .finally(() => {
        clearTimeout(timeoutId);
      });
  });
}

export async function measureMemory<T>(fn: () => Promise<T>, label: string): Promise<T> {
  const before = process.memoryUsage();

  try {
    const result = await fn();
    const after = process.memoryUsage();
    const delta = after.heapUsed - before.heapUsed;

    console.log(`[Memory] ${label}: ${(delta / 1024 / 1024).toFixed(2)} MB delta`);

    return result;
  } catch (error) {
    const after = process.memoryUsage();
    const delta = after.heapUsed - before.heapUsed;

    console.log(`[Memory] ${label} (error): ${(delta / 1024 / 1024).toFixed(2)} MB delta`);

    throw error;
  }
}

export function scheduleGC() {
  if (global.gc) {
    global.gc();
  }
}

export function forceGCIfNeeded(): void {
  const usage = getMemoryUsage();

  if (usage.percent > 0.90) {
    console.warn(`[Memory] Usage at ${(usage.percent * 100).toFixed(2)}%, forcing GC`);
    scheduleGC();
  }
}
