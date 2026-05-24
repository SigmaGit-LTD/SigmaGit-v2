import { Hono } from "hono";
import { db, users, repositories, repositoryWebhooks } from "@sigmagit/db";
import { eq, and } from "drizzle-orm";
import { authMiddleware, requireAuth, type AuthVariables } from "../middleware/auth";
import { createHmac } from "crypto";
import { config } from "../config";

export type WebhookEvent = "push" | "pull_request" | "issues" | "tag" | "branch";

const app = new Hono<{ Variables: AuthVariables }>();


async function getRepoByOwnerName(owner: string, name: string) {
  const result = await db
    .select({ id: repositories.id, ownerId: repositories.ownerId })
    .from(repositories)
    .innerJoin(users, eq(users.id, repositories.ownerId))
    .where(and(eq(users.username, owner), eq(repositories.name, name)))
    .limit(1);
  return result[0] ?? null;
}

// ─── Utility: deliver a webhook payload to all matching hooks ────────────────

export async function deliverWebhookEvent(
  repositoryId: string,
  event: WebhookEvent,
  payload: Record<string, unknown>
): Promise<void> {
  if (!config.webhooksEnabled) return;
  try {
    const hooks = await db.query.repositoryWebhooks.findMany({
      where: and(eq(repositoryWebhooks.repositoryId, repositoryId), eq(repositoryWebhooks.active, true)),
    });

    await Promise.allSettled(
      hooks
        .filter((h) => (h.events as WebhookEvent[]).includes(event))
        .map(async (hook) => {
          const body =
            hook.contentType === "form"
              ? new URLSearchParams({ payload: JSON.stringify(payload) }).toString()
              : JSON.stringify(payload);

          const headers: Record<string, string> = {
            "Content-Type": hook.contentType === "form" ? "application/x-www-form-urlencoded" : "application/json",
            "X-SigmaGit-Event": event,
            "X-SigmaGit-Delivery": crypto.randomUUID(),
          };

          if (hook.secret) {
            const sig = createHmac("sha256", hook.secret).update(body).digest("hex");
            headers["X-Hub-Signature-256"] = `sha256=${sig}`;
          }

          await fetch(hook.url, { method: "POST", headers, body, signal: AbortSignal.timeout(15_000) });
        })
    );
  } catch (error) {
    console.error("[Webhook] deliverWebhookEvent error:", error);
  }
}

// ─── GET /api/repositories/:owner/:name/webhooks ─────────────────────────────

app.get("/api/repositories/:owner/:name/webhooks", requireAuth, async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const currentUser = c.get("user")!;

  const repo = await getRepoByOwnerName(owner, name);
  if (!repo) return c.json({ error: "Repository not found" }, 404);
  if (currentUser.id !== repo.ownerId) return c.json({ error: "Not authorized" }, 403);

  const hooks = await db.query.repositoryWebhooks.findMany({
    where: eq(repositoryWebhooks.repositoryId, repo.id),
  });

  // Mask secrets
  const sanitized = hooks.map((h) => ({ ...h, secret: h.secret ? "***" : null }));
  return c.json({ webhooks: sanitized });
});

// ─── POST /api/repositories/:owner/:name/webhooks ────────────────────────────

app.post("/api/repositories/:owner/:name/webhooks", requireAuth, async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const currentUser = c.get("user")!;
  const body = await c.req.json<{
    url: string;
    secret?: string;
    events: WebhookEvent[];
    active?: boolean;
    contentType?: "json" | "form";
  }>();

  if (!body.url || !body.events?.length) {
    return c.json({ error: "url and events are required" }, 400);
  }

  try {
    new URL(body.url);
  } catch {
    return c.json({ error: "Invalid URL" }, 400);
  }

  const repo = await getRepoByOwnerName(owner, name);
  if (!repo) return c.json({ error: "Repository not found" }, 404);
  if (currentUser.id !== repo.ownerId) return c.json({ error: "Not authorized" }, 403);

  const [hook] = await db
    .insert(repositoryWebhooks)
    .values({
      repositoryId: repo.id,
      url: body.url,
      secret: body.secret ?? null,
      events: body.events,
      active: body.active ?? true,
      contentType: body.contentType ?? "json",
      createdById: currentUser.id,
    })
    .returning();

  return c.json({ webhook: { ...hook, secret: hook.secret ? "***" : null } }, 201);
});

// ─── PATCH /api/repositories/:owner/:name/webhooks/:hookId ───────────────────

app.patch("/api/repositories/:owner/:name/webhooks/:hookId", requireAuth, async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const hookId = c.req.param("hookId");
  const currentUser = c.get("user")!;
  const body = await c.req.json<{
    url?: string;
    secret?: string | null;
    events?: WebhookEvent[];
    active?: boolean;
    contentType?: "json" | "form";
  }>();

  const repo = await getRepoByOwnerName(owner, name);
  if (!repo) return c.json({ error: "Repository not found" }, 404);
  if (currentUser.id !== repo.ownerId) return c.json({ error: "Not authorized" }, 403);

  const existing = await db.query.repositoryWebhooks.findFirst({
    where: and(eq(repositoryWebhooks.id, hookId), eq(repositoryWebhooks.repositoryId, repo.id)),
  });
  if (!existing) return c.json({ error: "Webhook not found" }, 404);

  const updates: Partial<typeof repositoryWebhooks.$inferInsert> = { updatedAt: new Date() };
  if (body.url !== undefined) {
    try { new URL(body.url); } catch { return c.json({ error: "Invalid URL" }, 400); }
    updates.url = body.url;
  }
  if ("secret" in body) updates.secret = body.secret ?? null;
  if (body.events !== undefined) updates.events = body.events;
  if (body.active !== undefined) updates.active = body.active;
  if (body.contentType !== undefined) updates.contentType = body.contentType;

  await db.update(repositoryWebhooks).set(updates).where(eq(repositoryWebhooks.id, hookId));

  return c.json({ success: true });
});

// ─── DELETE /api/repositories/:owner/:name/webhooks/:hookId ──────────────────

app.delete("/api/repositories/:owner/:name/webhooks/:hookId", requireAuth, async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const hookId = c.req.param("hookId");
  const currentUser = c.get("user")!;

  const repo = await getRepoByOwnerName(owner, name);
  if (!repo) return c.json({ error: "Repository not found" }, 404);
  if (currentUser.id !== repo.ownerId) return c.json({ error: "Not authorized" }, 403);

  await db
    .delete(repositoryWebhooks)
    .where(and(eq(repositoryWebhooks.id, hookId), eq(repositoryWebhooks.repositoryId, repo.id)));

  return c.json({ success: true });
});

export default app;
