import { Hono } from "hono";
import { db, branchProtectionRules } from "@sigmagit/db";
import { eq, and } from "drizzle-orm";
import { authMiddleware, requireAuth, type AuthVariables } from "../middleware/auth";
import { canManageRepository } from "../lib/access";
import { resolveRepositoryWithAccess } from "../lib/repo-helpers";

const app = new Hono<{ Variables: AuthVariables }>();

// ─── GET /api/repositories/:owner/:name/branch-protection ────────────────────

app.get("/api/repositories/:owner/:name/branch-protection", requireAuth, async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const currentUser = c.get("user")!;

  const repo = await resolveRepositoryWithAccess(owner, name, currentUser);
  if (!repo) return c.json({ error: "Repository not found" }, 404);
  if (!(await canManageRepository(repo, currentUser))) {
    return c.json({ error: "Not authorized" }, 403);
  }

  const rules = await db.query.branchProtectionRules.findMany({
    where: eq(branchProtectionRules.repositoryId, repo.id),
  });

  return c.json({ rules });
});

// ─── POST /api/repositories/:owner/:name/branch-protection ───────────────────

app.post("/api/repositories/:owner/:name/branch-protection", requireAuth, async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const currentUser = c.get("user")!;
  const body = await c.req.json<{
    pattern: string;
    requirePullRequest?: boolean;
    requireApprovals?: number;
    dismissStaleReviews?: boolean;
    requireStatusChecks?: boolean;
    requiredStatusChecks?: string[];
    allowForcePush?: boolean;
    allowDeletion?: boolean;
  }>();

  if (!body.pattern) return c.json({ error: "pattern is required" }, 400);

  const repo = await resolveRepositoryWithAccess(owner, name, currentUser);
  if (!repo) return c.json({ error: "Repository not found" }, 404);
  if (!(await canManageRepository(repo, currentUser))) {
    return c.json({ error: "Not authorized" }, 403);
  }

  const [rule] = await db
    .insert(branchProtectionRules)
    .values({
      repositoryId: repo.id,
      pattern: body.pattern,
      requirePullRequest: body.requirePullRequest ?? false,
      requireApprovals: body.requireApprovals ?? 0,
      dismissStaleReviews: body.dismissStaleReviews ?? false,
      requireStatusChecks: body.requireStatusChecks ?? false,
      requiredStatusChecks: body.requiredStatusChecks ?? [],
      allowForcePush: body.allowForcePush ?? false,
      allowDeletion: body.allowDeletion ?? false,
      createdById: currentUser.id,
    })
    .returning();

  return c.json({ rule }, 201);
});

// ─── PATCH /api/repositories/:owner/:name/branch-protection/:ruleId ──────────

app.patch("/api/repositories/:owner/:name/branch-protection/:ruleId", requireAuth, async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const ruleId = c.req.param("ruleId");
  const currentUser = c.get("user")!;
  const body = await c.req.json<{
    pattern?: string;
    requirePullRequest?: boolean;
    requireApprovals?: number;
    dismissStaleReviews?: boolean;
    requireStatusChecks?: boolean;
    requiredStatusChecks?: string[];
    allowForcePush?: boolean;
    allowDeletion?: boolean;
  }>();

  const repo = await resolveRepositoryWithAccess(owner, name, currentUser);
  if (!repo) return c.json({ error: "Repository not found" }, 404);
  if (!(await canManageRepository(repo, currentUser))) {
    return c.json({ error: "Not authorized" }, 403);
  }

  const existing = await db.query.branchProtectionRules.findFirst({
    where: and(eq(branchProtectionRules.id, ruleId), eq(branchProtectionRules.repositoryId, repo.id)),
  });
  if (!existing) return c.json({ error: "Rule not found" }, 404);

  const updates: Partial<typeof branchProtectionRules.$inferInsert> = { updatedAt: new Date() };
  if (body.pattern !== undefined) updates.pattern = body.pattern;
  if (body.requirePullRequest !== undefined) updates.requirePullRequest = body.requirePullRequest;
  if (body.requireApprovals !== undefined) updates.requireApprovals = body.requireApprovals;
  if (body.dismissStaleReviews !== undefined) updates.dismissStaleReviews = body.dismissStaleReviews;
  if (body.requireStatusChecks !== undefined) updates.requireStatusChecks = body.requireStatusChecks;
  if (body.requiredStatusChecks !== undefined) updates.requiredStatusChecks = body.requiredStatusChecks;
  if (body.allowForcePush !== undefined) updates.allowForcePush = body.allowForcePush;
  if (body.allowDeletion !== undefined) updates.allowDeletion = body.allowDeletion;

  await db.update(branchProtectionRules).set(updates).where(eq(branchProtectionRules.id, ruleId));

  return c.json({ success: true });
});

// ─── DELETE /api/repositories/:owner/:name/branch-protection/:ruleId ─────────

app.delete("/api/repositories/:owner/:name/branch-protection/:ruleId", requireAuth, async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const ruleId = c.req.param("ruleId");
  const currentUser = c.get("user")!;

  const repo = await resolveRepositoryWithAccess(owner, name, currentUser);
  if (!repo) return c.json({ error: "Repository not found" }, 404);
  if (!(await canManageRepository(repo, currentUser))) {
    return c.json({ error: "Not authorized" }, 403);
  }

  await db
    .delete(branchProtectionRules)
    .where(and(eq(branchProtectionRules.id, ruleId), eq(branchProtectionRules.repositoryId, repo.id)));

  return c.json({ success: true });
});

export default app;
