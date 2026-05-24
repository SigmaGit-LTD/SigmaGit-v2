import { Hono } from "hono";
import { db, users, repositories, stars, repoBranchMetadata } from "@sigmagit/db";
import { eq, sql, and } from "drizzle-orm";
import { requireAuth, type AuthVariables } from "../middleware/auth";
import { parseLimit, parseOffset, sanitizePathForGit } from "../lib/validation";
import { canAccessRepository } from "../lib/access";
import { resolveRepositoryBySlug, createRepoGitStore } from "../lib/repo-helpers";
import { deliverWebhookEvent } from "./repo-webhooks";
import {
  listBranchesCached,
  getCommitsCached,
  getCommitCountCached,
  getTreeCached,
  getFileCached,
  getBlobByOid,
  getCommitByOid,
  getCommitDiff,
  createBranch,
  deleteBranch,
  commitFile,
  listTags,
  createTag,
  deleteTag,
  type CommitInfo,
} from "../git";

const app = new Hono<{ Variables: AuthVariables }>();

async function getForkCount(repoId: string): Promise<number> {
  const [countRow] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(repositories)
    .where(eq(repositories.forkedFromId, repoId));
  return Number(countRow?.count) || 0;
}

async function getForkedFromInfo(forkedFromId: string | null, currentUserId?: string) {
  if (!forkedFromId) {
    return null;
  }

  const [row] = await db
    .select({
      id: repositories.id,
      name: repositories.name,
      visibility: repositories.visibility,
      ownerId: repositories.ownerId,
      username: users.username,
      userName: users.name,
      avatarUrl: users.avatarUrl,
    })
    .from(repositories)
    .innerJoin(users, eq(users.id, repositories.ownerId))
    .where(eq(repositories.id, forkedFromId))
    .limit(1);

  if (!row) {
    return null;
  }

  const userObj = currentUserId ? { id: currentUserId } : null;
  if (!(await canAccessRepository({ id: row.id, ownerId: row.ownerId, visibility: row.visibility }, userObj))) {
    return null;
  }

  return {
    id: row.id,
    name: row.name,
    owner: {
      id: row.ownerId,
      username: row.username,
      name: row.userName,
      avatarUrl: row.avatarUrl,
    },
  };
}

async function getUsersByEmails(emails: string[]): Promise<Map<string, { id: string; username: string; avatarUrl: string | null }>> {
  if (emails.length === 0) return new Map();

  const result = await db
    .select({
      email: users.email,
      id: users.id,
      username: users.username,
      avatarUrl: users.avatarUrl,
    })
    .from(users)
    .where(sql`${users.email} IN ${emails}`);

  return new Map(result.map((u) => [u.email, { id: u.id, username: u.username, avatarUrl: u.avatarUrl }]));
}

app.get("/api/repositories/:owner/:name/branches", async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const currentUser = c.get("user");

  const repo = await resolveRepositoryBySlug(owner, name);
  if (!repo) {
    return c.json({ error: "Repository not found" }, 404);
  }

  const store = createRepoGitStore(repo);

  if (!(await canAccessRepository(repo, currentUser))) {
    return c.json({ error: "Repository not found" }, 404);
  }

  const branches = await listBranchesCached(store);
  return c.json({ branches });
});

app.post("/api/repositories/:owner/:name/branches", requireAuth, async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const currentUser = c.get("user")!;
  const body = await c.req.json<{ branch: string; fromRef: string }>();

  if (!body.branch || !body.fromRef) {
    return c.json({ error: "branch and fromRef are required" }, 400);
  }
  if (!/^[a-zA-Z0-9_.\-/]+$/.test(body.branch)) {
    return c.json({ error: "Invalid branch name" }, 400);
  }

  const repo = await resolveRepositoryBySlug(owner, name);
  if (!repo) return c.json({ error: "Repository not found" }, 404);
  const store = createRepoGitStore(repo);

  if (!(await canAccessRepository(repo, currentUser, true))) {
    return c.json({ error: "Not authorized" }, 403);
  }

  const branches = await listBranchesCached(store);
  if (branches.includes(body.branch)) {
    return c.json({ error: "Branch already exists" }, 400);
  }

  const created = await createBranch(store.fs, store.dir, body.branch, body.fromRef);
  if (!created) return c.json({ error: "Failed to create branch" }, 500);

  // Fire webhook
  deliverWebhookEvent(repo.id, "branch", {
    action: "created",
    ref: body.branch,
    oid: created.oid,
    repository: { owner, name: repo.name },
    sender: { id: currentUser.id, username: currentUser.username },
  }).catch(() => {});

  return c.json({ branch: body.branch, oid: created.oid });
});

