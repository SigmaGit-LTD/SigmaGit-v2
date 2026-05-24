import { Hono } from "hono";
import { db, organizations, organizationMembers, teams, teamMembers, teamRepositories, organizationInvitations, users, repositories } from "@sigmagit/db";
import { eq, and, sql, desc } from "drizzle-orm";
import { requireAuth, type AuthVariables } from "../middleware/auth";
import { canAccessRepository } from "../lib/access";
import { logAuditEvent } from "./admin";
import { randomUUID } from "crypto";

const app = new Hono<{ Variables: AuthVariables }>();

app.post("/api/organizations", requireAuth, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.json();
  const { name, displayName, description, email, website, location } = body;

  const [existingOrg] = await db.select().from(organizations).where(eq(organizations.name, name.toLowerCase()));
  if (existingOrg) {
    return c.json({ error: "Organization name already taken" }, 400);
  }

  const [org] = await db
    .insert(organizations)
    .values({
      name: name.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
      displayName,
      description,
      email,
      website,
      location,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  await db.insert(organizationMembers).values({
    organizationId: org.id,
    userId: user.id,
    role: "owner",
    createdAt: new Date(),
  });

  await logAuditEvent(
    user.id,
    "org.create",
    "organization",
    org.id,
    { name: org.name },
    c.req.header("x-forwarded-for") || c.req.header("x-real-ip")
  );

  return c.json({ data: org });
});

app.get("/api/organizations/:org", async (c) => {
  const orgName = c.req.param("org");

  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.name, orgName));

  if (!org) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const [memberCount] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(organizationMembers)
    .where(eq(organizationMembers.organizationId, org.id));

  const [repoCount] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(repositories)
    .where(eq(repositories.organizationId, org.id));

  return c.json({
    ...org,
    memberCount: Number(memberCount?.count) || 0,
    repoCount: Number(repoCount?.count) || 0,
  });
});

app.patch("/api/organizations/:org", requireAuth, async (c) => {
  const user = c.get("user")!;
  const orgName = c.req.param("org");
  const body = await c.req.json();

  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.name, orgName));

  if (!org) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const [member] = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, org.id),
        eq(organizationMembers.userId, user.id),
        eq(organizationMembers.role, "owner")
      )
    );

  if (!member) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const updates: Record<string, unknown> = {};
  if (body.displayName !== undefined) updates.displayName = body.displayName;
  if (body.description !== undefined) updates.description = body.description;
  if (body.email !== undefined) updates.email = body.email;
  if (body.website !== undefined) updates.website = body.website;
  if (body.location !== undefined) updates.location = body.location;
  if (body.avatarUrl !== undefined) updates.avatarUrl = body.avatarUrl;

  await db.update(organizations).set({ ...updates, updatedAt: new Date() }).where(eq(organizations.id, org.id));

  await logAuditEvent(
    user.id,
    "org.update",
    "organization",
    org.id,
    { name: org.name, changes: Object.keys(updates) },
    c.req.header("x-forwarded-for") || c.req.header("x-real-ip")
  );

  return c.json({ success: true });
});

app.delete("/api/organizations/:org", requireAuth, async (c) => {
  const user = c.get("user")!;
  const orgName = c.req.param("org");

  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.name, orgName));

  if (!org) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const [member] = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, org.id),
        eq(organizationMembers.userId, user.id),
        eq(organizationMembers.role, "owner")
      )
    );

  if (!member) {
    return c.json({ error: "Forbidden" }, 403);
  }

  await db.delete(organizations).where(eq(organizations.id, org.id));

  await logAuditEvent(
    user.id,
    "org.delete",
    "organization",
    org.id,
    { name: org.name },
    c.req.header("x-forwarded-for") || c.req.header("x-real-ip")
  );

  return c.json({ success: true });
});

app.get("/api/organizations/:org/members", async (c) => {
  const orgName = c.req.param("org");

  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.name, orgName));

  if (!org) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const members = await db
    .select({
      user: users,
      role: organizationMembers.role,
      joinedAt: organizationMembers.createdAt,
    })
    .from(organizationMembers)
    .innerJoin(users, eq(organizationMembers.userId, users.id))
    .where(eq(organizationMembers.organizationId, org.id))
    .orderBy(desc(organizationMembers.createdAt));

  return c.json({ members });
});

