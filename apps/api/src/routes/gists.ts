import { Hono } from "hono";
import { db, gists, gistFiles, gistComments, gistStars, gistForks, users } from "@sigmagit/db";
import { eq, and, sql, desc, count, or, ilike, inArray } from "drizzle-orm";
import { authMiddleware, requireAuth, type AuthVariables } from "../middleware/auth";
import { parseLimit, parseOffset } from "../lib/validation";
import { randomUUID } from "crypto";
import { writeRateLimit } from "../middleware/rate-limit";

const app = new Hono<{ Variables: AuthVariables }>();

const GIST_VISIBILITIES = ["public", "secret"] as const;
type GistVisibility = (typeof GIST_VISIBILITIES)[number];

function isGistVisibility(value: unknown): value is GistVisibility {
  return typeof value === "string" && GIST_VISIBILITIES.includes(value as GistVisibility);
}


function groupFilesByGistId(files: Array<{ gistId: string }>) {
  const filesByGistId = new Map<string, Array<(typeof files)[number]>>();
  for (const file of files) {
    if (!filesByGistId.has(file.gistId)) {
      filesByGistId.set(file.gistId, []);
    }
    filesByGistId.get(file.gistId)!.push(file);
  }
  return filesByGistId;
}

async function attachFilesToGists<T extends { id: string }>(gistsList: T[]) {
  if (gistsList.length === 0) return gistsList.map((gist) => ({ ...gist, files: [] as unknown[] }));

  const gistIds = gistsList.map((gist) => gist.id);
  const files = await db.select().from(gistFiles).where(inArray(gistFiles.gistId, gistIds));
  const filesByGistId = groupFilesByGistId(files);

  return gistsList.map((gist) => ({
    ...gist,
    files: filesByGistId.get(gist.id) || [],
  }));
}

async function attachFilesAndOwnersToGists<T extends { id: string; ownerId: string }>(gistsList: T[]) {
  if (gistsList.length === 0) {
    return gistsList.map((gist) => ({ ...gist, files: [] as unknown[], owner: null as unknown }));
  }

  const gistIds = gistsList.map((gist) => gist.id);
  const ownerIds = [...new Set(gistsList.map((gist) => gist.ownerId))];

  const [files, owners] = await Promise.all([
    db.select().from(gistFiles).where(inArray(gistFiles.gistId, gistIds)),
    db
      .select({
        id: users.id,
        username: users.username,
        name: users.name,
        avatarUrl: users.avatarUrl,
      })
      .from(users)
      .where(inArray(users.id, ownerIds)),
  ]);

  const filesByGistId = groupFilesByGistId(files);
  const ownersById = new Map(owners.map((owner) => [owner.id, owner]));

  return gistsList.map((gist) => ({
    ...gist,
    files: filesByGistId.get(gist.id) || [],
    owner: ownersById.get(gist.ownerId) || null,
  }));
}