app.delete("/api/repositories/:owner/:name/branches/:branch", requireAuth, async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const branch = c.req.param("branch");
  const currentUser = c.get("user")!;

  const repo = await resolveRepositoryBySlug(owner, name);
  if (!repo) return c.json({ error: "Repository not found" }, 404);
  const store = createRepoGitStore(repo);

  if (currentUser.id !== repo.ownerId) {
    return c.json({ error: "Not authorized" }, 403);
  }
  if (branch === repo.defaultBranch) {
    return c.json({ error: "Cannot delete the default branch" }, 400);
  }

  const deleted = await deleteBranch(store.fs, store.dir, branch);
  if (!deleted) return c.json({ error: "Failed to delete branch" }, 500);

  // Invalidate metadata cache
  await db.delete(repoBranchMetadata).where(
    and(eq(repoBranchMetadata.repoId, repo.id), eq(repoBranchMetadata.branch, branch))
  );

  // Fire webhook
  deliverWebhookEvent(repo.id, "branch", {
    action: "deleted",
    ref: branch,
    repository: { owner, name: repo.name },
    sender: { id: currentUser.id, username: currentUser.username },
  }).catch(() => {});

  return c.json({ success: true });
});

app.patch("/api/repositories/:owner/:name/default-branch", requireAuth, async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const currentUser = c.get("user")!;
  const body = await c.req.json<{ branch: string }>();

  if (!body.branch || typeof body.branch !== "string") {
    return c.json({ error: "branch is required" }, 400);
  }
  if (!/^[a-zA-Z0-9_.\-/]+$/.test(body.branch)) {
    return c.json({ error: "Invalid branch name" }, 400);
  }

  const repo = await resolveRepositoryBySlug(owner, name);
  if (!repo) return c.json({ error: "Repository not found" }, 404);
  const store = createRepoGitStore(repo);

  if (currentUser.id !== repo.ownerId) {
    return c.json({ error: "Not authorized" }, 403);
  }

  const branches = await listBranchesCached(store);
  if (!branches.includes(body.branch)) {
    return c.json({ error: "Branch not found" }, 400);
  }

  await db
    .update(repositories)
    .set({ defaultBranch: body.branch, updatedAt: new Date() })
    .where(eq(repositories.id, repo.id));

  return c.json({ defaultBranch: body.branch });
});

// ─── Web-based file editing ──────────────────────────────────────────────────

app.post("/api/repositories/:owner/:name/file", requireAuth, async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const currentUser = c.get("user")!;
  const body = await c.req.json<{
    branch: string;
    path: string;
    content?: string;
    message: string;
    delete?: boolean;
  }>();

  if (!body.branch || !body.path || !body.message) {
    return c.json({ error: "branch, path, and message are required" }, 400);
  }
  const path = sanitizePathForGit(body.path);
  if (path === null) {
    return c.json({ error: "Invalid path" }, 400);
  }

  const repo = await resolveRepositoryBySlug(owner, name);
  if (!repo) return c.json({ error: "Repository not found" }, 404);
  const store = createRepoGitStore(repo);

  if (currentUser.id !== repo.ownerId) {
    return c.json({ error: "Not authorized" }, 403);
  }

  const gitEmail = currentUser.gitEmail || currentUser.email;

  const committed = await commitFile(
    store,
    body.branch,
    path,
    body.content ?? "",
    body.message,
    currentUser.name,
    gitEmail,
    body.delete ?? false
  );

  if (!committed) return c.json({ error: "Failed to commit file" }, 500);

  await db.update(repoBranchMetadata).set({ updatedAt: new Date() }).where(
    and(eq(repoBranchMetadata.repoId, repo.id), eq(repoBranchMetadata.branch, body.branch))
  );

  return c.json({ success: true, commitOid: committed.commitOid });
});

// ─── Tag management ──────────────────────────────────────────────────────────

