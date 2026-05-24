import { createMiddleware } from 'hono/factory';

const DEFAULT_TIMEOUT_MS = 30_000;
const LONG_RUNNING_PATHS = [
  '/git-upload-pack',
  '/git-receive-pack',
  '/info/refs',
  '/v2/',
];

function isLongRunningPath(path: string): boolean {
  return LONG_RUNNING_PATHS.some((segment) => path.includes(segment));
}

export function requestTimeoutMiddleware(timeoutMs = DEFAULT_TIMEOUT_MS) {
  return createMiddleware(async (c, next) => {
    if (isLongRunningPath(c.req.path)) {
      await next();
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      await Promise.race([
        next(),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () => {
            reject(new Error('Request timeout'));
          });
        }),
      ]);
    } catch (error) {
      if (error instanceof Error && error.message === 'Request timeout') {
        return c.json({ error: 'Request timeout' }, 504);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  });
}