app.put("/api/organizations/:org/members/:username", requireAuth, async (c) => {
  const user = c.get("user")!;
  const orgName = c.req.param("org");
  const username = c.req.param("username");
  const body = await c.req.json();
  const { role } = body;

  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.name, orgName));

  if (!org) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const [requester] = await db
    .select()
    .from(organizationMembers)
    .where(eq(organizationMembers.organizationId, org.id));

  if (!requester || (requester.userId !== user.id && requester.role !== "owner")) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const [targetUser] = await db.select().from(users).where(eq(users.username, username));
  if (!targetUser) {
    return c.json({ error: "User not found" }, 404);
  }

  await db
    .insert(organizationMembers)
    .values({
      organizationId: org.id,
      userId: targetUser.id,
      role,
      createdAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [organizationMembers.organizationId, organizationMembers.userId],
      set: { role },
    });

  await logAuditEvent(
    user.id,
    "org.member.update",
    "organization",
    org.id,
    { username, role },
    c.req.header("x-forwarded-for") || c.req.header("x-real-ip")
  );

  return c.json({ success: true });
});

app.delete("/api/organizations/:org/members/:username", requireAuth, async (c) => {
  const user = c.get("user")!;
  const orgName = c.req.param("org");
  const username = c.req.param("username");

  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.name, orgName));

  if (!org) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const [requester] = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, org.id),
        eq(organizationMembers.userId, user.id)
      )
    );

  if (!requester || (requester.role !== "owner" && requester.userId !== user.id)) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const [targetUser] = await db.select().from(users).where(eq(users.username, username));
  if (!targetUser) {
    return c.json({ error: "User not found" }, 404);
  }

  await db
    .delete(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, org.id),
        eq(organizationMembers.userId, targetUser.id)
      )
    );

  await logAuditEvent(
    user.id,
    "org.member.remove",
    "organization",
    org.id,
    { username },
    c.req.header("x-forwarded-for") || c.req.header("x-real-ip")
  );

  return c.json({ success: true });
});

app.get("/api/organizations/:org/teams", requireAuth, async (c) => {
  const user = c.get("user")!;
  const orgName = c.req.param("org");

  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.name, orgName));

  if (!org) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const [member] = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, org.id),
        eq(organizationMembers.userId, user.id)
      )
    );

  if (!member) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const teamsList = await db
    .select()
    .from(teams)
    .where(eq(teams.organizationId, org.id))
    .orderBy(desc(teams.createdAt));

  return c.json({ teams: teamsList });
});

app.post("/api/organizations/:org/teams", requireAuth, async (c) => {
  const user = c.get("user")!;
  const orgName = c.req.param("org");
  const body = await c.req.json();
  const { name, description, permission } = body;

  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.name, orgName));

  if (!org) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const [member] = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, org.id),
        eq(organizationMembers.userId, user.id)
      )
    );

  if (!member || (member.role !== "owner" && member.role !== "admin")) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, "-");

  const [team] = await db
    .insert(teams)
    .values({
      organizationId: org.id,
      name,
      slug,
      description,
      permission: permission || "read",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  await logAuditEvent(
    user.id,
    "team.create",
    "team",
    team.id,
    { org: org.name, name: team.name },
    c.req.header("x-forwarded-for") || c.req.header("x-real-ip")
  );

  return c.json({ data: team });
});