app.get("/api/repositories/:owner/:name/tags", async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const currentUser = c.get("user");

  const repo = await resolveRepositoryBySlug(owner, name);
  if (!repo) return c.json({ error: "Repository not found" }, 404);
  const store = createRepoGitStore(repo);

  if (!(await canAccessRepository(repo, currentUser))) {
    return c.json({ error: "Repository not found" }, 404);
  }

  const tags = await listTags(store.fs, store.dir);
  return c.json({ tags });
});

app.post("/api/repositories/:owner/:name/tags", requireAuth, async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const currentUser = c.get("user")!;
  const body = await c.req.json<{
    name: string;
    ref: string;
    message?: string;
  }>();

  if (!body.name || !body.ref) {
    return c.json({ error: "name and ref are required" }, 400);
  }
  if (!/^[a-zA-Z0-9_.\-/]+$/.test(body.name)) {
    return c.json({ error: "Invalid tag name" }, 400);
  }

  const repo = await resolveRepositoryBySlug(owner, name);
  if (!repo) return c.json({ error: "Repository not found" }, 404);
  const store = createRepoGitStore(repo);

  if (currentUser.id !== repo.ownerId) {
    return c.json({ error: "Not authorized" }, 403);
  }

  const gitEmail = currentUser.gitEmail || currentUser.email;
  const created = await createTag(
    store.fs,
    store.dir,
    body.name,
    body.ref,
    body.message,
    body.message ? currentUser.name : undefined,
    body.message ? gitEmail : undefined
  );

  if (!created) return c.json({ error: "Failed to create tag" }, 500);

  // Fire webhook
  deliverWebhookEvent(repo.id, "tag", {
    action: "created",
    tag: body.name,
    oid: created.oid,
    repository: { owner, name: repo.name },
    sender: { id: currentUser.id, username: currentUser.username },
  }).catch(() => {});

  return c.json({ tag: body.name, oid: created.oid });
});

app.delete("/api/repositories/:owner/:name/tags/:tag", requireAuth, async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const tag = c.req.param("tag");
  const currentUser = c.get("user")!;

  const repo = await resolveRepositoryBySlug(owner, name);
  if (!repo) return c.json({ error: "Repository not found" }, 404);
  const store = createRepoGitStore(repo);

  if (currentUser.id !== repo.ownerId) {
    return c.json({ error: "Not authorized" }, 403);
  }

  const deleted = await deleteTag(store.fs, store.dir, tag);
  if (!deleted) return c.json({ error: "Failed to delete tag" }, 500);

  // Fire webhook
  deliverWebhookEvent(repo.id, "tag", {
    action: "deleted",
    tag,
    repository: { owner, name: repo.name },
    sender: { id: currentUser.id, username: currentUser.username },
  }).catch(() => {});

  return c.json({ success: true });
});

app.get("/api/repositories/:owner/:name/commits", async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const currentUser = c.get("user");
  const branch = c.req.query("branch") || "main";
  const limit = parseLimit(c.req.query("limit"), 30);
  const skip = parseOffset(c.req.query("skip"), 0);

  const repo = await resolveRepositoryBySlug(owner, name);
  if (!repo) {
    return c.json({ error: "Repository not found" }, 404);
  }

  const store = createRepoGitStore(repo);

  if (!(await canAccessRepository(repo, currentUser))) {
    return c.json({ error: "Repository not found" }, 404);
  }

  const { commits, hasMore } = await getCommitsCached(store, branch, limit, skip);

  const emails = commits.map((c) => c.author.email);
  const userMap = await getUsersByEmails(emails);

  const enrichedCommits = commits.map((commit) => {
    const user = userMap.get(commit.author.email);
    return {
      ...commit,
      author: {
        ...commit.author,
        username: user?.username,
        userId: user?.id,
        avatarUrl: user?.avatarUrl,
      },
    };
  });

  return c.json({ commits: enrichedCommits, hasMore });
});

app.get("/api/repositories/:owner/:name/commits/count", async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const currentUser = c.get("user");
  const branch = c.req.query("branch") || "main";

  const repo = await resolveRepositoryBySlug(owner, name);
  if (!repo) {
    return c.json({ error: "Repository not found" }, 404);
  }

  const store = createRepoGitStore(repo);

  if (!(await canAccessRepository(repo, currentUser))) {
    return c.json({ error: "Repository not found" }, 404);
  }

  const metadata = await db.query.repoBranchMetadata.findFirst({
    where: and(eq(repoBranchMetadata.repoId, repo.id), eq(repoBranchMetadata.branch, branch)),
  });

  if (metadata) {
    return c.json({ count: metadata.commitCount });
  }

  const count = await getCommitCountCached(store, branch);
  return c.json({ count });
});