app.post("/api/gists", requireAuth, writeRateLimit, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.json();
  const { description, visibility, files } = body;

  const visibilityVal = visibility ?? "public";
  if (!isGistVisibility(visibilityVal)) {
    return c.json({ error: "Invalid visibility; must be public or secret" }, 400);
  }
  if (!Array.isArray(files)) {
    return c.json({ error: "files must be an array" }, 400);
  }

  const [gist] = await db
    .insert(gists)
    .values({
      ownerId: user.id,
      description: description ?? null,
      visibility: visibilityVal,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  for (const file of files) {
    await db.insert(gistFiles).values({
      gistId: gist.id,
      filename: file.filename,
      content: file.content,
      language: file.language,
      size: file.content.length,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  const filesList = await db
    .select()
    .from(gistFiles)
    .where(eq(gistFiles.gistId, gist.id));

  return c.json({ ...gist, files: filesList || [] });
});

app.get("/api/gists", requireAuth, async (c) => {
  const user = c.get("user")!;

  const gistsList = await db
    .select()
    .from(gists)
    .where(eq(gists.ownerId, user.id))
    .orderBy(desc(gists.updatedAt));

  const gistsWithFiles = await attachFilesToGists(gistsList);

  return c.json({ gists: gistsWithFiles });
});

app.get("/api/gists/public", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 20);
  const offset = parseOffset(c.req.query("offset"), 0);

  const gistsList = await db
    .select()
    .from(gists)
    .where(eq(gists.visibility, "public"))
    .orderBy(desc(gists.updatedAt))
    .limit(limit + 1)
    .offset(offset);

  const hasMore = gistsList.length > limit;
  const gistsData = gistsList.slice(0, limit);

  const gistsWithFilesAndOwners = await attachFilesAndOwnersToGists(gistsData);

  return c.json({ gists: gistsWithFilesAndOwners, hasMore });
});

app.get("/api/gists/:id", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");

  const [gist] = await db
    .select()
    .from(gists)
    .where(eq(gists.id, id));

  if (!gist) {
    return c.json({ error: "Gist not found" }, 404);
  }

  if (gist.visibility === "secret" && gist.ownerId !== user?.id) {
    return c.json({ error: "Gist not found" }, 404);
  }

  const [owner] = await db
    .select()
    .from(users)
    .where(eq(users.id, gist.ownerId));

  const filesList = await db
    .select()
    .from(gistFiles)
    .where(eq(gistFiles.gistId, gist.id));

  return c.json({ ...gist, owner, files: filesList || [] });
});

app.patch("/api/gists/:id", requireAuth, async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const body = await c.req.json();

  const [gist] = await db
    .select()
    .from(gists)
    .where(eq(gists.id, id));

  if (!gist) {
    return c.json({ error: "Gist not found" }, 404);
  }

  if (gist.ownerId !== user.id) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const updates: Record<string, unknown> = {};
  if (body.description !== undefined) updates.description = body.description;
  if (body.visibility !== undefined) {
    if (!isGistVisibility(body.visibility)) {
      return c.json({ error: "Invalid visibility; must be public or secret" }, 400);
    }
    updates.visibility = body.visibility;
  }

  await db
    .update(gists)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(gists.id, id));

  if (body.files) {
    for (const file of body.files) {
      if (file.content === undefined) continue;

      const updateData: Record<string, unknown> = {
        content: file.content,
        size: file.content.length,
        updatedAt: new Date(),
      };
      
      if (file.language !== undefined) {
        updateData.language = file.language;
      }
      
      if (file.filename !== undefined) {
        updateData.filename = file.filename;
      }

      await db
        .update(gistFiles)
        .set(updateData)
        .where(
          and(
            eq(gistFiles.gistId, id),
            file.id ? eq(gistFiles.id, file.id) : eq(gistFiles.filename, file.filename)
          )
        );
    }
  }

  const [updated] = await db.select().from(gists).where(eq(gists.id, id));
  const filesList = await db
    .select()
    .from(gistFiles)
    .where(eq(gistFiles.gistId, id));

  return c.json({ ...updated, files: filesList || [] });
});

app.delete("/api/gists/:id", requireAuth, async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");

  const [gist] = await db.select().from(gists).where(eq(gists.id, id));
  if (!gist) return c.json({ error: "Gist not found" }, 404);
  if (gist.ownerId !== user.id) return c.json({ error: "Forbidden" }, 403);

  await db.delete(gists).where(eq(gists.id, id));
  return c.json({ success: true });
});

// POST /api/gists/:id/delete — same as DELETE but avoids CORS preflight.
// A simple POST (no body, no custom headers) uses session cookie for auth,
// which means no preflight request is triggered at all.
app.post("/api/gists/:id/delete", requireAuth, async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");

  const [gist] = await db.select().from(gists).where(eq(gists.id, id));
  if (!gist) return c.json({ error: "Gist not found" }, 404);
  if (gist.ownerId !== user.id) return c.json({ error: "Forbidden" }, 403);

  await db.delete(gists).where(eq(gists.id, id));
  return c.json({ success: true });
});

app.get("/api/gists/:id/revisions", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");

  const [gist] = await db
    .select()
    .from(gists)
    .where(eq(gists.id, id));

  if (!gist) {
    return c.json({ error: "Gist not found" }, 404);
  }

  if (gist.visibility === "secret" && gist.ownerId !== user?.id) {
    return c.json({ error: "Gist not found" }, 404);
  }

  return c.json({ revisions: [] });
});

