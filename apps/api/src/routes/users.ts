import { Hono } from "hono";
import { db, users, repositories, stars, organizations, organizationMembers, teams } from "@sigmagit/db";
import { eq, sql, desc, asc, and, inArray } from "drizzle-orm";
import { authMiddleware, requireAuth, type AuthVariables } from "../middleware/auth";
import { parseLimit, parseOffset } from "../lib/validation";
import { appCache, CACHE_TTL, getCached, setCache } from "../redis";

const app = new Hono<{ Variables: AuthVariables }>();


/** Resolve username to either a user or organization in one request. Prefers organization when both exist. */
app.get("/api/users/:username/resolve", async (c) => {
  const username = c.req.param("username");
  const cacheKey = appCache.profileResolveKey(username);
  const currentUser = c.get("user");
  const cached = await getCached<{ type: string; profile?: { id?: string } }>(cacheKey);
  if (cached && !(cached.type === "user" && cached.profile?.id === currentUser?.id)) {
    return c.json(cached);
  }

  const [orgRow, userRow] = await Promise.all([
    db.select().from(organizations).where(eq(organizations.name, username)).limit(1),
    db
      .select({
        id: users.id,
        name: users.name,
        username: users.username,
        bio: users.bio,
        location: users.location,
        website: users.website,
        pronouns: users.pronouns,
        avatarUrl: users.avatarUrl,
        company: users.company,
        socialLinks: users.socialLinks,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
        lastActiveAt: users.lastActiveAt,
        email: users.email,
        emailVerified: users.emailVerified,
      })
      .from(users)
      .where(eq(users.username, username))
      .limit(1),
  ]);

  const org = orgRow[0];
  const user = userRow[0];

  if (org) {
    const [memberCount, repoCount, teamCount] = await Promise.all([
      db.select({ count: sql<number>`COUNT(*)` }).from(organizationMembers).where(eq(organizationMembers.organizationId, org.id)),
      db.select({ count: sql<number>`COUNT(*)` }).from(repositories).where(eq(repositories.organizationId, org.id)),
      db.select({ count: sql<number>`COUNT(*)` }).from(teams).where(eq(teams.organizationId, org.id)),
    ]);
    const payload = {
      type: "organization" as const,
      profile: {
        ...org,
        memberCount: Number(memberCount[0]?.count) || 0,
        repoCount: Number(repoCount[0]?.count) || 0,
        teamCount: Number(teamCount[0]?.count) || 0,
      },
    };
    await setCache(cacheKey, payload, CACHE_TTL.profileResolve);
    return c.json(payload);
  }

  if (user) {
    const isOwnProfile = currentUser?.id === user.id;
    const response: Record<string, unknown> = {
      id: user.id,
      name: user.name,
      username: user.username,
      avatarUrl: cacheBustAvatarUrl(user.avatarUrl, user.updatedAt),
      bio: user.bio,
      location: user.location,
      website: user.website,
      pronouns: user.pronouns,
      company: user.company,
      socialLinks: user.socialLinks,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      lastActiveAt: user.lastActiveAt ?? undefined,
    };
    if (isOwnProfile) {
      response.email = user.email;
      response.emailVerified = user.emailVerified;
    } else {
      const payload = { type: "user" as const, profile: response };
      await setCache(cacheKey, payload, CACHE_TTL.profileResolve);
    }
    return c.json({ type: "user" as const, profile: response });
  }

  return c.json({ error: "Not found" }, 404);
});

function cacheBustAvatarUrl(avatarUrl: string | null, updatedAt: Date): string | null {
  if (!avatarUrl) return null;
  if (avatarUrl.includes("v=")) return avatarUrl;
  const separator = avatarUrl.includes("?") ? "&" : "?";
  return `${avatarUrl}${separator}v=${updatedAt.getTime()}`;
}

app.get("/api/users/me", requireAuth, async (c) => {
  const user = c.get("user")!;
  const result = await db.query.users.findFirst({
    where: eq(users.id, user.id),
  });

  if (!result) {
    return c.json({ error: "User not found" }, 404);
  }

  return c.json(result);
});

app.get("/api/users/me/summary", requireAuth, async (c) => {
  const user = c.get("user")!;
  const result = await db.query.users.findFirst({
    where: eq(users.id, user.id),
    columns: {
      name: true,
      avatarUrl: true,
      updatedAt: true,
    },
  });

  if (!result) {
    return c.json({ error: "User not found" }, 404);
  }

  return c.json({
    name: result.name,
    avatarUrl: cacheBustAvatarUrl(result.avatarUrl, result.updatedAt),
  });
});

app.get("/api/users/public", async (c) => {
  const sortBy = c.req.query("sortBy") || "newest";
  const limit = parseLimit(c.req.query("limit"), 20);
  const offset = parseOffset(c.req.query("offset"), 0);

  const orderBy = sortBy === "oldest" ? asc(users.createdAt) : desc(users.createdAt);

  const usersResult = await db
    .select({
      id: users.id,
      name: users.name,
      username: users.username,
      avatarUrl: users.avatarUrl,
      bio: users.bio,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
      repoCount: sql<number>`(
        SELECT COUNT(*)::int
        FROM ${repositories}
        WHERE ${repositories.ownerId} = ${users.id}::text
        AND ${repositories.visibility} = 'public'
      )`.as("repo_count"),
    })
    .from(users)
    .orderBy(orderBy)
    .limit(limit + 1)
    .offset(offset);

  const result = usersResult.map((user) => ({
    id: user.id,
    name: user.name,
    username: user.username,
        avatarUrl: cacheBustAvatarUrl(user.avatarUrl, user.updatedAt),
    bio: user.bio,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    repoCount: Number(user.repoCount) || 0,
  }));

  const hasMore = result.length > limit;
  const usersData = result.slice(0, limit);

  return c.json({
    users: usersData,
    hasMore,
  });
});

