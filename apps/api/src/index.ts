import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { config, getAllowedOrigins } from "./config";
import { initAuth } from "./auth";
import { getRedis } from "./redis";
import { mountRoutes } from "./routes";
import { handleWebSocketUpgrade, websocketHandlers } from "./websocket";
import {
  memoryMiddleware,
  requestSizeMiddleware,
  gitLimitsMiddleware,
  responseSizeMiddleware,
} from "./middleware/limits";
import rateLimitMiddleware, { concurrencyLimiter } from "./middleware/rate-limit";
import { authMiddleware } from "./middleware/auth";
import { requestIdMiddleware } from "./middleware/request-id";
import { requestTimeoutMiddleware } from "./middleware/timeout";
import { compressionMiddleware } from "./middleware/compression";
import { startMigrationWorker } from "./workers/migration";
import { startRunnerHealthWorker } from "./workers/runner-health";
import "./monitoring";

if (config.redisUrl) {
  const redis = await getRedis();
  if (redis) {
    const role = await redis.info("replication").then(info => info.includes("role:master") ? "master" : "replica").catch(() => "unknown");
    console.log(`[Redis] Connected successfully (role: ${role})`);
  } else {
    console.log("[Redis] Connection failed, will retry on first request");
  }
} else {
  console.log("[Redis] REDIS_URL not configured, running without cache");
}

const app = new Hono();

const loggingMiddleware = createMiddleware(async (c, next) => {
  const start = Date.now();
  const method = c.req.method;
  const path = c.req.path;
  const queryPos = c.req.url.indexOf('?');
  const query = queryPos >= 0 ? c.req.url.slice(queryPos) : '';

  await next();

  const status = c.res.status;
  const duration = Date.now() - start;
  const contentLength = c.res.headers.get("content-length") || "-";

  const skipLogging = path === "/health" || path === "/api/health";
  if (!skipLogging) {
    const statusColor =
      status >= 500 ? "\x1b[31m" : status >= 400 ? "\x1b[33m" : status >= 300 ? "\x1b[36m" : "\x1b[32m";
    const resetColor = "\x1b[0m";
    console.log(
      `[API] ${method} ${path}${query} ${statusColor}${status}${resetColor} ${duration}ms ${contentLength}b`
    );
  }
});

app.use("*", requestIdMiddleware);
app.use("*", loggingMiddleware);

app.use("*", createMiddleware(async (c, next) => {
  const origin = c.req.header("origin");
  const allowedOrigins = getAllowedOrigins();
  const isAllowed = origin && allowedOrigins.includes(origin);
  const responseOrigin = isAllowed ? origin : (allowedOrigins[0] || "");

  c.header("Access-Control-Allow-Origin", responseOrigin);
  c.header("Access-Control-Allow-Credentials", "true");
  c.header("Vary", "Origin");

  await next();
}));

app.use("*", createMiddleware(async (c, next) => {
  await initAuth();
  await next();
}));

app.use("*", authMiddleware);
app.use("*", concurrencyLimiter());
app.use("*", memoryMiddleware);
app.use("*", requestSizeMiddleware);
app.use("*", gitLimitsMiddleware);
app.use("*", requestTimeoutMiddleware());
app.use("*", rateLimitMiddleware);
app.use("*", responseSizeMiddleware);
app.use("*", compressionMiddleware);

mountRoutes(app);

if (config.enableMigrations) {
  startMigrationWorker();
}

startRunnerHealthWorker();

const port = config.port;

export default {
  port,
  fetch: async (request: Request, server: any) => {
    if (request.method === "OPTIONS") {
      const origin = request.headers.get("origin");
      const allowedOrigins = getAllowedOrigins();
      const isAllowed = origin && allowedOrigins.includes(origin);
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": isAllowed ? origin : (allowedOrigins[0] ?? ""),
          "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, Cookie, x-internal-auth, X-Webhook-Secret, X-Request-Id",
          "Access-Control-Allow-Credentials": "true",
          "Access-Control-Max-Age": "300",
        },
      });
    }

    const wsResponse = await handleWebSocketUpgrade(request, server);
    if (wsResponse !== undefined) {
      return wsResponse;
    }

    return app.fetch(request);
  },
  websocket: websocketHandlers,
  idleTimeout: 255,
};
