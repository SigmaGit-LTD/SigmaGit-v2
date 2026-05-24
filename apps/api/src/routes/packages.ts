import { Hono } from "hono";
import { db, users, organizations, organizationMembers } from "@sigmagit/db";
import { eq, and } from "drizzle-orm";
import { authMiddleware, requireAuth, type AuthVariables } from "../middleware/auth";
import { listObjects } from "../storage";
import { listManifestRefs } from "../registry/storage";

const app = new Hono<{ Variables: AuthVariables }>();
const REGISTRY_PREFIX = "registry/";


/** Extract unique image names from registry keys under registry/owner/ */
async function getImageNamesForOwner(owner: string): Promise<string[]> {
  const prefix = `${REGISTRY_PREFIX}${owner}/`;
  const keys = await listObjects(prefix);
  const imageNames = new Set<string>();
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    const after = key.slice(prefix.length);
    const manifestIdx = after.indexOf("/manifests/");
    const blobIdx = after.indexOf("/blobs/");
    const end = manifestIdx >= 0 ? manifestIdx : blobIdx >= 0 ? blobIdx : -1;
    if (end >= 0) {
      imageNames.add(after.slice(0, end));
    }
  }
  return Array.from(imageNames);
}

/** Resolve username to owner (user or org). Returns owner type and whether current user can list. */
async function canListPackagesFor(
  currentUserId: string,
  currentUsername: string,
  ownerParam: string
): Promise<{ allowed: boolean; owner: string }> {
  const ownerLower = ownerParam.toLowerCase();
  const [userRow] = await db
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(eq(users.id, currentUserId))
    .limit(1);
  if (userRow?.username?.toLowerCase() === ownerLower) {
    return { allowed: true, owner: userRow.username };
  }
  const [org] = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.name, ownerLower))
    .limit(1);
  if (!org) return { allowed: false, owner: ownerParam };
  const [member] = await db
    .select()
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, org.id),
        eq(organizationMembers.userId, currentUserId)
      )
    )
    .limit(1);
  if (!member) return { allowed: false, owner: ownerParam };
  return { allowed: true, owner: org.name };
}

// GET /api/users/:username/packages
app.get("/api/users/:username/packages", requireAuth, async (c) => {
  const username = c.req.param("username");
  const user = c.get("user")!;
  const { allowed, owner } = await canListPackagesFor(user.id, user.username, username);
  if (!allowed) {
    return c.json({ error: "Forbidden" }, 403);
  }
  const imageNames = await getImageNamesForOwner(owner);
  const packages: { name: string; owner: string; tags: string[] }[] = [];
  for (const imageName of imageNames) {
    try {
      const tags = await listManifestRefs(owner, imageName);
      packages.push({ name: imageName, owner, tags });
    } catch {
      packages.push({ name: imageName, owner, tags: [] });
    }
  }
  return c.json({ packages });
});

// GET /api/users/:username/packages/:image/tags — :image may be URL-encoded (e.g. myorg%2Fnginx)
app.get("/api/users/:username/packages/:image/tags", requireAuth, async (c) => {
  const username = c.req.param("username");
  const image = decodeURIComponent(c.req.param("image"));
  const user = c.get("user")!;
  const { allowed, owner } = await canListPackagesFor(user.id, user.username, username);
  if (!allowed) {
    return c.json({ error: "Forbidden" }, 403);
  }
  try {
    const tags = await listManifestRefs(owner, image);
    return c.json({ name: `${owner}/${image}`, tags });
  } catch {
    return c.json({ error: "Not found" }, 404);
  }
});

// GET /api/organizations/:org/packages
app.get("/api/organizations/:org/packages", requireAuth, async (c) => {
  const org = c.req.param("org");
  const user = c.get("user")!;
  const { allowed, owner } = await canListPackagesFor(user.id, user.username, org);
  if (!allowed) {
    return c.json({ error: "Forbidden" }, 403);
  }
  const imageNames = await getImageNamesForOwner(owner);
  const packages: { name: string; owner: string; tags: string[] }[] = [];
  for (const imageName of imageNames) {
    try {
      const tags = await listManifestRefs(owner, imageName);
      packages.push({ name: imageName, owner, tags });
    } catch {
      packages.push({ name: imageName, owner, tags: [] });
    }
  }
  return c.json({ packages });
});

export default app;