app.get("/api/organizations/:org/teams/:team", requireAuth, async (c) => {
  const user = c.get("user")!;
  const orgName = c.req.param("org");
  const teamSlug = c.req.param("team");

  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.name, orgName));

  if (!org) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const [member] = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, org.id),
        eq(organizationMembers.userId, user.id)
      )
    );

  if (!member) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const [team] = await db
    .select()
    .from(teams)
    .where(
      and(
        eq(teams.organizationId, org.id),
        eq(teams.slug, teamSlug)
      )
    );

  if (!team) {
    return c.json({ error: "Team not found" }, 404);
  }

  const teamMembersList = await db
    .select({
      user: users,
      joinedAt: teamMembers.createdAt,
    })
    .from(teamMembers)
    .innerJoin(users, eq(teamMembers.userId, users.id))
    .where(eq(teamMembers.teamId, team.id));

  const teamRepos = await db
    .select({
      repository: repositories,
      permission: teamRepositories.permission,
    })
    .from(teamRepositories)
    .innerJoin(repositories, eq(teamRepositories.repositoryId, repositories.id))
    .where(eq(teamRepositories.teamId, team.id));

  return c.json({ ...team, members: teamMembersList, repositories: teamRepos });
});

app.delete("/api/organizations/:org/teams/:team", requireAuth, async (c) => {
  const user = c.get("user")!;
  const orgName = c.req.param("org");
  const teamSlug = c.req.param("team");

  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.name, orgName));

  if (!org) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const [member] = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, org.id),
        eq(organizationMembers.userId, user.id)
      )
    );

  if (!member || (member.role !== "owner" && member.role !== "admin")) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const [team] = await db
    .select()
    .from(teams)
    .where(and(eq(teams.organizationId, org.id), eq(teams.slug, teamSlug)));

  if (!team) {
    return c.json({ error: "Team not found" }, 404);
  }

  await db.delete(teams).where(eq(teams.id, team.id));

  await logAuditEvent(
    user.id,
    "team.delete",
    "team",
    team.id,
    { org: org.name, team: team.slug },
    c.req.header("x-forwarded-for") || c.req.header("x-real-ip")
  );

  return c.json({ success: true });
});

app.put("/api/organizations/:org/teams/:team/members", requireAuth, async (c) => {
  const user = c.get("user")!;
  const orgName = c.req.param("org");
  const teamSlug = c.req.param("team");
  const body = await c.req.json<{ username?: string }>();
  const username = body.username?.trim();

  if (!username) {
    return c.json({ error: "Username is required" }, 400);
  }

  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.name, orgName));

  if (!org) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const [requester] = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, org.id),
        eq(organizationMembers.userId, user.id)
      )
    );

  if (!requester || (requester.role !== "owner" && requester.role !== "admin")) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const [team] = await db
    .select()
    .from(teams)
    .where(and(eq(teams.organizationId, org.id), eq(teams.slug, teamSlug)));

  if (!team) {
    return c.json({ error: "Team not found" }, 404);
  }

  const [targetUser] = await db.select().from(users).where(eq(users.username, username));
  if (!targetUser) {
    return c.json({ error: "User not found" }, 404);
  }

  const [orgMember] = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, org.id),
        eq(organizationMembers.userId, targetUser.id)
      )
    );

  if (!orgMember) {
    return c.json({ error: "User must be a member of the organization first" }, 400);
  }

  await db
    .insert(teamMembers)
    .values({
      teamId: team.id,
      userId: targetUser.id,
      createdAt: new Date(),
    })
    .onConflictDoNothing();

  await logAuditEvent(
    user.id,
    "team.member.add",
    "team",
    team.id,
    { org: org.name, team: team.slug, username },
    c.req.header("x-forwarded-for") || c.req.header("x-real-ip")
  );

  return c.json({ success: true });
});

app.delete("/api/organizations/:org/teams/:team/members/:username", requireAuth, async (c) => {
  const user = c.get("user")!;
  const orgName = c.req.param("org");
  const teamSlug = c.req.param("team");
  const username = c.req.param("username");

  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.name, orgName));

  if (!org) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const [requester] = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, org.id),
        eq(organizationMembers.userId, user.id)
      )
    );

  if (!requester || (requester.role !== "owner" && requester.role !== "admin")) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const [team] = await db
    .select()
    .from(teams)
    .where(and(eq(teams.organizationId, org.id), eq(teams.slug, teamSlug)));

  if (!team) {
    return c.json({ error: "Team not found" }, 404);
  }

  const [targetUser] = await db.select().from(users).where(eq(users.username, username));
  if (!targetUser) {
    return c.json({ error: "User not found" }, 404);
  }

  await db
    .delete(teamMembers)
    .where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, targetUser.id)));

  await logAuditEvent(
    user.id,
    "team.member.remove",
    "team",
    team.id,
    { org: org.name, team: team.slug, username },
    c.req.header("x-forwarded-for") || c.req.header("x-real-ip")
  );

  return c.json({ success: true });
});

