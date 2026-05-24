import { Hono } from "hono";
import { db, users, repositories, issues, pullRequests } from "@sigmagit/db";
import { eq, and, or, ilike, desc } from "drizzle-orm";
import { type AuthVariables } from "../middleware/auth";
import { parseLimit, parseOffset } from "../lib/validation";
import { canAccessRepository, type AccessUser, type Repository } from "../lib/access";

const app = new Hono<{ Variables: AuthVariables }>();

type SearchResultType = "repository" | "issue" | "pull_request" | "user";

type SearchResult = {
  type: SearchResultType;
  id: string;
  title: string;
  description?: string | null;
  url: string;
  owner?: { username: string; avatarUrl: string | null };
  repository?: { name: string; owner: string };
  state?: string;
  number?: number;
  createdAt: string;
};

async function filterAccessibleRepos<T extends Repository>(repos: T[], user: AccessUser): Promise<T[]> {
  const accessChecks = await Promise.all(
    repos.map(async (repo) => ({
      repo,
      allowed: await canAccessRepository(repo, user),
    }))
  );
  return accessChecks.filter(({ allowed }) => allowed).map(({ repo }) => repo);
}

app.get("/api/search", async (c) => {
  const query = c.req.query("q")?.trim();
  const type = c.req.query("type") || "all";
  const limit = parseLimit(c.req.query("limit"), 20, 50);
  const offset = parseOffset(c.req.query("offset"), 0);
  const currentUser = c.get("user");

  if (!query || query.length < 2) {
    return c.json({ results: [], hasMore: false, total: 0 });
  }

  const searchPattern = `%${query}%`;
  const results: SearchResult[] = [];

  if (type === "all" || type === "repositories" || type === "repos") {
    const repoResults = await db
      .select({
        id: repositories.id,
        name: repositories.name,
        description: repositories.description,
        visibility: repositories.visibility,
        ownerId: repositories.ownerId,
        organizationId: repositories.organizationId,
        ownerUsername: users.username,
        ownerAvatar: users.avatarUrl,
        createdAt: repositories.createdAt,
      })
      .from(repositories)
      .innerJoin(users, eq(users.id, repositories.ownerId))
      .where(
        or(
          ilike(repositories.name, searchPattern),
          ilike(repositories.description, searchPattern)
        )
      )
      .orderBy(desc(repositories.createdAt))
      .limit(type === "all" ? 20 : limit + offset)
      .offset(0);

    const accessibleRepos = await filterAccessibleRepos(repoResults, currentUser);
    const pagedRepos = accessibleRepos.slice(type === "all" ? 0 : offset, type === "all" ? 5 : offset + limit);

    for (const repo of pagedRepos) {
      results.push({
        type: "repository",
        id: repo.id,
        title: repo.name,
        description: repo.description,
        url: `/${repo.ownerUsername}/${repo.name}`,
        owner: { username: repo.ownerUsername, avatarUrl: repo.ownerAvatar },
        createdAt: repo.createdAt.toISOString(),
      });
    }
  }

  if (type === "all" || type === "issues") {
    const issueResults = await db
      .select({
        id: issues.id,
        number: issues.number,
        title: issues.title,
        body: issues.body,
        state: issues.state,
        repoId: repositories.id,
        repoName: repositories.name,
        repoVisibility: repositories.visibility,
        repoOwnerId: repositories.ownerId,
        organizationId: repositories.organizationId,
        ownerUsername: users.username,
        createdAt: issues.createdAt,
      })
      .from(issues)
      .innerJoin(repositories, eq(repositories.id, issues.repositoryId))
      .innerJoin(users, eq(users.id, repositories.ownerId))
      .where(
        or(
          ilike(issues.title, searchPattern),
          ilike(issues.body, searchPattern)
        )
      )
      .orderBy(desc(issues.createdAt))
      .limit(type === "all" ? 20 : limit + offset)
      .offset(0);

    const accessibleIssues = (
      await Promise.all(
        issueResults.map(async (issue) => ({
          issue,
          allowed: await canAccessRepository(
            {
              id: issue.repoId,
              ownerId: issue.repoOwnerId,
              organizationId: issue.organizationId,
              visibility: issue.repoVisibility,
            },
            currentUser
          ),
        }))
      )
    )
      .filter(({ allowed }) => allowed)
      .map(({ issue }) => issue);

    const pagedIssues = accessibleIssues.slice(type === "all" ? 0 : offset, type === "all" ? 5 : offset + limit);

    for (const issue of pagedIssues) {
      results.push({
        type: "issue",
        id: issue.id,
        title: issue.title,
        description: issue.body?.slice(0, 200),
        url: `/${issue.ownerUsername}/${issue.repoName}/issues/${issue.number}`,
        repository: { name: issue.repoName, owner: issue.ownerUsername },
        state: issue.state,
        number: issue.number,
        createdAt: issue.createdAt.toISOString(),
      });
    }
  }

  if (type === "all" || type === "pulls" || type === "prs") {
    const prResults = await db
      .select({
        id: pullRequests.id,
        number: pullRequests.number,
        title: pullRequests.title,
        body: pullRequests.body,
        state: pullRequests.state,
        repoId: repositories.id,
        repoName: repositories.name,
        repoVisibility: repositories.visibility,
        repoOwnerId: repositories.ownerId,
        organizationId: repositories.organizationId,
        ownerUsername: users.username,
        createdAt: pullRequests.createdAt,
      })
      .from(pullRequests)
      .innerJoin(repositories, eq(repositories.id, pullRequests.repositoryId))
      .innerJoin(users, eq(users.id, repositories.ownerId))
      .where(
        or(
          ilike(pullRequests.title, searchPattern),
          ilike(pullRequests.body, searchPattern)
        )
      )
      .orderBy(desc(pullRequests.createdAt))
      .limit(type === "all" ? 20 : limit + offset)
      .offset(0);

    const accessiblePrs = (
      await Promise.all(
        prResults.map(async (pr) => ({
          pr,
          allowed: await canAccessRepository(
            {
              id: pr.repoId,
              ownerId: pr.repoOwnerId,
              organizationId: pr.organizationId,
              visibility: pr.repoVisibility,
            },
            currentUser
          ),
        }))
      )
    )
      .filter(({ allowed }) => allowed)
      .map(({ pr }) => pr);

    const pagedPrs = accessiblePrs.slice(type === "all" ? 0 : offset, type === "all" ? 5 : offset + limit);

    for (const pr of pagedPrs) {
      results.push({
        type: "pull_request",
        id: pr.id,
        title: pr.title,
        description: pr.body?.slice(0, 200),
        url: `/${pr.ownerUsername}/${pr.repoName}/pulls/${pr.number}`,
        repository: { name: pr.repoName, owner: pr.ownerUsername },
        state: pr.state,
        number: pr.number,
        createdAt: pr.createdAt.toISOString(),
      });
    }
  }

  if (type === "all" || type === "users") {
    const userResults = await db
      .select({
        id: users.id,
        username: users.username,
        name: users.name,
        bio: users.bio,
        avatarUrl: users.avatarUrl,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(
        or(
          ilike(users.username, searchPattern),
          ilike(users.name, searchPattern),
          ilike(users.bio, searchPattern)
        )
      )
      .orderBy(desc(users.createdAt))
      .limit(type === "all" ? 5 : limit)
      .offset(type === "all" ? 0 : offset);

    for (const user of userResults) {
      results.push({
        type: "user",
        id: user.id,
        title: user.username,
        description: user.bio || user.name,
        url: `/${user.username}`,
        owner: { username: user.username, avatarUrl: user.avatarUrl },
        createdAt: user.createdAt.toISOString(),
      });
    }
  }

  if (type === "all") {
    results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  return c.json({
    results: results.slice(0, limit),
    hasMore: results.length > limit,
    query,
  });
});

export default app;
