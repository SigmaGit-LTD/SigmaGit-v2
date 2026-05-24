import { Hono } from "hono";
import { db, users, repositories, repositoryCollaborators } from "@sigmagit/db";
import { eq, and } from "drizzle-orm";
import { authMiddleware, requireAuth, type AuthVariables } from "../middleware/auth";
import { canAccessRepository } from "../lib/access";

const app = new Hono<{ Variables: AuthVariables }>();


// ─── Helper: check if user is repo owner or admin collaborator ───────────────

async function canManageCollaborators(repoId: string, userId: string, ownerId: string): Promise<boolean> {
  if (userId === ownerId) return true;
  const collab = await db.query.repositoryCollaborators.findFirst({
    where: and(
      eq(repositoryCollaborators.repositoryId, repoId),
      eq(repositoryCollaborators.userId, userId)
    ),
  });
  return collab?.permission === "admin";
}

// ─── GET /api/repositories/:owner/:name/collaborators ────────────────────────

app.get("/api/repositories/:owner/:name/collaborators", async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const currentUser = c.get("user");

  const result = await db
    .select({
      id: repositories.id,
      ownerId: repositories.ownerId,
      visibility: repositories.visibility,
      ownerUsername: users.username,
    })
    .from(repositories)
    .innerJoin(users, eq(users.id, repositories.ownerId))
    .where(and(eq(users.username, owner), eq(repositories.name, name)))
    .limit(1);

  const repo = result[0];
  if (!repo) return c.json({ error: "Repository not found" }, 404);

  if (!(await canAccessRepository(repo, currentUser))) {
    return c.json({ error: "Repository not found" }, 404);
  }

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

  const result = await db
    .select({ id: repositories.id, ownerId: repositories.ownerId })
    .from(repositories)
    .innerJoin(users, eq(users.id, repositories.ownerId))
    .where(and(eq(users.username, owner), eq(repositories.name, name)))
    .limit(1);

  const repo = result[0];
  if (!repo) return c.json({ error: "Repository not found" }, 404);

  const canManage = await canManageCollaborators(repo.id, currentUser.id, repo.ownerId);
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

  const result = await db
    .select({ id: repositories.id, ownerId: repositories.ownerId })
    .from(repositories)
    .innerJoin(users, eq(users.id, repositories.ownerId))
    .where(and(eq(users.username, owner), eq(repositories.name, name)))
    .limit(1);

  const repo = result[0];
  if (!repo) return c.json({ error: "Repository not found" }, 404);

  const canManage = await canManageCollaborators(repo.id, currentUser.id, repo.ownerId);
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

  const result = await db
    .select({ id: repositories.id, ownerId: repositories.ownerId })
    .from(repositories)
    .innerJoin(users, eq(users.id, repositories.ownerId))
    .where(and(eq(users.username, owner), eq(repositories.name, name)))
    .limit(1);

  const repo = result[0];
  if (!repo) return c.json({ error: "Repository not found" }, 404);

  const canManage = await canManageCollaborators(repo.id, currentUser.id, repo.ownerId);
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