app.get("/api/repositories/:owner/:name/commits/:oid/diff", async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const oid = c.req.param("oid");
  const currentUser = c.get("user");

  const repo = await resolveRepositoryBySlug(owner, name);
  if (!repo) {
    return c.json({ error: "Repository not found" }, 404);
  }

  const store = createRepoGitStore(repo);

  if (!(await canAccessRepository(repo, currentUser))) {
    return c.json({ error: "Repository not found" }, 404);
  }

  const diff = await getCommitDiff(store.fs, store.dir, oid);
  if (!diff) {
    return c.json({ error: "Commit not found" }, 404);
  }

  const userMap = await getUsersByEmails([diff.commit.author.email]);
  const user = userMap.get(diff.commit.author.email);

  return c.json({
    commit: {
      ...diff.commit,
      author: {
        name: diff.commit.author.name,
        username: user?.username,
        userId: user?.id,
        avatarUrl: user?.avatarUrl,
      },
    },
    parent: diff.parent,
    files: diff.files,
    stats: diff.stats,
  });
});

app.get("/api/repositories/:owner/:name/tree", async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const currentUser = c.get("user");
  const branch = c.req.query("branch") || "main";
  const rawPath = c.req.query("path") || "";
  const path = sanitizePathForGit(rawPath);
  if (path === null) {
    return c.json({ error: "Invalid path" }, 400);
  }

  const repo = await resolveRepositoryBySlug(owner, name);
  if (!repo) {
    return c.json({ error: "Repository not found" }, 404);
  }

  const store = createRepoGitStore(repo);

  if (!(await canAccessRepository(repo, currentUser))) {
    return c.json({ error: "Repository not found" }, 404);
  }

  if (path === "") {
    const metadata = await db.query.repoBranchMetadata.findFirst({
      where: and(eq(repoBranchMetadata.repoId, repo.id), eq(repoBranchMetadata.branch, branch)),
    });

    if (metadata?.rootTree) {
      return c.json({
        files: metadata.rootTree,
        isEmpty: (metadata.rootTree as any[]).length === 0,
      });
    }
  }

  const files = await getTreeCached(store, branch, path);

  return c.json({
    files: files || [],
    isEmpty: !files || files.length === 0,
  });
});

app.get("/api/repositories/:owner/:name/tree-commits", async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const currentUser = c.get("user");
  const branch = c.req.query("branch") || "main";
  const rawPath = c.req.query("path") || "";
  const path = sanitizePathForGit(rawPath);
  if (path === null) {
    return c.json({ error: "Invalid path" }, 400);
  }

  const repo = await resolveRepositoryBySlug(owner, name);
  if (!repo) {
    return c.json({ error: "Repository not found" }, 404);
  }

  const store = createRepoGitStore(repo);

  if (!(await canAccessRepository(repo, currentUser))) {
    return c.json({ error: "Repository not found" }, 404);
  }

  const files = await getTreeCached(store, branch, path);
  if (!files || files.length === 0) {
    return c.json({ files: [] });
  }

  return c.json({ files: files.map((f) => ({ ...f, lastCommit: null })) });
});

app.get("/api/repositories/:owner/:name/file", async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const currentUser = c.get("user");
  const branch = c.req.query("branch") || "main";
  const rawPath = c.req.query("path");
  if (!rawPath) {
    return c.json({ error: "Path is required" }, 400);
  }
  const path = sanitizePathForGit(rawPath);
  if (path === null) {
    return c.json({ error: "Invalid path" }, 400);
  }

  const repo = await resolveRepositoryBySlug(owner, name);
  if (!repo) {
    return c.json({ error: "Repository not found" }, 404);
  }

  const store = createRepoGitStore(repo);

  if (!(await canAccessRepository(repo, currentUser))) {
    return c.json({ error: "Repository not found" }, 404);
  }

  const file = await getFileCached(store, branch, path);
  if (!file) {
    return c.json({ error: "File not found" }, 404);
  }

  return c.json({
    content: file.content,
    oid: file.oid,
    path,
  });
});