app.put("/api/organizations/:org/teams/:team/repos/:repo", requireAuth, async (c) => {
  const user = c.get("user")!;
  const orgName = c.req.param("org");
  const teamSlug = c.req.param("team");
  const repoName = c.req.param("repo");
  const body = await c.req.json<{ permission?: "read" | "write" | "admin" }>();
  const permission = body.permission || "read";

  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.name, orgName));

  if (!org) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const [requester] = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, org.id),
        eq(organizationMembers.userId, user.id)
      )
    );

  if (!requester || (requester.role !== "owner" && requester.role !== "admin")) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const [team] = await db
    .select()
    .from(teams)
    .where(and(eq(teams.organizationId, org.id), eq(teams.slug, teamSlug)));

  if (!team) {
    return c.json({ error: "Team not found" }, 404);
  }

  const [repository] = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.organizationId, org.id), eq(repositories.name, repoName)));

  if (!repository) {
    return c.json({ error: "Repository not found" }, 404);
  }

  await db
    .insert(teamRepositories)
    .values({
      teamId: team.id,
      repositoryId: repository.id,
      permission,
      createdAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [teamRepositories.teamId, teamRepositories.repositoryId],
      set: { permission },
    });

  await logAuditEvent(
    user.id,
    "team.repo.add",
    "team",
    team.id,
    { org: org.name, team: team.slug, repo: repoName, permission },
    c.req.header("x-forwarded-for") || c.req.header("x-real-ip")
  );

  return c.json({ success: true });
});

app.delete("/api/organizations/:org/teams/:team/repos/:repo", requireAuth, async (c) => {
  const user = c.get("user")!;
  const orgName = c.req.param("org");
  const teamSlug = c.req.param("team");
  const repoName = c.req.param("repo");

  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.name, orgName));

  if (!org) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const [requester] = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, org.id),
        eq(organizationMembers.userId, user.id)
      )
    );

  if (!requester || (requester.role !== "owner" && requester.role !== "admin")) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const [team] = await db
    .select()
    .from(teams)
    .where(and(eq(teams.organizationId, org.id), eq(teams.slug, teamSlug)));

  if (!team) {
    return c.json({ error: "Team not found" }, 404);
  }

  const [repository] = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.organizationId, org.id), eq(repositories.name, repoName)));

  if (!repository) {
    return c.json({ error: "Repository not found" }, 404);
  }

  await db
    .delete(teamRepositories)
    .where(and(eq(teamRepositories.teamId, team.id), eq(teamRepositories.repositoryId, repository.id)));

  await logAuditEvent(
    user.id,
    "team.repo.remove",
    "team",
    team.id,
    { org: org.name, team: team.slug, repo: repoName },
    c.req.header("x-forwarded-for") || c.req.header("x-real-ip")
  );

  return c.json({ success: true });
});

app.get("/api/organizations/:org/repositories", async (c) => {
  const orgName = c.req.param("org");
  const currentUser = c.get("user");

  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.name, orgName));

  if (!org) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const repos = await db
    .select()
    .from(repositories)
    .where(eq(repositories.organizationId, org.id))
    .orderBy(desc(repositories.createdAt));

  const accessibleRepos = (
    await Promise.all(
      repos.map(async (repo) => ({
        repo,
        allowed: await canAccessRepository(repo, currentUser),
      }))
    )
  )
    .filter(({ allowed }) => allowed)
    .map(({ repo }) => repo);

  const reposWithOwner = accessibleRepos.map((repo) => ({
    ...repo,
    owner: {
      id: org.id,
      username: org.name,
      name: org.displayName,
      avatarUrl: org.avatarUrl,
    },
  }));

  return c.json({ repositories: reposWithOwner });
});

