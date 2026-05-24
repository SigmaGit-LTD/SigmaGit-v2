import { Hono } from "hono";
import {
  db,
  users,
  repositories,
  auditLogs,
  systemSettings,
  organizations,
  issues,
  pullRequests,
  gists,
  gistFiles,
  repoBranchMetadata,
  sessions,
  verifications,
  jobListings,
  jobApplications,
  reports,
  dmcaRequests,
  notifications,
} from "@sigmagit/db";
import { eq, sql, desc, count, and, or, ilike, gte, lte, inArray, lt, notInArray } from "drizzle-orm";
import { authMiddleware, requireAdmin, invalidateCachedUser, type AuthVariables } from "../middleware/auth";
import { parseLimit, parseOffset } from "../lib/validation";
import { repoCache } from "../redis";
import { createGitStore, getCommitCountCached, listBranchesCached } from "../git";
import { copyPrefix, deletePrefix, getRepoPrefix } from "../s3";

const app = new Hono<{ Variables: AuthVariables }>();

const USER_ROLES = ["user", "admin", "moderator"] as const;
type UserRole = (typeof USER_ROLES)[number];
const APPLICATION_STATUSES = ["new", "reviewing", "interview", "offer", "rejected"] as const;
type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

function isUserRole(value: unknown): value is UserRole {
  return typeof value === "string" && USER_ROLES.includes(value as UserRole);
}

function isApplicationStatus(value: unknown): value is ApplicationStatus {
  return typeof value === "string" && APPLICATION_STATUSES.includes(value as ApplicationStatus);
}

app.use("*", requireAdmin);

export async function logAuditEvent(
  actorId: string,
  action: string,
  targetType: string,
  targetId?: string,
  metadata?: Record<string, unknown>,
  ipAddress?: string
) {
  await db.insert(auditLogs).values({
    actorId,
    action,
    targetType,
    targetId,
    metadata,
    ipAddress,
  });
}

async function cleanupRepositoryStorage(
  repository: Pick<typeof repositories.$inferSelect, "name" | "ownerId" | "organizationId">
) {
  const prefixes = new Set<string>();
  prefixes.add(getRepoPrefix(repository.ownerId, repository.name));
  if (repository.organizationId) {
    prefixes.add(getRepoPrefix(repository.organizationId, repository.name));
  }

  await Promise.all(
    Array.from(prefixes).map(async (prefix) => {
      try {
        await deletePrefix(prefix);
      } catch (error) {
        console.error(`[Admin] Failed to delete repository storage prefix "${prefix}":`, error);
      }
    })
  );
}

async function invalidateRepositoryCaches(
  repository: Pick<typeof repositories.$inferSelect, "name" | "ownerId" | "organizationId">
) {
  const ownerNames = new Set<string>();

  const owner = await db.query.users.findFirst({
    where: eq(users.id, repository.ownerId),
    columns: { username: true },
  });

  if (owner?.username) {
    ownerNames.add(owner.username);
  }

  if (repository.organizationId) {
    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, repository.organizationId),
      columns: { name: true },
    });
    if (org?.name) {
      ownerNames.add(org.name);
    }
  }

  await Promise.all(
    Array.from(ownerNames).map((ownerName) => repoCache.invalidateRepo(ownerName, repository.name))
  );
}

async function deleteRepositoryCompletely(
  repository: Pick<typeof repositories.$inferSelect, "id" | "name" | "ownerId" | "organizationId">
) {
  // PR rows may reference this repository via head/base repo IDs without ON DELETE CASCADE.
  await db
    .delete(pullRequests)
    .where(or(eq(pullRequests.headRepoId, repository.id), eq(pullRequests.baseRepoId, repository.id)));

  await cleanupRepositoryStorage(repository);
  await invalidateRepositoryCaches(repository);
  await db.delete(repositories).where(eq(repositories.id, repository.id));
}

type EmptyRepoCandidate = Pick<
  typeof repositories.$inferSelect,
  "id" | "name" | "ownerId" | "organizationId" | "defaultBranch"
>;

async function isRepositoryActuallyEmpty(repository: EmptyRepoCandidate): Promise<boolean> {
  const storageOwnerIds = new Set<string>([repository.ownerId]);
  if (repository.organizationId) {
    storageOwnerIds.add(repository.organizationId);
  }

  for (const storageOwnerId of storageOwnerIds) {
    try {
      const store = createGitStore(storageOwnerId, repository.name);
      const branches = await listBranchesCached(store);
      const branchCandidates = new Set<string>([...branches, repository.defaultBranch, "main"]);

      for (const branch of branchCandidates) {
        const commitCount = await getCommitCountCached(store, branch);
        if (commitCount > 0) {
          return false;
        }
      }
    } catch (error) {
      console.error(
        `[Admin Utils] Failed to verify emptiness for repo ${repository.id} under storage owner ${storageOwnerId}:`,
        error
      );
      return false;
    }
  }

  return true;
}

async function getActuallyEmptyRepositories(): Promise<EmptyRepoCandidate[]> {
  const candidates = await db
    .select({
      id: repositories.id,
      name: repositories.name,
      ownerId: repositories.ownerId,
      organizationId: repositories.organizationId,
      defaultBranch: repositories.defaultBranch,
    })
    .from(repositories)
    .leftJoin(repoBranchMetadata, eq(repoBranchMetadata.repoId, repositories.id))
    .where(sql`${repoBranchMetadata.repoId} IS NULL`);

  const emptyRepositories: EmptyRepoCandidate[] = [];
  for (const repository of candidates) {
    if (await isRepositoryActuallyEmpty(repository)) {
      emptyRepositories.push(repository);
    }
  }

  return emptyRepositories;
}

app.get("/api/admin/stats", async (c) => {
  const [userCount] = await db.select({ count: count() }).from(users);
  const [repoCount] = await db.select({ count: count() }).from(repositories);
  const [publicRepoCount] = await db
    .select({ count: count() })
    .from(repositories)
    .where(eq(repositories.visibility, "public"));
  const [privateRepoCount] = await db
    .select({ count: count() })
    .from(repositories)
    .where(eq(repositories.visibility, "private"));
  const [adminCount] = await db
    .select({ count: count() })
    .from(users)
    .where(eq(users.role, "admin"));
  const [moderatorCount] = await db
    .select({ count: count() })
    .from(users)
    .where(eq(users.role, "moderator"));
  const [orgCount] = await db.select({ count: count() }).from(organizations);
  const [issueCount] = await db.select({ count: count() }).from(issues);
  const [openIssueCount] = await db
    .select({ count: count() })
    .from(issues)
    .where(eq(issues.state, "open"));
  const [prCount] = await db.select({ count: count() }).from(pullRequests);
  const [openPrCount] = await db
    .select({ count: count() })
    .from(pullRequests)
    .where(eq(pullRequests.state, "open"));
  const [gistCount] = await db.select({ count: count() }).from(gists);

  // Get recent activity (last 30 days)
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const [recentUsers] = await db
    .select({ count: count() })
    .from(users)
    .where(gte(users.createdAt, thirtyDaysAgo));
  const [recentRepos] = await db
    .select({ count: count() })
    .from(repositories)
    .where(gte(repositories.createdAt, thirtyDaysAgo));

  return c.json({
    userCount: Number(userCount.count),
    repoCount: Number(repoCount.count),
    publicRepoCount: Number(publicRepoCount.count),
    privateRepoCount: Number(privateRepoCount.count),
    adminCount: Number(adminCount.count),
    moderatorCount: Number(moderatorCount.count),
    orgCount: Number(orgCount.count),
    issueCount: Number(issueCount.count),
    openIssueCount: Number(openIssueCount.count),
    prCount: Number(prCount.count),
    openPrCount: Number(openPrCount.count),
    gistCount: Number(gistCount.count),
    recentUsers: Number(recentUsers.count),
    recentRepos: Number(recentRepos.count),
  });
});