app.get("/api/repositories/:owner/:name/readme-oid", async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const currentUser = c.get("user");
  const branch = c.req.query("branch") || "main";

  const repo = await resolveRepositoryBySlug(owner, name);
  if (!repo) {
    return c.json({ error: "Repository not found" }, 404);
  }

  const store = createRepoGitStore(repo);

  if (!(await canAccessRepository(repo, currentUser))) {
    return c.json({ error: "Repository not found" }, 404);
  }

  const metadata = await db.query.repoBranchMetadata.findFirst({
    where: and(eq(repoBranchMetadata.repoId, repo.id), eq(repoBranchMetadata.branch, branch)),
  });

  if (metadata?.readmeOid) {
    const content = await getBlobByOid(store.fs, store.dir, metadata.readmeOid);
    if (content) {
      return c.json({ readmeOid: metadata.readmeOid });
    }
  }

  const files = await getTreeCached(store, branch, "");
  const readme = files?.find((f) => f.name.toLowerCase() === "readme.md" && f.type === "blob");

  return c.json({ readmeOid: readme?.oid || null });
});

app.get("/api/repositories/:owner/:name/readme", async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const currentUser = c.get("user");
  const oid = c.req.query("oid");

  if (!oid) {
    return c.json({ error: "OID is required" }, 400);
  }

  const repo = await resolveRepositoryBySlug(owner, name);
  if (!repo) {
    return c.json({ error: "Repository not found" }, 404);
  }

  const store = createRepoGitStore(repo);

  if (!(await canAccessRepository(repo, currentUser))) {
    return c.json({ error: "Repository not found" }, 404);
  }

  const content = await getBlobByOid(store.fs, store.dir, oid);
  if (!content) {
    return c.json({ error: "Readme not found" }, 404);
  }

  return c.json({ content });
});

app.get("/api/repositories/:owner/:name/info", async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const currentUser = c.get("user");

  const result = await db
    .select({
      id: repositories.id,
      name: repositories.name,
      description: repositories.description,
      ownerId: repositories.ownerId,
      visibility: repositories.visibility,
      defaultBranch: repositories.defaultBranch,
      createdAt: repositories.createdAt,
      updatedAt: repositories.updatedAt,
      forkedFromId: repositories.forkedFromId,
      username: users.username,
      userName: users.name,
      avatarUrl: users.avatarUrl,
    })
    .from(repositories)
    .innerJoin(users, eq(users.id, repositories.ownerId))
    .where(and(eq(users.username, owner), eq(repositories.name, name)))
    .limit(1);

  const row = result[0];
  if (!row) {
    return c.json({ error: "Repository not found" }, 404);
  }

  if (!(await canAccessRepository({ id: row.id, ownerId: row.ownerId, visibility: row.visibility }, currentUser))) {
    return c.json({ error: "Repository not found" }, 404);
  }

  const [starCount] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(stars)
    .where(eq(stars.repositoryId, row.id));

  let starred = false;
  if (currentUser) {
    const existing = await db.query.stars.findFirst({
      where: and(eq(stars.userId, currentUser.id), eq(stars.repositoryId, row.id)),
    });
    starred = !!existing;
  }

  const isOwner = currentUser?.id === row.ownerId;
  const forkedFrom = await getForkedFromInfo(row.forkedFromId, currentUser?.id);
  const forkCount = await getForkCount(row.id);

  return c.json({
    repo: {
      id: row.id,
      name: row.name,
      description: row.description,
      visibility: row.visibility,
      defaultBranch: row.defaultBranch,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      owner: {
        id: row.ownerId,
        username: row.username,
        name: row.userName,
        avatarUrl: row.avatarUrl,
      },
      starCount: Number(starCount?.count) || 0,
      starred,
      forkedFrom,
      forkCount,
    },
    isOwner,
  });
});

app.get("/api/repositories/:owner/:name/page-data", async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const currentUser = c.get("user");

  const repo = await resolveRepositoryBySlug(owner, name);
  if (!repo) {
    return c.json({ error: "Repository not found" }, 404);
  }

  if (!(await canAccessRepository(repo, currentUser))) {
    return c.json({ error: "Repository not found" }, 404);
  }

  return c.json({ isOwner: currentUser?.id === repo.ownerId });
});

export default app;
