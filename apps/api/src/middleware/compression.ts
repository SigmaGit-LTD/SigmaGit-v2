import { createMiddleware } from 'hono/factory';
import { createGzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { MAX_COMPRESS_BYTES } from './limits';

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

function gzipWebStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const nodeReadable = Readable.fromWeb(body);
  const gzip = createGzip();
  const compressed = nodeReadable.pipe(gzip);
  return Readable.toWeb(compressed) as ReadableStream<Uint8Array>;
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

  const contentLengthHeader = c.res.headers.get('content-length');
  if (contentLengthHeader) {
    const contentLength = parseInt(contentLengthHeader, 10);
    if (!Number.isNaN(contentLength)) {
      if (contentLength < MIN_SIZE || contentLength > MAX_COMPRESS_BYTES) {
        return;
      }
    }
  }

  const originalBody = c.res.body;
  if (!originalBody) {
    return;
  }

  const compressedStream = gzipWebStream(originalBody);
  const headers = new Headers(c.res.headers);
  headers.set('Content-Encoding', 'gzip');
  headers.delete('content-length');
  headers.delete('transfer-encoding');

  c.res = new Response(compressedStream, {
    status: c.res.status,
    statusText: c.res.statusText,
    headers,
  });
});