// System stats: uptime, PostgreSQL health and metrics (admin only)
app.get("/api/admin/system-stats", async (c) => {
  const appUptimeSeconds = Math.floor(process.uptime());
  const apiUptimeSeconds = appUptimeSeconds; // API runs in same process

  let postgres: {
    version: string | null;
    connections: number | null;
    databaseSizeBytes: number | null;
    cacheHitRatio: number | null;
    transactionsCommitted: number | null;
    transactionsRolledBack: number | null;
    rowsReturned: number | null;
    rowsFetched: number | null;
    rowsInserted: number | null;
    rowsUpdated: number | null;
    rowsDeleted: number | null;
    error: string | null;
  } = {
    version: null,
    connections: null,
    databaseSizeBytes: null,
    cacheHitRatio: null,
    transactionsCommitted: null,
    transactionsRolledBack: null,
    rowsReturned: null,
    rowsFetched: null,
    rowsInserted: null,
    rowsUpdated: null,
    rowsDeleted: null,
    error: null,
  };

  function firstRow<T extends Record<string, unknown>>(result: unknown): T | null {
    if (Array.isArray(result) && result.length > 0) return result[0] as T;
    const r = result as { rows?: unknown[] };
    if (r?.rows?.length) return r.rows[0] as T;
    return null;
  }

  try {
    const [versionRow, sizeRow, statsRow, connectionsRow] = await Promise.all([
      db.execute(sql`SELECT version() as version`),
      db.execute(sql`SELECT pg_database_size(current_database())::bigint as size`),
      db.execute(
        sql`SELECT xact_commit, xact_rollback, blks_read, blks_hit, tup_returned, tup_fetched, tup_inserted, tup_updated, tup_deleted FROM pg_stat_database WHERE datname = current_database()`
      ),
      db.execute(sql`SELECT count(*)::int as count FROM pg_stat_activity WHERE datname = current_database()`),
    ]);

    const v = firstRow<{ version: string }>(versionRow);
    const sz = firstRow<{ size: string }>(sizeRow);
    const st = firstRow<{
      xact_commit: string;
      xact_rollback: string;
      blks_read: string;
      blks_hit: string;
      tup_returned: string;
      tup_fetched: string;
      tup_inserted: string;
      tup_updated: string;
      tup_deleted: string;
    }>(statsRow);
    const conn = firstRow<{ count: number | string }>(connectionsRow);

    const blksHit = st ? Number(st.blks_hit) || 0 : 0;
    const blksRead = st ? Number(st.blks_read) || 0 : 0;
    const cacheHitRatio =
      blksHit + blksRead > 0 ? Math.round((blksHit / (blksHit + blksRead)) * 10000) / 100 : null;

    postgres = {
      version: v?.version ?? null,
      connections: conn?.count != null ? Number(conn.count) : null,
      databaseSizeBytes: sz != null ? Number(sz.size) : null,
      cacheHitRatio,
      transactionsCommitted: st ? Number(st.xact_commit) : null,
      transactionsRolledBack: st ? Number(st.xact_rollback) : null,
      rowsReturned: st ? Number(st.tup_returned) : null,
      rowsFetched: st ? Number(st.tup_fetched) : null,
      rowsInserted: st ? Number(st.tup_inserted) : null,
      rowsUpdated: st ? Number(st.tup_updated) : null,
      rowsDeleted: st ? Number(st.tup_deleted) : null,
      error: null,
    };
  } catch (err) {
    postgres.error = err instanceof Error ? err.message : "Unknown error";
  }

  return c.json({
    appUptimeSeconds,
    apiUptimeSeconds,
    postgres,
    generatedAt: new Date().toISOString(),
  });
});

// --- Admin Utils: manual cleanup actions ---

// Preview counts for each cleanup (no mutations)
app.get("/api/admin/utils/preview", async (c) => {
  const emptyRepos = await getActuallyEmptyRepositories();

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const usersWithRepos = await db
    .selectDistinct({ ownerId: repositories.ownerId })
    .from(repositories);
  const ownerIds = usersWithRepos.map((r) => r.ownerId);
  const unactivatedCount =
    ownerIds.length > 0
      ? await db
          .select({ count: count() })
          .from(users)
          .where(
            and(
              eq(users.emailVerified, false),
              eq(users.role, "user"),
              notInArray(users.id, ownerIds),
              lt(users.createdAt, sevenDaysAgo)
            )
          )
      : await db
          .select({ count: count() })
          .from(users)
          .where(
            and(
              eq(users.emailVerified, false),
              eq(users.role, "user"),
              lt(users.createdAt, sevenDaysAgo)
            )
          );

  const expiredSessions = await db
    .select({ count: count() })
    .from(sessions)
    .where(lt(sessions.expiresAt, new Date()));

  const expiredVerifications = await db
    .select({ count: count() })
    .from(verifications)
    .where(lt(verifications.expiresAt, new Date()));

  return c.json({
    emptyRepos: emptyRepos.length,
    unactivatedAccounts: Number(unactivatedCount[0]?.count ?? 0),
    expiredSessions: Number(expiredSessions[0]?.count ?? 0),
    expiredVerifications: Number(expiredVerifications[0]?.count ?? 0),
  });
});

// Run cleanup: empty repos (repos with no branch metadata / never pushed)
app.post("/api/admin/utils/cleanup-empty-repos", async (c) => {
  const actor = c.get("user")!;
  const emptyRepos = await getActuallyEmptyRepositories();

  let deleted = 0;
  for (const row of emptyRepos) {
    try {
      await deleteRepositoryCompletely({
        id: row.id,
        name: row.name,
        ownerId: row.ownerId,
        organizationId: row.organizationId,
      });
      deleted++;
    } catch (err) {
      console.error(`[Admin Utils] Failed to delete empty repo ${row.id}:`, err);
    }
  }

  await logAuditEvent(
    actor.id,
    "utils.cleanup_empty_repos",
    "system",
    undefined,
    { deleted },
    c.req.header("x-forwarded-for") || c.req.header("x-real-ip")
  );

  return c.json({ deleted });
});

// Run cleanup: unactivated accounts (email never verified, no repos, older than 7 days)
app.post("/api/admin/utils/cleanup-unactivated-accounts", async (c) => {
  const actor = c.get("user")!;
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const usersWithRepos = await db
    .selectDistinct({ ownerId: repositories.ownerId })
    .from(repositories);
  const ownerIds = usersWithRepos.map((r) => r.ownerId);

  const toDelete =
    ownerIds.length > 0
      ? await db
          .select({ id: users.id, username: users.username })
          .from(users)
          .where(
            and(
              eq(users.emailVerified, false),
              eq(users.role, "user"),
              notInArray(users.id, ownerIds),
              lt(users.createdAt, sevenDaysAgo)
            )
          )
      : await db
          .select({ id: users.id, username: users.username })
          .from(users)
          .where(
            and(
              eq(users.emailVerified, false),
              eq(users.role, "user"),
              lt(users.createdAt, sevenDaysAgo)
            )
          );

  let deleted = 0;
  for (const u of toDelete) {
    try {
      await db.delete(users).where(eq(users.id, u.id));
      deleted++;
    } catch (err) {
      console.error(`[Admin Utils] Failed to delete unactivated user ${u.id}:`, err);
    }
  }

  await logAuditEvent(
    actor.id,
    "utils.cleanup_unactivated_accounts",
    "system",
    undefined,
    { deleted },
    c.req.header("x-forwarded-for") || c.req.header("x-real-ip")
  );

  return c.json({ deleted });
});