app.post("/api/organizations/:org/invitations", requireAuth, async (c) => {
  const user = c.get("user")!;
  const orgName = c.req.param("org");
  const body = await c.req.json();
  const { email, userId, role, teamIds } = body;

  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.name, orgName));

  if (!org) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const [member] = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, org.id),
        eq(organizationMembers.userId, user.id)
      )
    );

  if (!member || (member.role !== "owner" && member.role !== "admin")) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const token = randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  const [invitation] = await db
    .insert(organizationInvitations)
    .values({
      organizationId: org.id,
      email,
      userId,
      invitedById: user.id,
      role: role || "member",
      teamIds: teamIds || [],
      token,
      expiresAt,
      createdAt: new Date(),
    })
    .returning();

  await logAuditEvent(
    user.id,
    "org.invitation.create",
    "organization",
    org.id,
    { email, userId, role },
    c.req.header("x-forwarded-for") || c.req.header("x-real-ip")
  );

  return c.json({ data: invitation });
});

app.get("/api/organizations/:org/invitations", requireAuth, async (c) => {
  const user = c.get("user")!;
  const orgName = c.req.param("org");

  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.name, orgName));

  if (!org) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const [member] = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, org.id),
        eq(organizationMembers.userId, user.id)
      )
    );

  if (!member || (member.role !== "owner" && member.role !== "admin")) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const invitations = await db
    .select({
      invitation: organizationInvitations,
      invitedBy: users,
    })
    .from(organizationInvitations)
    .innerJoin(users, eq(organizationInvitations.invitedById, users.id))
    .where(
      and(
        eq(organizationInvitations.organizationId, org.id),
        sql`${organizationInvitations.acceptedAt} IS NULL`
      )
    )
    .orderBy(desc(organizationInvitations.createdAt));

  return c.json({ invitations });
});

app.delete("/api/organizations/:org/invitations/:id", requireAuth, async (c) => {
  const user = c.get("user")!;
  const orgName = c.req.param("org");
  const invitationId = c.req.param("id");

  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.name, orgName));

  if (!org) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const [member] = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, org.id),
        eq(organizationMembers.userId, user.id)
      )
    );

  if (!member || (member.role !== "owner" && member.role !== "admin")) {
    return c.json({ error: "Forbidden" }, 403);
  }

  await db
    .delete(organizationInvitations)
    .where(
      and(
        eq(organizationInvitations.id, invitationId),
        eq(organizationInvitations.organizationId, org.id)
      )
    );

  return c.json({ success: true });
});

app.post("/api/invitations/:token/accept", requireAuth, async (c) => {
  const user = c.get("user")!;
  const token = c.req.param("token");

  const [invitation] = await db
    .select()
    .from(organizationInvitations)
    .where(eq(organizationInvitations.token, token));

  if (!invitation) {
    return c.json({ error: "Invitation not found" }, 404);
  }

  if (new Date() > invitation.expiresAt) {
    return c.json({ error: "Invitation expired" }, 400);
  }

  if (invitation.acceptedAt) {
    return c.json({ error: "Invitation already accepted" }, 400);
  }

  await db
    .insert(organizationMembers)
    .values({
      organizationId: invitation.organizationId,
      userId: user.id,
      role: invitation.role,
      createdAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [organizationMembers.organizationId, organizationMembers.userId],
      set: { role: invitation.role },
    });

  await db
    .update(organizationInvitations)
    .set({ acceptedAt: new Date() })
    .where(eq(organizationInvitations.id, invitation.id));

  if (invitation.teamIds) {
    for (const teamId of invitation.teamIds) {
      await db
        .insert(teamMembers)
        .values({
          teamId,
          userId: user.id,
          createdAt: new Date(),
        })
        .onConflictDoNothing();
    }
  }

  return c.json({ success: true });
});

app.get("/api/user/organizations", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ organizations: [] });
  }

  const orgs = await db
    .select({
      organization: organizations,
      role: organizationMembers.role,
      joinedAt: organizationMembers.createdAt,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizationMembers.organizationId, organizations.id))
    .where(eq(organizationMembers.userId, user.id))
    .orderBy(desc(organizationMembers.createdAt));

  return c.json({ organizations: orgs });
});

export default app;