app.post("/api/gists/:id/star", requireAuth, async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");

  const [gist] = await db
    .select()
    .from(gists)
    .where(eq(gists.id, id));

  if (!gist) {
    return c.json({ error: "Gist not found" }, 404);
  }

  const [existing] = await db
    .select()
    .from(gistStars)
    .where(
      and(
        eq(gistStars.userId, user.id),
        eq(gistStars.gistId, id)
      )
    );

  if (existing) {
    await db
      .delete(gistStars)
      .where(
        and(
          eq(gistStars.userId, user.id),
          eq(gistStars.gistId, id)
        )
      );
    return c.json({ starred: false });
  }

  await db.insert(gistStars).values({
    userId: user.id,
    gistId: id,
    createdAt: new Date(),
  });

  return c.json({ starred: true });
});

app.get("/api/gists/:id/star", requireAuth, async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");

  const [starred] = await db
    .select()
    .from(gistStars)
    .where(
      and(
        eq(gistStars.userId, user.id),
        eq(gistStars.gistId, id)
      )
    );

  return c.json({ starred: !!starred });
});

app.post("/api/gists/:id/fork", requireAuth, async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");

  const [gist] = await db
    .select()
    .from(gists)
    .where(eq(gists.id, id));

  if (!gist) {
    return c.json({ error: "Gist not found" }, 404);
  }

  const [fork] = await db
    .insert(gistForks)
    .values({
      gistId: id,
      forkedFromId: id,
      ownerId: user.id,
      createdAt: new Date(),
    })
    .returning();

  const filesList = await db
    .select()
    .from(gistFiles)
    .where(eq(gistFiles.gistId, id));

  for (const file of filesList) {
    await db.insert(gistFiles).values({
      gistId: fork.id,
      filename: file.filename,
      content: file.content,
      language: file.language,
      size: file.size,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  return c.json({ id: fork.id });
});

app.get("/api/gists/:id/forks", async (c) => {
  const id = c.req.param("id");
  const limit = parseLimit(c.req.query("limit"), 20);
  const offset = parseOffset(c.req.query("offset"), 0);

  const forksList = await db
    .select({
      fork: gistForks,
      owner: users,
    })
    .from(gistForks)
    .innerJoin(users, eq(gistForks.ownerId, users.id))
    .where(eq(gistForks.gistId, id))
    .orderBy(desc(gistForks.createdAt))
    .limit(limit + 1)
    .offset(offset);

  const hasMore = forksList.length > limit;
  const forksData = forksList.slice(0, limit);

  return c.json({ forks: forksData, hasMore });
});

app.get("/api/gists/:id/comments", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");

  const [gist] = await db
    .select()
    .from(gists)
    .where(eq(gists.id, id));

  if (!gist) {
    return c.json({ error: "Gist not found" }, 404);
  }

  if (gist.visibility === "secret" && gist.ownerId !== user?.id) {
    return c.json({ error: "Gist not found" }, 404);
  }

  const comments = await db
    .select({
      comment: gistComments,
      author: users,
    })
    .from(gistComments)
    .innerJoin(users, eq(gistComments.authorId, users.id))
    .where(eq(gistComments.gistId, id))
    .orderBy(desc(gistComments.createdAt));

  return c.json({ comments });
});

app.post("/api/gists/:id/comments", requireAuth, async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const body = await c.req.json();
  const { body: commentBody } = body;

  const [gist] = await db
    .select()
    .from(gists)
    .where(eq(gists.id, id));

  if (!gist) {
    return c.json({ error: "Gist not found" }, 404);
  }

  const [comment] = await db
    .insert(gistComments)
    .values({
      gistId: id,
      authorId: user.id,
      body: commentBody,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  const [author] = await db
    .select()
    .from(users)
    .where(eq(users.id, user.id));

  return c.json({ ...comment, author });
});

app.get("/api/users/:username/gists", async (c) => {
  const username = c.req.param("username");
  const limit = parseLimit(c.req.query("limit"), 20);
  const offset = parseOffset(c.req.query("offset"), 0);

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.username, username));

  if (!user) {
    return c.json({ error: "User not found" }, 404);
  }

  const gistsList = await db
    .select()
    .from(gists)
    .where(
      and(
        eq(gists.ownerId, user.id),
        eq(gists.visibility, "public")
      )
    )
    .orderBy(desc(gists.updatedAt))
    .limit(limit + 1)
    .offset(offset);

  const hasMore = gistsList.length > limit;
  const gistsData = gistsList.slice(0, limit);

  const gistsWithFiles = await attachFilesToGists(gistsData);

  return c.json({ gists: gistsWithFiles, hasMore });
});

export default app;