// Run cleanup: expired sessions
app.post("/api/admin/utils/cleanup-expired-sessions", async (c) => {
  const actor = c.get("user")!;
  const result = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, new Date()))
    .returning({ id: sessions.id });

  await logAuditEvent(
    actor.id,
    "utils.cleanup_expired_sessions",
    "system",
    undefined,
    { deleted: result.length },
    c.req.header("x-forwarded-for") || c.req.header("x-real-ip")
  );

  return c.json({ deleted: result.length });
});

// Run cleanup: expired verifications
app.post("/api/admin/utils/cleanup-expired-verifications", async (c) => {
  const actor = c.get("user")!;
  const result = await db
    .delete(verifications)
    .where(lt(verifications.expiresAt, new Date()))
    .returning({ id: verifications.id });

  await logAuditEvent(
    actor.id,
    "utils.cleanup_expired_verifications",
    "system",
    undefined,
    { deleted: result.length },
    c.req.header("x-forwarded-for") || c.req.header("x-real-ip")
  );

  return c.json({ deleted: result.length });
});

app.get("/api/admin/users", async (c) => {
  const search = c.req.query("search") || "";
  const role = c.req.query("role");
  const limit = parseLimit(c.req.query("limit"), 20);
  const offset = parseOffset(c.req.query("offset"), 0);

  const conditions = [];

  if (search) {
    conditions.push(
      or(
        ilike(users.name, `%${search}%`),
        ilike(users.username, `%${search}%`),
        ilike(users.email, `%${search}%`)
      )
    );
  }

  if (role) {
    conditions.push(eq(users.role, role as "user" | "admin" | "moderator"));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const usersResult = await db
    .select()
    .from(users)
    .where(whereClause)
    .orderBy(desc(users.createdAt))
    .limit(limit + 1)
    .offset(offset);

  const hasMore = usersResult.length > limit;
  const usersData = usersResult.slice(0, limit);

  return c.json({
    users: usersData,
    hasMore,
  });
});

app.get("/api/admin/users/:id", async (c) => {
  const id = c.req.param("id");

  const user = await db.query.users.findFirst({
    where: eq(users.id, id),
  });

  if (!user) {
    return c.json({ error: "User not found" }, 404);
  }

  const [repoCount] = await db
    .select({ count: count() })
    .from(repositories)
    .where(eq(repositories.ownerId, id));

  return c.json({
    ...user,
    repoCount: Number(repoCount.count),
  });
});

app.patch("/api/admin/users/:id", async (c) => {
  const id = c.req.param("id");
  const actor = c.get("user")!;
  const body = await c.req.json();

  const existingUser = await db.query.users.findFirst({
    where: eq(users.id, id),
  });

  if (!existingUser) {
    return c.json({ error: "User not found" }, 404);
  }

  const updates: Record<string, unknown> = {};
  if (body.role !== undefined) {
    if (!isUserRole(body.role)) {
      return c.json({ error: "Invalid role" }, 400);
    }
    updates.role = body.role;
  }

  if (Object.keys(updates).length === 0) {
    return c.json({ error: "No valid fields to update" }, 400);
  }

  await db.update(users).set(updates).where(eq(users.id, id));
  invalidateCachedUser(id);

  await logAuditEvent(
    actor.id,
    "user.update",
    "user",
    id,
    { changes: body },
    c.req.header("x-forwarded-for") || c.req.header("x-real-ip")
  );

  return c.json({ success: true });
});

app.delete("/api/admin/users/:id", async (c) => {
  const id = c.req.param("id");
  const actor = c.get("user")!;

  const existingUser = await db.query.users.findFirst({
    where: eq(users.id, id),
  });

  if (!existingUser) {
    return c.json({ error: "User not found" }, 404);
  }

  if (actor.id === id) {
    return c.json({ error: "You cannot delete your own account from admin panel" }, 400);
  }

  if (existingUser.role === "admin") {
    const [adminUsers] = await db
      .select({ count: count() })
      .from(users)
      .where(eq(users.role, "admin"));

    if (Number(adminUsers.count) <= 1) {
      return c.json({ error: "Cannot delete the last admin user" }, 400);
    }
  }

  // Remove non-cascading references to this user before deleting.
  await db.update(issues).set({ closedById: null }).where(eq(issues.closedById, id));
  await db
    .update(pullRequests)
    .set({ mergedById: null, closedById: null })
    .where(or(eq(pullRequests.mergedById, id), eq(pullRequests.closedById, id)));

  // Delete owned repositories explicitly so their git storage is cleaned up.
  const userRepos = await db.query.repositories.findMany({
    where: eq(repositories.ownerId, id),
    columns: { id: true, name: true, ownerId: true, organizationId: true },
  });
  for (const repository of userRepos) {
    await deleteRepositoryCompletely(repository);
  }

  await db.delete(users).where(eq(users.id, id));

  await logAuditEvent(
    actor.id,
    "user.delete",
    "user",
    id,
    { username: existingUser.username },
    c.req.header("x-forwarded-for") || c.req.header("x-real-ip")
  );

  return c.json({ success: true });
});

app.get("/api/admin/repositories", async (c) => {
  const search = c.req.query("search") || "";
  const visibility = c.req.query("visibility");
  const limit = parseLimit(c.req.query("limit"), 20);
  const offset = parseOffset(c.req.query("offset"), 0);

  const conditions = [];

  if (search) {
    conditions.push(
      or(
        ilike(repositories.name, `%${search}%`),
        ilike(repositories.description, `%${search}%`)
      )
    );
  }

  if (visibility) {
    conditions.push(eq(repositories.visibility, visibility as "public" | "private"));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const reposResult = await db
    .select({
      id: repositories.id,
      name: repositories.name,
      description: repositories.description,
      ownerId: repositories.ownerId,
      organizationId: repositories.organizationId,
      visibility: repositories.visibility,
      createdAt: repositories.createdAt,
      updatedAt: repositories.updatedAt,
      ownerUsername: users.username,
      ownerName: users.name,
      orgName: organizations.name,
      orgDisplayName: organizations.displayName,
    })
    .from(repositories)
    .innerJoin(users, eq(users.id, repositories.ownerId))
    .leftJoin(organizations, eq(organizations.id, repositories.organizationId))
    .where(whereClause)
    .orderBy(desc(repositories.createdAt))
    .limit(limit + 1)
    .offset(offset);

  const hasMore = reposResult.length > limit;
  const reposData = reposResult.slice(0, limit).map((row) => {
    const ownerUsername =
      row.organizationId && row.orgName
        ? row.orgName
        : (row.ownerUsername ?? row.ownerId);
    const ownerDisplayName =
      row.organizationId && (row.orgDisplayName || row.orgName)
        ? (row.orgDisplayName ?? row.orgName)!
        : (row.ownerName || (row.ownerUsername ?? row.ownerId));
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      ownerId: row.ownerId,
      organizationId: row.organizationId,
      visibility: row.visibility,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ownerUsername,
      ownerDisplayName,
    };
  });

  return c.json({
    repositories: reposData,
    hasMore,
  });
});

app.delete("/api/admin/repositories/:id", async (c) => {
  const id = c.req.param("id");
  const actor = c.get("user")!;

  const existingRepo = await db.query.repositories.findFirst({
    where: eq(repositories.id, id),
  });

  if (!existingRepo) {
    return c.json({ error: "Repository not found" }, 404);
  }

  await deleteRepositoryCompletely(existingRepo);

  await logAuditEvent(
    actor.id,
    "repo.delete",
    "repository",
    id,
    { name: existingRepo.name },
    c.req.header("x-forwarded-for") || c.req.header("x-real-ip")
  );

  return c.json({ success: true });
});

app.post("/api/admin/repositories/:id/transfer", async (c) => {
  const id = c.req.param("id");
  const actor = c.get("user")!;
  const body = await c.req.json();
  const { newOwnerId } = body;

  if (typeof newOwnerId !== "string" || !newOwnerId) {
    return c.json({ error: "newOwnerId is required" }, 400);
  }

  const existingRepo = await db.query.repositories.findFirst({
    where: eq(repositories.id, id),
  });

  if (!existingRepo) {
    return c.json({ error: "Repository not found" }, 404);
  }

  const newOwner = await db.query.users.findFirst({
    where: eq(users.id, newOwnerId),
  });

  if (!newOwner) {
    return c.json({ error: "New owner not found" }, 404);
  }

  const conflictingRepo = await db.query.repositories.findFirst({
    where: and(eq(repositories.ownerId, newOwnerId), eq(repositories.name, existingRepo.name)),
    columns: { id: true },
  });

  if (conflictingRepo && conflictingRepo.id !== id) {
    return c.json({ error: "Target owner already has a repository with this name" }, 409);
  }

  const oldStorageOwnerId = existingRepo.organizationId ?? existingRepo.ownerId;
  const oldStoragePrefix = getRepoPrefix(oldStorageOwnerId, existingRepo.name);
  const newStoragePrefix = getRepoPrefix(newOwnerId, existingRepo.name);

  await db
    .update(repositories)
    .set({ ownerId: newOwnerId, organizationId: null })
    .where(eq(repositories.id, id));

  if (oldStoragePrefix !== newStoragePrefix) {
    await copyPrefix(oldStoragePrefix, newStoragePrefix);
    await deletePrefix(oldStoragePrefix);
  }

  const oldOwnerName = existingRepo.organizationId
    ? (
        await db.query.organizations.findFirst({
          where: eq(organizations.id, existingRepo.organizationId),
          columns: { name: true },
        })
      )?.name
    : (
        await db.query.users.findFirst({
          where: eq(users.id, existingRepo.ownerId),
          columns: { username: true },
        })
      )?.username;

  if (oldOwnerName) {
    await repoCache.invalidateRepo(oldOwnerName, existingRepo.name);
  }
  await repoCache.invalidateRepo(newOwner.username, existingRepo.name);

  await logAuditEvent(
    actor.id,
    "repo.transfer",
    "repository",
    id,
    {
      name: existingRepo.name,
      from: existingRepo.ownerId,
      to: newOwnerId,
    },
    c.req.header("x-forwarded-for") || c.req.header("x-real-ip")
  );

  return c.json({ success: true });
});

app.get("/api/admin/gists", async (c) => {
  const search = c.req.query("search") || "";
  const visibility = c.req.query("visibility");
  const limit = parseLimit(c.req.query("limit"), 20);
  const offset = parseOffset(c.req.query("offset"), 0);

  const conditions = [];

  if (search) {
    conditions.push(
      or(
        ilike(gists.description, `%${search}%`),
        sql`EXISTS (
          SELECT 1 FROM ${gistFiles} 
          WHERE ${gistFiles.gistId} = ${gists.id} 
          AND ${ilike(gistFiles.filename, `%${search}%`)}
        )`
      )
    );
  }

  if (visibility) {
    conditions.push(eq(gists.visibility, visibility as "public" | "secret"));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const gistsResult = await db
    .select()
    .from(gists)
    .where(whereClause)
    .orderBy(desc(gists.createdAt))
    .limit(limit + 1)
    .offset(offset);

  const hasMore = gistsResult.length > limit;
  const gistsData = gistsResult.slice(0, limit);
  const gistIds = gistsData.map((g) => g.id);

  // Get all files for all gists in one query (without content to save memory)
  const allFiles = gistIds.length > 0
    ? await db
        .select({
          id: gistFiles.id,
          gistId: gistFiles.gistId,
          filename: gistFiles.filename,
          language: gistFiles.language,
          size: gistFiles.size,
          createdAt: gistFiles.createdAt,
          updatedAt: gistFiles.updatedAt,
          // Exclude content field to save memory - admin list doesn't need it
        })
        .from(gistFiles)
        .where(inArray(gistFiles.gistId, gistIds))
    : [];

  // Get all owners in one query
  const ownerIds = [...new Set(gistsData.map((g) => g.ownerId))];
  const allOwners = ownerIds.length > 0
    ? await db
        .select({
          id: users.id,
          username: users.username,
          name: users.name,
        })
        .from(users)
        .where(inArray(users.id, ownerIds))
    : [];

  // Group files by gistId
  const filesByGistId = new Map<string, typeof allFiles>();
  for (const file of allFiles) {
    if (!filesByGistId.has(file.gistId)) {
      filesByGistId.set(file.gistId, []);
    }
    filesByGistId.get(file.gistId)!.push(file);
  }

  // Create owner lookup
  const ownerMap = new Map(allOwners.map((o) => [o.id, o]));

  // Combine data
  const gistsWithFiles = gistsData.map((gist) => ({
    ...gist,
    files: filesByGistId.get(gist.id) || [],
    owner: ownerMap.get(gist.ownerId) || null,
  }));

  return c.json({
    gists: gistsWithFiles,
    hasMore,
  });
});

app.delete("/api/admin/gists/:id", async (c) => {
  const id = c.req.param("id");
  const actor = c.get("user")!;

  const existingGist = await db.query.gists.findFirst({
    where: eq(gists.id, id),
  });

  if (!existingGist) {
    return c.json({ error: "Gist not found" }, 404);
  }

  await db.delete(gists).where(eq(gists.id, id));

  await logAuditEvent(
    actor.id,
    "gist.delete",
    "gist",
    id,
    { description: existingGist.description },
    c.req.header("x-forwarded-for") || c.req.header("x-real-ip")
  );

  return c.json({ success: true });
});

app.get("/api/admin/audit-logs", async (c) => {
  const action = c.req.query("action");
  const targetType = c.req.query("targetType");
  const limit = parseLimit(c.req.query("limit"), 50);
  const offset = parseOffset(c.req.query("offset"), 0);

  const conditions = [];

  if (action) {
    conditions.push(ilike(auditLogs.action, `%${action}%`));
  }

  if (targetType) {
    conditions.push(eq(auditLogs.targetType, targetType));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const logsResult = await db
    .select({
      id: auditLogs.id,
      actorId: auditLogs.actorId,
      action: auditLogs.action,
      targetType: auditLogs.targetType,
      targetId: auditLogs.targetId,
      metadata: auditLogs.metadata,
      ipAddress: auditLogs.ipAddress,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .where(whereClause)
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit + 1)
    .offset(offset);

  const hasMore = logsResult.length > limit;
  const logsData = logsResult.slice(0, limit);

  const logsWithActors = await Promise.all(
    logsData.map(async (log) => {
      const actor = log.actorId
        ? await db.query.users.findFirst({
            where: eq(users.id, log.actorId),
            columns: { id: true, username: true, name: true },
          })
        : null;

      return {
        ...log,
        actor,
      };
    })
  );

  return c.json({
    logs: logsWithActors,
    hasMore,
  });
});

app.get("/api/admin/settings", async (c) => {
  const settings = await db.select().from(systemSettings);

  const settingsMap: Record<string, unknown> = {};
  for (const setting of settings) {
    settingsMap[setting.key] = setting.value;
  }

  return c.json(settingsMap);
});

app.patch("/api/admin/settings", async (c) => {
  const actor = c.get("user")!;
  const body = await c.req.json();

  for (const [key, value] of Object.entries(body)) {
    await db
      .insert(systemSettings)
      .values({
        key,
        value,
        updatedBy: actor.id,
      })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: {
          value,
          updatedBy: actor.id,
          updatedAt: new Date(),
        },
      });
  }

  await logAuditEvent(
    actor.id,
    "settings.update",
    "system",
    undefined,
    { keys: Object.keys(body) },
    c.req.header("x-forwarded-for") || c.req.header("x-real-ip")
  );

  return c.json({ success: true });
});

app.post("/api/admin/maintenance", async (c) => {
  const actor = c.get("user")!;
  const body = await c.req.json();
  const { enabled } = body;

  await db
    .insert(systemSettings)
    .values({
      key: "maintenance_mode",
      value: enabled,
      updatedBy: actor.id,
    })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: {
        value: enabled,
        updatedBy: actor.id,
        updatedAt: new Date(),
      },
    });

  await logAuditEvent(
    actor.id,
    "maintenance.toggle",
    "system",
    undefined,
    { enabled },
    c.req.header("x-forwarded-for") || c.req.header("x-real-ip")
  );

  return c.json({ success: true });
});

