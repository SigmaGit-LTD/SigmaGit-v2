import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { getObject, listObjects } from "../s3";
import { db, users, repositories, organizations, systemSettings } from "@sigmagit/db";
import { eq, and } from "drizzle-orm";
import { config } from "../config";
import { authMiddleware, requireAdmin, type AuthVariables } from "../middleware/auth";
import { appCache, CACHE_TTL, getCached, setCache } from "../redis";

const app = new Hono<{ Variables: AuthVariables }>();

app.get("/health", async (c) => {
  return c.json({ status: "ok", version: "1.0.0" });
});

app.get("/api/health", async (c) => {
  return c.json({ status: "ok", version: "1.0.0" });
});

// Public status (maintenance mode) - no auth, so app can gate non-admin users
app.get("/api/status", async (c) => {
  const cached = await getCached<{ maintenanceMode: boolean }>(appCache.systemSettingKey("maintenance_mode"));
  if (cached) {
    return c.json(cached);
  }

  const row = await db
    .select({ value: systemSettings.value })
    .from(systemSettings)
    .where(eq(systemSettings.key, "maintenance_mode"))
    .limit(1);
  const maintenanceMode = row[0]?.value === true;
  const payload = { maintenanceMode: !!maintenanceMode };
  await setCache(appCache.systemSettingKey("maintenance_mode"), payload, CACHE_TTL.systemSetting);
  return c.json(payload);
});

// Public platform stats (no auth) - mounted on health so it is never behind admin/auth middleware
app.get("/api/stats/platform", async (c) => {
  const cached = await getCached<{
    developers: number;
    repositories: number;
    organizations: number;
    uptimeSeconds: number;
    generatedAt: string;
  }>(appCache.platformStatsKey());

  if (cached) {
    return c.json({
      ...cached,
      uptimeSeconds: Math.floor(process.uptime()),
    });
  }

  const [userCountRow, publicRepoCountRow, organizationCountRow] = await Promise.all([
    db.select({ count: sql<number>`COUNT(*)::int` }).from(users),
    db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(repositories)
      .where(sql`${repositories.visibility} = 'public'`),
    db.select({ count: sql<number>`COUNT(*)::int` }).from(organizations),
  ]);

  const payload = {
    developers: Number(userCountRow[0]?.count ?? 0),
    repositories: Number(publicRepoCountRow[0]?.count ?? 0),
    organizations: Number(organizationCountRow[0]?.count ?? 0),
    uptimeSeconds: Math.floor(process.uptime()),
    generatedAt: new Date().toISOString(),
  };

  await setCache(appCache.platformStatsKey(), payload, CACHE_TTL.platformStats);
  return c.json(payload);
});

app.get("/api/debug/repo/:owner/:name", authMiddleware, requireAdmin, async (c) => {
  if (config.isProduction) {
    return c.json({ error: "Not found" }, 404);
  }

  const owner = c.req.param("owner");
  const name = c.req.param("name");

  const result = await db
    .select({
      id: repositories.id,
      name: repositories.name,
      ownerId: repositories.ownerId,
      userId: users.id,
    })
    .from(repositories)
    .innerJoin(users, eq(users.id, repositories.ownerId))
    .where(and(eq(users.username, owner), eq(repositories.name, name)))
    .limit(1);

  const row = result[0];
  if (!row) {
    return c.json({ error: "Repository not found" }, 404);
  }

  const prefix = `repos/${row.userId}/${row.name}/`;
  const keys = await listObjects(prefix);
  const sampleKeys = keys.slice(0, 100);

  const grouped: Record<string, string[]> = {};
  for (const key of sampleKeys) {
    const relative = key.slice(prefix.length);
    const parts = relative.split("/");
    const category = parts[0] || "root";
    if (!grouped[category]) grouped[category] = [];
    grouped[category].push(relative);
  }

  return c.json({
    prefix,
    totalFiles: keys.length,
    categories: Object.keys(grouped).map((k) => ({ name: k, count: grouped[k].length })),
    files: sampleKeys.map((k) => k.slice(prefix.length)),
    truncated: keys.length > sampleKeys.length,
  });
});

app.get("/api/avatar/:filename", async (c) => {
  const filename = c.req.param("filename");
  const key = `avatars/${filename}`;

  const data = await getObject(key);
  if (!data) {
    return c.json({ error: "Avatar not found" }, 404);
  }

  const ext = filename.split(".").pop()?.toLowerCase() || "png";
  const contentType =
    ext === "jpg" || ext === "jpeg"
      ? "image/jpeg"
      : ext === "gif"
        ? "image/gif"
        : ext === "webp"
          ? "image/webp"
          : "image/png";

  return new Response(data, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
});

export default app;
