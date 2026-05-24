import { createMiddleware } from 'hono/factory';
import { gzipSync } from 'zlib';

const COMPRESSIBLE = /^application\/(json|javascript|xml)|^text\//i;
const MIN_SIZE = 1024;

const SKIP_PATH_PREFIXES = ['/v2/', '/file/', '/ws'];
const GIT_PATH_PATTERN = /\.git(\/|$)/;

function shouldSkipCompression(path: string): boolean {
  if (SKIP_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return true;
  }
  return GIT_PATH_PATTERN.test(path);
}

export const compressionMiddleware = createMiddleware(async (c, next) => {
  await next();

  if (shouldSkipCompression(c.req.path)) {
    return;
  }

  const acceptEncoding = c.req.header('accept-encoding') || '';
  if (!acceptEncoding.includes('gzip')) {
    return;
  }

  const contentType = c.res.headers.get('content-type') || '';
  if (!COMPRESSIBLE.test(contentType)) {
    return;
  }

  const body = await c.res.arrayBuffer();
  if (body.byteLength < MIN_SIZE) {
    return;
  }

  const compressed = gzipSync(Buffer.from(body));
  c.res = new Response(compressed, {
    status: c.res.status,
    statusText: c.res.statusText,
    headers: c.res.headers,
  });
  c.res.headers.set('Content-Encoding', 'gzip');
  c.res.headers.set('Content-Length', String(compressed.length));
  c.res.headers.delete('transfer-encoding');
});