app.get("/api/admin/organizations", async (c) => {
  const search = c.req.query("search") || "";
  const limit = parseLimit(c.req.query("limit"), 20);
  const offset = parseOffset(c.req.query("offset"), 0);

  const conditions = [];

  if (search) {
    conditions.push(
      or(
        ilike(organizations.name, `%${search}%`),
        ilike(organizations.displayName, `%${search}%`),
        ilike(organizations.description, `%${search}%`)
      )
    );
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const orgsResult = await db
    .select()
    .from(organizations)
    .where(whereClause)
    .orderBy(desc(organizations.createdAt))
    .limit(limit + 1)
    .offset(offset);

  const hasMore = orgsResult.length > limit;
  const orgsData = orgsResult.slice(0, limit);

  return c.json({
    organizations: orgsData,
    hasMore,
  });
});

app.get("/api/admin/organizations/:id", async (c) => {
  const id = c.req.param("id");

  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, id),
  });

  if (!org) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const [repoCount] = await db
    .select({ count: count() })
    .from(repositories)
    .where(eq(repositories.organizationId, id));

  return c.json({
    ...org,
    repoCount: Number(repoCount.count),
  });
});

app.delete("/api/admin/organizations/:id", async (c) => {
  const id = c.req.param("id");
  const actor = c.get("user")!;

  const existingOrg = await db.query.organizations.findFirst({
    where: eq(organizations.id, id),
  });

  if (!existingOrg) {
    return c.json({ error: "Organization not found" }, 404);
  }

  // Delete organization repositories explicitly so git storage and cache are cleaned up.
  const organizationRepos = await db.query.repositories.findMany({
    where: eq(repositories.organizationId, id),
    columns: { id: true, name: true, ownerId: true, organizationId: true },
  });

  for (const repository of organizationRepos) {
    await deleteRepositoryCompletely(repository);
  }

  await db.delete(organizations).where(eq(organizations.id, id));

  await logAuditEvent(
    actor.id,
    "org.delete",
    "organization",
    id,
    { name: existingOrg.name },
    c.req.header("x-forwarded-for") || c.req.header("x-real-ip")
  );

  return c.json({ success: true });
});

