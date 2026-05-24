import { createMiddleware } from 'hono/factory';

export const requestIdMiddleware = createMiddleware(async (c, next) => {
  const incoming = c.req.header('x-request-id');
  const requestId = incoming && incoming.trim() !== '' ? incoming.trim() : crypto.randomUUID();
  c.set('requestId' as never, requestId as never);
  c.header('X-Request-Id', requestId);
  await next();
});