app.get("/api/users/:username/avatar", async (c) => {
  const username = c.req.param("username");

  const result = await db.query.users.findFirst({
    where: eq(users.username, username),
    columns: {
      avatarUrl: true,
      updatedAt: true,
    },
  });

  return c.json({
    avatarUrl: result ? cacheBustAvatarUrl(result.avatarUrl, result.updatedAt) : null,
  });
});

app.get("/api/users/:username", async (c) => {
  const username = c.req.param("username");

  const result = await db.query.users.findFirst({
    where: eq(users.username, username),
    columns: {
      id: true,
      username: true,
      name: true,
      bio: true,
      location: true,
      website: true,
      pronouns: true,
      avatarUrl: true,
      createdAt: true,
    },
  });

  if (!result) {
    return c.json({ error: "User not found" }, 404);
  }

  return c.json(result);
});

app.get("/api/users/:username/profile", async (c) => {
  const username = c.req.param("username");
  const currentUser = c.get("user");

  const result = await db.query.users.findFirst({
    where: eq(users.username, username),
    columns: {
      id: true,
      name: true,
      username: true,
      avatarUrl: true,
      updatedAt: true,
      bio: true,
      location: true,
      website: true,
      pronouns: true,
      company: true,
      gitEmail: true,
      defaultRepositoryVisibility: true,
      preferences: true,
      socialLinks: true,
      createdAt: true,
      lastActiveAt: true,
      email: true,
      emailVerified: true,
    },
  });

  if (!result) {
    return c.json({ error: "User not found" }, 404);
  }

  const isOwnProfile = currentUser?.id === result.id;

  const response: Record<string, unknown> = {
    id: result.id,
    name: result.name,
    username: result.username,
    avatarUrl: cacheBustAvatarUrl(result.avatarUrl, result.updatedAt),
    bio: result.bio,
    location: result.location,
    website: result.website,
    pronouns: result.pronouns,
    company: result.company,
    gitEmail: result.gitEmail,
    defaultRepositoryVisibility: result.defaultRepositoryVisibility,
    preferences: result.preferences,
    socialLinks: result.socialLinks,
    createdAt: result.createdAt,
    updatedAt: result.updatedAt,
    lastActiveAt: result.lastActiveAt ?? undefined,
  };

  if (isOwnProfile) {
    response.email = result.email;
    response.emailVerified = result.emailVerified;
  }

  return c.json(response);
});

/** Lightweight counts for profile tab badges (repo + starred) without loading full lists. */
app.get("/api/users/:username/profile-counts", async (c) => {
  const username = c.req.param("username");

  const userResult = await db.query.users.findFirst({
    where: eq(users.username, username),
    columns: { id: true },
  });

  if (!userResult) {
    return c.json({ repoCount: 0, starredCount: 0 });
  }

  const [repoCountRow, starredCountRow] = await Promise.all([
    db
      .select({ count: sql<number>`COUNT(*)` })
      .from(repositories)
      .where(and(eq(repositories.ownerId, userResult.id), eq(repositories.visibility, "public"))),
    db
      .select({ count: sql<number>`COUNT(*)` })
      .from(stars)
      .innerJoin(repositories, eq(stars.repositoryId, repositories.id))
      .where(and(eq(stars.userId, userResult.id), eq(repositories.visibility, "public"))),
  ]);

  return c.json({
    repoCount: Number(repoCountRow[0]?.count) || 0,
    starredCount: Number(starredCountRow[0]?.count) || 0,
  });
});

app.get("/api/users/:username/starred", async (c) => {
  const username = c.req.param("username");

  const userResult = await db.query.users.findFirst({
    where: eq(users.username, username),
    columns: { id: true },
  });

  if (!userResult) {
    return c.json({ repos: [] });
  }

  const starredRepos = await db
    .select({
      id: repositories.id,
      name: repositories.name,
      description: repositories.description,
      visibility: repositories.visibility,
      defaultBranch: repositories.defaultBranch,
      createdAt: repositories.createdAt,
      updatedAt: repositories.updatedAt,
      ownerId: repositories.ownerId,
      ownerUsername: users.username,
      ownerName: users.name,
      ownerAvatarUrl: users.avatarUrl,
      starredAt: stars.createdAt,
    })
    .from(stars)
    .innerJoin(repositories, eq(stars.repositoryId, repositories.id))
    .innerJoin(users, eq(repositories.ownerId, users.id))
    .where(and(eq(stars.userId, userResult.id), eq(repositories.visibility, "public")))
    .orderBy(desc(stars.createdAt));

  if (starredRepos.length === 0) {
    return c.json({ repos: [] });
  }

  const repoIds = starredRepos.map((r) => r.id);
  const countRows = await db
    .select({
      repositoryId: stars.repositoryId,
      count: sql<number>`COUNT(*)::int`.as("cnt"),
    })
    .from(stars)
    .where(inArray(stars.repositoryId, repoIds))
    .groupBy(stars.repositoryId);

  const countByRepoId = new Map<string, number>();
  for (const row of countRows) {
    countByRepoId.set(row.repositoryId, Number(row.count) || 0);
  }

  const repos = starredRepos.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    visibility: r.visibility,
    defaultBranch: r.defaultBranch,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    starCount: countByRepoId.get(r.id) ?? 0,
    starredAt: r.starredAt,
    owner: {
      id: r.ownerId,
      username: r.ownerUsername,
      name: r.ownerName,
      avatarUrl: r.ownerAvatarUrl,
    },
  }));

  return c.json({ repos });
});

export default app;