app.get("/api/admin/issues", async (c) => {
  const search = c.req.query("search") || "";
  const state = c.req.query("state");
  const limit = parseLimit(c.req.query("limit"), 20);
  const offset = parseOffset(c.req.query("offset"), 0);

  const conditions = [];

  if (search) {
    conditions.push(
      or(ilike(issues.title, `%${search}%`), ilike(issues.body, `%${search}%`))
    );
  }

  if (state) {
    conditions.push(eq(issues.state, state as "open" | "closed"));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const issuesResult = await db
    .select()
    .from(issues)
    .where(whereClause)
    .orderBy(desc(issues.createdAt))
    .limit(limit + 1)
    .offset(offset);

  const hasMore = issuesResult.length > limit;
  const issuesData = issuesResult.slice(0, limit);

  return c.json({
    issues: issuesData,
    hasMore,
  });
});

app.get("/api/admin/analytics", async (c) => {
  const days = parseLimit(c.req.query("days"), 30, 365);
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  // User growth over time
  const userGrowth = await db
    .select({
      date: sql<string>`DATE(${users.createdAt})`,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(users)
    .where(gte(users.createdAt, startDate))
    .groupBy(sql`DATE(${users.createdAt})`)
    .orderBy(sql`DATE(${users.createdAt})`);

  // Repository growth over time
  const repoGrowth = await db
    .select({
      date: sql<string>`DATE(${repositories.createdAt})`,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(repositories)
    .where(gte(repositories.createdAt, startDate))
    .groupBy(sql`DATE(${repositories.createdAt})`)
    .orderBy(sql`DATE(${repositories.createdAt})`);

  // Activity by day
  const activityByDay = await db
    .select({
      date: sql<string>`DATE(${auditLogs.createdAt})`,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(auditLogs)
    .where(gte(auditLogs.createdAt, startDate))
    .groupBy(sql`DATE(${auditLogs.createdAt})`)
    .orderBy(sql`DATE(${auditLogs.createdAt})`);

  return c.json({
    userGrowth,
    repoGrowth,
    activityByDay,
  });
});

// ─── Applications (careers: job listings + job applications) ─────────────────

app.get("/api/admin/applications/jobs", async (c) => {
  const openOnly = c.req.query("open");
  const conditions = [];
  if (openOnly === "true") {
    conditions.push(eq(jobListings.open, true));
  }
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
  const jobs = await db
    .select()
    .from(jobListings)
    .where(whereClause)
    .orderBy(desc(jobListings.createdAt));
  return c.json({ jobs });
});

app.post("/api/admin/applications/jobs", async (c) => {
  const actor = c.get("user")!;
  const body = await c.req.json().catch(() => ({}));
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const slug =
    typeof body.slug === "string"
      ? body.slug.trim().toLowerCase().replace(/\s+/g, "-")
      : title.toLowerCase().replace(/\s+/g, "-");
  const department = typeof body.department === "string" ? body.department.trim() || null : null;
  const location = typeof body.location === "string" ? body.location.trim() || null : null;
  const employmentType =
    body.employmentType === "part_time" ||
    body.employmentType === "contract" ||
    body.employmentType === "internship"
      ? body.employmentType
      : "full_time";

  if (!title || !description) {
    return c.json({ error: "Title and description are required" }, 400);
  }

  const [job] = await db
    .insert(jobListings)
    .values({
      slug: slug || "job",
      title,
      description,
      department,
      location,
      employmentType,
      open: true,
    })
    .returning();

  await logAuditEvent(actor.id, "job_listing.create", "job_listing", job.id, { title: job.title });
  return c.json(job, 201);
});

app.patch("/api/admin/applications/jobs/:id", async (c) => {
  const id = c.req.param("id");
  const actor = c.get("user")!;
  const body = await c.req.json().catch(() => ({}));
  const updates: Record<string, unknown> = {};
  if (typeof body.title === "string" && body.title.trim()) updates.title = body.title.trim();
  if (typeof body.description === "string") updates.description = body.description.trim();
  if (typeof body.department === "string") updates.department = body.department.trim() || null;
  if (typeof body.location === "string") updates.location = body.location.trim() || null;
  if (
    body.employmentType === "part_time" ||
    body.employmentType === "contract" ||
    body.employmentType === "internship" ||
    body.employmentType === "full_time"
  ) {
    updates.employmentType = body.employmentType;
  }
  if (typeof body.open === "boolean") updates.open = body.open;
  if (typeof body.slug === "string" && body.slug.trim()) {
    updates.slug = body.slug.trim().toLowerCase().replace(/\s+/g, "-");
  }
  if (Object.keys(updates).length === 0) {
    return c.json({ error: "No valid fields to update" }, 400);
  }

  const [updated] = await db
    .update(jobListings)
    .set({ ...updates, updatedAt: new Date() } as Record<string, unknown>)
    .where(eq(jobListings.id, id))
    .returning();

  if (!updated) {
    return c.json({ error: "Job listing not found" }, 404);
  }
  await logAuditEvent(actor.id, "job_listing.update", "job_listing", id, updates);
  return c.json(updated);
});

app.delete("/api/admin/applications/jobs/:id", async (c) => {
  const id = c.req.param("id");
  const actor = c.get("user")!;
  const [existing] = await db.select().from(jobListings).where(eq(jobListings.id, id)).limit(1);
  if (!existing) {
    return c.json({ error: "Job listing not found" }, 404);
  }
  await db.delete(jobApplications).where(eq(jobApplications.jobListingId, id));
  await db.delete(jobListings).where(eq(jobListings.id, id));
  await logAuditEvent(actor.id, "job_listing.delete", "job_listing", id, { title: existing.title });
  return c.json({ success: true });
});

app.get("/api/admin/applications/applications", async (c) => {
  const jobId = c.req.query("jobId");
  const status = c.req.query("status");
  const limit = parseLimit(c.req.query("limit"), 20);
  const offset = parseOffset(c.req.query("offset"), 0);

  const conditions = [];
  if (jobId) conditions.push(eq(jobApplications.jobListingId, jobId));
  if (status) {
    if (!isApplicationStatus(status)) {
      return c.json({ error: "Invalid status" }, 400);
    }
    conditions.push(eq(jobApplications.status, status));
  }
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const applicationsResult = await db
    .select({
      id: jobApplications.id,
      jobListingId: jobApplications.jobListingId,
      name: jobApplications.name,
      email: jobApplications.email,
      phone: jobApplications.phone,
      coverLetter: jobApplications.coverLetter,
      resumeUrl: jobApplications.resumeUrl,
      linkedInUrl: jobApplications.linkedInUrl,
      status: jobApplications.status,
      createdAt: jobApplications.createdAt,
      jobTitle: jobListings.title,
    })
    .from(jobApplications)
    .innerJoin(jobListings, eq(jobListings.id, jobApplications.jobListingId))
    .where(whereClause)
    .orderBy(desc(jobApplications.createdAt))
    .limit(limit + 1)
    .offset(offset);

  const hasMore = applicationsResult.length > limit;
  const applications = applicationsResult.slice(0, limit);

  return c.json({ applications, hasMore });
});

app.get("/api/admin/applications/applications/:id", async (c) => {
  const id = c.req.param("id");
  const [row] = await db
    .select({
      application: jobApplications,
      jobTitle: jobListings.title,
      jobSlug: jobListings.slug,
    })
    .from(jobApplications)
    .innerJoin(jobListings, eq(jobListings.id, jobApplications.jobListingId))
    .where(eq(jobApplications.id, id))
    .limit(1);

  if (!row) {
    return c.json({ error: "Application not found" }, 404);
  }
  return c.json({
    ...row.application,
    jobTitle: row.jobTitle,
    jobSlug: row.jobSlug,
  });
});

app.patch("/api/admin/applications/applications/:id", async (c) => {
  const id = c.req.param("id");
  const actor = c.get("user")!;
  const body = await c.req.json().catch(() => ({}));
  const status = body.status;
  if (
    status !== "new" &&
    status !== "reviewing" &&
    status !== "interview" &&
    status !== "offer" &&
    status !== "rejected"
  ) {
    return c.json({ error: "Invalid status" }, 400);
  }

  const [updated] = await db
    .update(jobApplications)
    .set({ status, updatedAt: new Date() })
    .where(eq(jobApplications.id, id))
    .returning();

  if (!updated) {
    return c.json({ error: "Application not found" }, 404);
  }
  await logAuditEvent(actor.id, "application.status_update", "job_application", id, { status });
  return c.json(updated);
});

// --- Admin Reports ---

const REPORT_STATUSES = ["pending", "reviewing", "resolved", "dismissed"] as const;
const REPORT_TARGET_TYPES = ["user", "repository", "gist", "organization"] as const;
const REPORT_ACTIONS = ["dismiss", "resolve", "take_down", "warn_user", "ban_user"] as const;
const DMCA_STATUSES = ["pending", "reviewing", "approved", "rejected", "counter_filed"] as const;
const DMCA_ACTIONS = ["approve_takedown", "reject", "dismiss"] as const;

app.get("/api/admin/reports/counts", async (c) => {
  const [pendingRow] = await db
    .select({ count: count() })
    .from(reports)
    .where(eq(reports.status, "pending"));
  return c.json({ pending: pendingRow?.count ?? 0 });
});

app.get("/api/admin/reports", async (c) => {
  const status = c.req.query("status");
  const targetType = c.req.query("targetType");
  const limit = parseLimit(c.req.query("limit"), 20, 100);
  const offset = parseOffset(c.req.query("offset"), 0);

  const conditions = [];
  if (status && REPORT_STATUSES.includes(status as (typeof REPORT_STATUSES)[number])) {
    conditions.push(eq(reports.status, status as (typeof REPORT_STATUSES)[number]));
  }
  if (targetType && REPORT_TARGET_TYPES.includes(targetType as (typeof REPORT_TARGET_TYPES)[number])) {
    conditions.push(eq(reports.targetType, targetType as (typeof REPORT_TARGET_TYPES)[number]));
  }
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const list = await db
    .select({
      id: reports.id,
      reporterId: reports.reporterId,
      targetType: reports.targetType,
      targetId: reports.targetId,
      reason: reports.reason,
      description: reports.description,
      status: reports.status,
      adminNotes: reports.adminNotes,
      resolvedById: reports.resolvedById,
      resolvedAt: reports.resolvedAt,
      createdAt: reports.createdAt,
      reporterUsername: users.username,
      reporterName: users.name,
    })
    .from(reports)
    .leftJoin(users, eq(users.id, reports.reporterId))
    .where(whereClause)
    .orderBy(desc(reports.createdAt))
    .limit(limit + 1)
    .offset(offset);

  const hasMore = list.length > limit;
  const items = list.slice(0, limit);

  // Resolve target display names (user name, repo name, etc.)
  const userTargetIds = [...new Set(items.filter((r) => r.targetType === "user").map((r) => r.targetId))];
  const repoTargetIds = [...new Set(items.filter((r) => r.targetType === "repository").map((r) => r.targetId))];
  const gistTargetIds = [...new Set(items.filter((r) => r.targetType === "gist").map((r) => r.targetId))];
  const orgTargetIds = [...new Set(items.filter((r) => r.targetType === "organization").map((r) => r.targetId))];

  const [userRows, repoRows, gistRows, orgRows] = await Promise.all([
    userTargetIds.length > 0
      ? db.select({ id: users.id, name: users.name, username: users.username }).from(users).where(inArray(users.id, userTargetIds))
      : [],
    repoTargetIds.length > 0
      ? db
          .select({
            id: repositories.id,
            name: repositories.name,
            ownerUsername: users.username,
          })
          .from(repositories)
          .leftJoin(users, eq(users.id, repositories.ownerId))
          .where(inArray(repositories.id, repoTargetIds))
      : [],
    gistTargetIds.length > 0
      ? db.select({ id: gists.id, description: gists.description }).from(gists).where(inArray(gists.id, gistTargetIds))
      : [],
    orgTargetIds.length > 0
      ? db.select({ id: organizations.id, displayName: organizations.displayName }).from(organizations).where(inArray(organizations.id, orgTargetIds))
      : [],
  ]);

  const userMap = new Map(
    userRows.map((u) => [
      u.id,
      [u.name || u.username || "—", u.username ? `@${u.username}` : null].filter(Boolean).join(" "),
    ])
  );
  const repoMap = new Map(repoRows.map((r) => [r.id, r.ownerUsername ? `${r.ownerUsername}/${r.name}` : r.name]));
  const gistMap = new Map(gistRows.map((g) => [g.id, g.description || g.id.slice(0, 8)]));
  const orgMap = new Map(orgRows.map((o) => [o.id, o.displayName]));

  const reportsWithTarget = items.map((r) => {
    let targetDisplayName: string | null = null;
    if (r.targetType === "user") targetDisplayName = userMap.get(r.targetId) ?? null;
    else if (r.targetType === "repository") targetDisplayName = repoMap.get(r.targetId) ?? null;
    else if (r.targetType === "gist") targetDisplayName = gistMap.get(r.targetId) ?? null;
    else if (r.targetType === "organization") targetDisplayName = orgMap.get(r.targetId) ?? null;
    return { ...r, targetDisplayName };
  });

  return c.json({ reports: reportsWithTarget, hasMore });
});

app.get("/api/admin/reports/:id", async (c) => {
  const id = c.req.param("id");
  const [row] = await db
    .select({
      report: reports,
      reporterUsername: users.username,
      reporterName: users.name,
      reporterEmail: users.email,
    })
    .from(reports)
    .leftJoin(users, eq(users.id, reports.reporterId))
    .where(eq(reports.id, id))
    .limit(1);

  if (!row) {
    return c.json({ error: "Report not found" }, 404);
  }
  return c.json({
    ...row.report,
    reporterUsername: row.reporterUsername,
    reporterName: row.reporterName,
    reporterEmail: row.reporterEmail,
  });
});

app.patch("/api/admin/reports/:id", async (c) => {
  const id = c.req.param("id");
  const actor = c.get("user")!;
  const body = await c.req.json().catch(() => ({}));
  const status = body.status;
  const adminNotes = typeof body.adminNotes === "string" ? body.adminNotes : undefined;

  const updates: {
    status?: (typeof REPORT_STATUSES)[number];
    adminNotes?: string;
    resolvedById?: string;
    resolvedAt?: Date;
    updatedAt: Date;
  } = {
    updatedAt: new Date(),
  };
  if (status && REPORT_STATUSES.includes(status as (typeof REPORT_STATUSES)[number])) {
    updates.status = status as (typeof REPORT_STATUSES)[number];
    if (status === "resolved" || status === "dismissed") {
      updates.resolvedById = actor.id;
      updates.resolvedAt = new Date();
    }
  }
  if (adminNotes !== undefined) updates.adminNotes = adminNotes;

  const [updated] = await db.update(reports).set(updates).where(eq(reports.id, id)).returning();
  if (!updated) {
    return c.json({ error: "Report not found" }, 404);
  }
  return c.json(updated);
});

app.post("/api/admin/reports/:id/actions", async (c) => {
  const id = c.req.param("id");
  const actor = c.get("user")!;
  const body = await c.req.json().catch(() => ({}));
  const action = body.action;
  if (!action || !REPORT_ACTIONS.includes(action as (typeof REPORT_ACTIONS)[number])) {
    return c.json({ error: "Invalid action" }, 400);
  }

  const [report] = await db.select().from(reports).where(eq(reports.id, id)).limit(1);
  if (!report) {
    return c.json({ error: "Report not found" }, 404);
  }

  const now = new Date();

  if (action === "dismiss") {
    await db
      .update(reports)
      .set({ status: "dismissed", resolvedById: actor.id, resolvedAt: now, updatedAt: now })
      .where(eq(reports.id, id));
    await logAuditEvent(actor.id, "report.dismiss", "report", id);
    return c.json({ success: true, status: "dismissed" });
  }

  if (action === "resolve") {
    await db
      .update(reports)
      .set({ status: "resolved", resolvedById: actor.id, resolvedAt: now, updatedAt: now })
      .where(eq(reports.id, id));
    await logAuditEvent(actor.id, "report.resolve", "report", id);
    return c.json({ success: true, status: "resolved" });
  }

  if (action === "take_down") {
    if (report.targetType === "repository") {
      const [repo] = await db.select().from(repositories).where(eq(repositories.id, report.targetId)).limit(1);
      if (repo) {
        await db.update(repositories).set({ visibility: "private", updatedAt: now }).where(eq(repositories.id, report.targetId));
        await logAuditEvent(actor.id, "report.take_down", "repository", report.targetId, { reportId: id });
      }
    } else if (report.targetType === "gist") {
      const [gist] = await db.select().from(gists).where(eq(gists.id, report.targetId)).limit(1);
      if (gist) {
        await db.update(gists).set({ visibility: "secret", updatedAt: now }).where(eq(gists.id, report.targetId));
        await logAuditEvent(actor.id, "report.take_down", "gist", report.targetId, { reportId: id });
      }
    }
    await db
      .update(reports)
      .set({ status: "resolved", resolvedById: actor.id, resolvedAt: now, updatedAt: now })
      .where(eq(reports.id, id));
    return c.json({ success: true, status: "resolved" });
  }

  if (action === "warn_user") {
    let userId: string | null = null;
    if (report.targetType === "user") userId = report.targetId;
    else if (report.targetType === "repository") {
      const [repo] = await db.select({ ownerId: repositories.ownerId }).from(repositories).where(eq(repositories.id, report.targetId)).limit(1);
      userId = repo?.ownerId ?? null;
    } else if (report.targetType === "gist") {
      const [g] = await db.select({ ownerId: gists.ownerId }).from(gists).where(eq(gists.id, report.targetId)).limit(1);
      userId = g?.ownerId ?? null;
    }
    if (userId) {
      await db.insert(notifications).values({
        userId,
        type: "admin_warning",
        title: "Content report warning",
        body: "Your content has been reported. Please review our community guidelines.",
        actorId: actor.id,
      });
      await logAuditEvent(actor.id, "report.warn_user", "user", userId, { reportId: id });
    }
    await db
      .update(reports)
      .set({ status: "reviewing", updatedAt: now })
      .where(eq(reports.id, id));
    return c.json({ success: true });
  }

  if (action === "ban_user") {
    let userId: string | null = null;
    if (report.targetType === "user") userId = report.targetId;
    else if (report.targetType === "repository") {
      const [repo] = await db.select({ ownerId: repositories.ownerId }).from(repositories).where(eq(repositories.id, report.targetId)).limit(1);
      userId = repo?.ownerId ?? null;
    } else if (report.targetType === "gist") {
      const [g] = await db.select({ ownerId: gists.ownerId }).from(gists).where(eq(gists.id, report.targetId)).limit(1);
      userId = g?.ownerId ?? null;
    }
    if (userId) {
      await db.update(users).set({ role: "user", updatedAt: now }).where(eq(users.id, userId));
      await logAuditEvent(actor.id, "report.ban_user", "user", userId, { reportId: id });
    }
    await db
      .update(reports)
      .set({ status: "resolved", resolvedById: actor.id, resolvedAt: now, updatedAt: now })
      .where(eq(reports.id, id));
    return c.json({ success: true, status: "resolved" });
  }

  return c.json({ error: "Invalid action" }, 400);
});

// --- Admin DMCA ---

app.get("/api/admin/dmca/counts", async (c) => {
  const [pendingRow] = await db
    .select({ count: count() })
    .from(dmcaRequests)
    .where(eq(dmcaRequests.status, "pending"));
  return c.json({ pending: pendingRow?.count ?? 0 });
});

app.get("/api/admin/dmca", async (c) => {
  const status = c.req.query("status");
  const limit = parseLimit(c.req.query("limit"), 20, 100);
  const offset = parseOffset(c.req.query("offset"), 0);

  const conditions = [];
  if (status && DMCA_STATUSES.includes(status as (typeof DMCA_STATUSES)[number])) {
    conditions.push(eq(dmcaRequests.status, status as (typeof DMCA_STATUSES)[number]));
  }
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const list = await db
    .select({
      id: dmcaRequests.id,
      requesterId: dmcaRequests.requesterId,
      targetType: dmcaRequests.targetType,
      targetId: dmcaRequests.targetId,
      copyrightHolder: dmcaRequests.copyrightHolder,
      copyrightHolderEmail: dmcaRequests.copyrightHolderEmail,
      status: dmcaRequests.status,
      createdAt: dmcaRequests.createdAt,
      requesterUsername: users.username,
      requesterName: users.name,
    })
    .from(dmcaRequests)
    .leftJoin(users, eq(users.id, dmcaRequests.requesterId))
    .where(whereClause)
    .orderBy(desc(dmcaRequests.createdAt))
    .limit(limit + 1)
    .offset(offset);

  const hasMore = list.length > limit;
  const items = list.slice(0, limit);

  // Resolve target display names (repo: owner/name, gist: description or id)
  const repoIds = [...new Set(items.filter((r) => r.targetType === "repository").map((r) => r.targetId))];
  const gistIds = [...new Set(items.filter((r) => r.targetType === "gist").map((r) => r.targetId))];

  const [repoRows, gistRows] = await Promise.all([
    repoIds.length > 0
      ? db
          .select({
            id: repositories.id,
            name: repositories.name,
            ownerUsername: users.username,
          })
          .from(repositories)
          .leftJoin(users, eq(users.id, repositories.ownerId))
          .where(inArray(repositories.id, repoIds))
      : [],
    gistIds.length > 0
      ? db.select({ id: gists.id, description: gists.description }).from(gists).where(inArray(gists.id, gistIds))
      : [],
  ]);

  const repoMap = new Map(repoRows.map((r) => [r.id, r.ownerUsername ? `${r.ownerUsername}/${r.name}` : r.name]));
  const gistMap = new Map(gistRows.map((g) => [g.id, g.description || g.id.slice(0, 8)]));

  const requestsWithTarget = items.map((r) => {
    let targetDisplayName: string | null = null;
    if (r.targetType === "repository") targetDisplayName = repoMap.get(r.targetId) ?? null;
    else if (r.targetType === "gist") targetDisplayName = gistMap.get(r.targetId) ?? null;
    return { ...r, targetDisplayName };
  });

  return c.json({ requests: requestsWithTarget, hasMore });
});

app.get("/api/admin/dmca/:id", async (c) => {
  const id = c.req.param("id");
  const [row] = await db
    .select({
      request: dmcaRequests,
      requesterUsername: users.username,
      requesterName: users.name,
      requesterEmail: users.email,
    })
    .from(dmcaRequests)
    .leftJoin(users, eq(users.id, dmcaRequests.requesterId))
    .where(eq(dmcaRequests.id, id))
    .limit(1);

  if (!row) {
    return c.json({ error: "DMCA request not found" }, 404);
  }
  return c.json({
    ...row.request,
    requesterUsername: row.requesterUsername,
    requesterName: row.requesterName,
    requesterEmail: row.requesterEmail,
  });
});

app.patch("/api/admin/dmca/:id", async (c) => {
  const id = c.req.param("id");
  const actor = c.get("user")!;
  const body = await c.req.json().catch(() => ({}));
  const status = body.status;
  const adminNotes = typeof body.adminNotes === "string" ? body.adminNotes : undefined;

  const updates: {
    status?: (typeof DMCA_STATUSES)[number];
    adminNotes?: string;
    resolvedById?: string;
    resolvedAt?: Date;
    updatedAt: Date;
  } = {
    updatedAt: new Date(),
  };
  if (status && DMCA_STATUSES.includes(status as (typeof DMCA_STATUSES)[number])) {
    updates.status = status as (typeof DMCA_STATUSES)[number];
    if (status === "approved" || status === "rejected" || status === "counter_filed") {
      updates.resolvedById = actor.id;
      updates.resolvedAt = new Date();
    }
  }
  if (adminNotes !== undefined) updates.adminNotes = adminNotes;

  const [updated] = await db.update(dmcaRequests).set(updates).where(eq(dmcaRequests.id, id)).returning();
  if (!updated) {
    return c.json({ error: "DMCA request not found" }, 404);
  }
  return c.json(updated);
});

app.post("/api/admin/dmca/:id/actions", async (c) => {
  const id = c.req.param("id");
  const actor = c.get("user")!;
  const body = await c.req.json().catch(() => ({}));
  const action = body.action;
  if (!action || !DMCA_ACTIONS.includes(action as (typeof DMCA_ACTIONS)[number])) {
    return c.json({ error: "Invalid action" }, 400);
  }

  const [request] = await db.select().from(dmcaRequests).where(eq(dmcaRequests.id, id)).limit(1);
  if (!request) {
    return c.json({ error: "DMCA request not found" }, 404);
  }

  const now = new Date();

  if (action === "dismiss") {
    await db
      .update(dmcaRequests)
      .set({ status: "rejected", resolvedById: actor.id, resolvedAt: now, updatedAt: now })
      .where(eq(dmcaRequests.id, id));
    await logAuditEvent(actor.id, "dmca.dismiss", "dmca_request", id);
    return c.json({ success: true, status: "rejected" });
  }

  if (action === "reject") {
    const reason = typeof body.reason === "string" ? body.reason : "";
    await db
      .update(dmcaRequests)
      .set({ status: "rejected", adminNotes: reason || undefined, resolvedById: actor.id, resolvedAt: now, updatedAt: now })
      .where(eq(dmcaRequests.id, id));
    await logAuditEvent(actor.id, "dmca.reject", "dmca_request", id, { reason });
    return c.json({ success: true, status: "rejected" });
  }

  if (action === "approve_takedown") {
    if (request.targetType === "repository") {
      const [repo] = await db.select().from(repositories).where(eq(repositories.id, request.targetId)).limit(1);
      if (repo) {
        await db.update(repositories).set({ visibility: "private", updatedAt: now }).where(eq(repositories.id, request.targetId));
        await logAuditEvent(actor.id, "dmca.approve_takedown", "repository", request.targetId, { dmcaId: id });
      }
    } else if (request.targetType === "gist") {
      const [gist] = await db.select().from(gists).where(eq(gists.id, request.targetId)).limit(1);
      if (gist) {
        await db.update(gists).set({ visibility: "secret", updatedAt: now }).where(eq(gists.id, request.targetId));
        await logAuditEvent(actor.id, "dmca.approve_takedown", "gist", request.targetId, { dmcaId: id });
      }
    }
    await db
      .update(dmcaRequests)
      .set({ status: "approved", resolvedById: actor.id, resolvedAt: now, updatedAt: now })
      .where(eq(dmcaRequests.id, id));
    return c.json({ success: true, status: "approved" });
  }

  return c.json({ error: "Invalid action" }, 400);
});

export default app;
