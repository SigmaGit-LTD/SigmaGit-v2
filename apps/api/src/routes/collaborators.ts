import { Hono } from "hono";
import { db, users, repositoryCollaborators } from "@sigmagit/db";
import { eq, and } from "drizzle-orm";
import { authMiddleware, requireAuth, type AuthVariables } from "../middleware/auth";
import { canManageRepository } from "../lib/access";
import { resolveRepositoryWithAccess } from "../lib/repo-helpers";

const app = new Hono<{ Variables: AuthVariables }>();

// ─── GET /api/repositories/:owner/:name/collaborators ────────────────────────

app.get("/api/repositories/:owner/:name/collaborators", async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const currentUser = c.get("user");

  const repo = await resolveRepositoryWithAccess(owner, name, currentUser);
  if (!repo) return c.json({ error: "Repository not found" }, 404);

  const collabs = await db
    .select({
      userId: repositoryCollaborators.userId,
      permission: repositoryCollaborators.permission,
      createdAt: repositoryCollaborators.createdAt,
      username: users.username,
      name: users.name,
      avatarUrl: users.avatarUrl,
    })
    .from(repositoryCollaborators)
    .innerJoin(users, eq(users.id, repositoryCollaborators.userId))
    .where(eq(repositoryCollaborators.repositoryId, repo.id));

  const collaborators = collabs.map((c) => ({
    user: { id: c.userId, username: c.username, name: c.name, avatarUrl: c.avatarUrl },
    permission: c.permission,
    addedAt: c.createdAt,
  }));

  return c.json({ collaborators });
});

// ─── POST /api/repositories/:owner/:name/collaborators ───────────────────────

app.post("/api/repositories/:owner/:name/collaborators", requireAuth, async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const currentUser = c.get("user")!;
  const body = await c.req.json<{ username: string; permission?: "read" | "write" | "admin" }>();

  if (!body.username) return c.json({ error: "username is required" }, 400);

  const repo = await resolveRepositoryWithAccess(owner, name, currentUser);
  if (!repo) return c.json({ error: "Repository not found" }, 404);

  const canManage = await canManageRepository(repo, currentUser);
  if (!canManage) return c.json({ error: "Not authorized" }, 403);

  const targetUser = await db.query.users.findFirst({
    where: eq(users.username, body.username),
  });

  if (!targetUser) return c.json({ error: "User not found" }, 404);
  if (targetUser.id === repo.ownerId) return c.json({ error: "Owner cannot be added as collaborator" }, 400);

  const permission = body.permission ?? "read";

  await db
    .insert(repositoryCollaborators)
    .values({
      repositoryId: repo.id,
      userId: targetUser.id,
      permission,
      invitedById: currentUser.id,
    })
    .onConflictDoUpdate({
      target: [repositoryCollaborators.repositoryId, repositoryCollaborators.userId],
      set: { permission, updatedAt: new Date() },
    });

  return c.json({
    collaborator: {
      user: { id: targetUser.id, username: targetUser.username, name: targetUser.name, avatarUrl: targetUser.avatarUrl },
      permission,
    },
  });
});

// ─── PATCH /api/repositories/:owner/:name/collaborators/:userId ──────────────

app.patch("/api/repositories/:owner/:name/collaborators/:userId", requireAuth, async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const targetUserId = c.req.param("userId");
  const currentUser = c.get("user")!;
  const body = await c.req.json<{ permission: "read" | "write" | "admin" }>();

  if (!body.permission) return c.json({ error: "permission is required" }, 400);

  const repo = await resolveRepositoryWithAccess(owner, name, currentUser);
  if (!repo) return c.json({ error: "Repository not found" }, 404);

  const canManage = await canManageRepository(repo, currentUser);
  if (!canManage) return c.json({ error: "Not authorized" }, 403);

  await db
    .update(repositoryCollaborators)
    .set({ permission: body.permission, updatedAt: new Date() })
    .where(
      and(
        eq(repositoryCollaborators.repositoryId, repo.id),
        eq(repositoryCollaborators.userId, targetUserId)
      )
    );

  return c.json({ success: true });
});

// ─── DELETE /api/repositories/:owner/:name/collaborators/:userId ─────────────

app.delete("/api/repositories/:owner/:name/collaborators/:userId", requireAuth, async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const targetUserId = c.req.param("userId");
  const currentUser = c.get("user")!;

  const repo = await resolveRepositoryWithAccess(owner, name, currentUser);
  if (!repo) return c.json({ error: "Repository not found" }, 404);

  const canManage = await canManageRepository(repo, currentUser);
  if (!canManage && currentUser.id !== targetUserId) {
    return c.json({ error: "Not authorized" }, 403);
  }

  await db
    .delete(repositoryCollaborators)
    .where(
      and(
        eq(repositoryCollaborators.repositoryId, repo.id),
        eq(repositoryCollaborators.userId, targetUserId)
      )
    );

  return c.json({ success: true });
});

export default app;
