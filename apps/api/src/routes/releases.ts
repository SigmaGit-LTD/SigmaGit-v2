import { randomUUID } from "crypto";
import { Hono } from "hono";
import { db, releases, releaseAssets, releaseComments, releaseReactions, repositories, users } from "@sigmagit/db";
import { eq, and, sql, desc, count } from "drizzle-orm";
import { authMiddleware, requireAuth, type AuthVariables } from "../middleware/auth";
import { putObject, getObjectStream, deleteObject } from "../storage";

const app = new Hono<{ Variables: AuthVariables }>();


app.get("/api/repositories/:owner/:name/releases", async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const user = c.get("user");
  const includeDrafts = c.req.query("draft") === "true";

  const [repo] = await db
    .select()
    .from(repositories)
    .where(
      and(
        eq(repositories.name, name),
        eq(users.username, owner)
      )
    )
    .innerJoin(users, eq(repositories.ownerId, users.id));

  if (!repo) {
    return c.json({ error: "Repository not found" }, 404);
  }

  const releasesList = await db
    .select()
    .from(releases)
    .where(
      and(
        eq(releases.repositoryId, repo.repositories.id),
        includeDrafts ? undefined : eq(releases.isDraft, false)
      )
    )
    .orderBy(desc(releases.createdAt));

  return c.json({ releases: releasesList });
});

app.get("/api/repositories/:owner/:name/releases/latest", async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const user = c.get("user");

  const [repo] = await db
    .select()
    .from(repositories)
    .where(
      and(
        eq(repositories.name, name),
        eq(users.username, owner)
      )
    )
    .innerJoin(users, eq(repositories.ownerId, users.id));

  if (!repo) {
    return c.json({ error: "Repository not found" }, 404);
  }

  const [release] = await db
    .select()
    .from(releases)
    .where(
      and(
        eq(releases.repositoryId, repo.repositories.id),
        eq(releases.isDraft, false),
        eq(releases.isPrerelease, false)
      )
    )
    .orderBy(desc(releases.publishedAt))
    .limit(1);

  if (!release) {
    return c.json({ error: "No release found" }, 404);
  }

  const [assets] = await db
    .select()
    .from(releaseAssets)
    .where(eq(releaseAssets.releaseId, release.id));

  return c.json({ ...release, assets });
});

app.get("/api/repositories/:owner/:name/releases/tag/:tag", async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const tag = c.req.param("tag");
  const user = c.get("user");

  const [repo] = await db
    .select()
    .from(repositories)
    .where(
      and(
        eq(repositories.name, name),
        eq(users.username, owner)
      )
    )
    .innerJoin(users, eq(repositories.ownerId, users.id));

  if (!repo) {
    return c.json({ error: "Repository not found" }, 404);
  }

  const [release] = await db
    .select()
    .from(releases)
    .where(
      and(
        eq(releases.repositoryId, repo.repositories.id),
        eq(releases.tagName, tag)
      )
    );

  if (!release) {
    return c.json({ error: "Release not found" }, 404);
  }

  const [assets] = await db
    .select()
    .from(releaseAssets)
    .where(eq(releaseAssets.releaseId, release.id));

  return c.json({ ...release, assets });
});

app.post("/api/repositories/:owner/:name/releases", requireAuth, async (c) => {
  const user = c.get("user")!;
  const owner = c.req.param("owner");
  const repoName = c.req.param("name");
  const body = await c.req.json();
  const { tagName, name: releaseName, body: releaseBody, isDraft, isPrerelease, targetCommitish } = body;

  const [repo] = await db
    .select()
    .from(repositories)
    .where(
      and(
        eq(repositories.name, repoName),
        eq(users.username, owner)
      )
    )
    .innerJoin(users, eq(repositories.ownerId, users.id));

  if (!repo) {
    return c.json({ error: "Repository not found" }, 404);
  }

  if (repo.repositories.ownerId !== user.id) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const [existingRelease] = await db
    .select()
    .from(releases)
    .where(
      and(
        eq(releases.repositoryId, repo.repositories.id),
        eq(releases.tagName, tagName)
      )
    );

  if (existingRelease) {
    return c.json({ error: "Release with this tag already exists" }, 400);
  }

  const [release] = await db
    .insert(releases)
    .values({
      repositoryId: repo.repositories.id,
      authorId: user.id,
      tagName,
      name: releaseName,
      body: releaseBody,
      isDraft: isDraft || false,
      isPrerelease: isPrerelease || false,
      targetCommitish: targetCommitish || "main",
      publishedAt: isDraft ? null : new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  return c.json({ data: release });
});

app.patch("/api/repositories/:owner/:name/releases/:id", requireAuth, async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const owner = c.req.param("owner");
  const repoName = c.req.param("name");
  const body = await c.req.json();

  const [repo] = await db
    .select()
    .from(repositories)
    .where(
      and(
        eq(repositories.name, repoName),
        eq(users.username, owner)
      )
    )
    .innerJoin(users, eq(repositories.ownerId, users.id));

  if (!repo) {
    return c.json({ error: "Repository not found" }, 404);
  }

  const [release] = await db
    .select()
    .from(releases)
    .where(
      and(
        eq(releases.id, id),
        eq(releases.repositoryId, repo.repositories.id)
      )
    );

  if (!release) {
    return c.json({ error: "Release not found" }, 404);
  }

  if (release.authorId !== user.id) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.body !== undefined) updates.body = body.body;
  if (body.isDraft !== undefined) updates.isDraft = body.isDraft;
  if (!updates.isDraft && !release.publishedAt) updates.publishedAt = new Date();

  const [updated] = await db
    .update(releases)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(releases.id, id))
    .returning();

  return c.json({ data: updated });
});

app.delete("/api/repositories/:owner/:name/releases/:id", requireAuth, async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const owner = c.req.param("owner");
  const repoName = c.req.param("name");

  const [repo] = await db
    .select()
    .from(repositories)
    .where(
      and(
        eq(repositories.name, repoName),
        eq(users.username, owner)
      )
    )
    .innerJoin(users, eq(repositories.ownerId, users.id));

  if (!repo) {
    return c.json({ error: "Repository not found" }, 404);
  }

  const [release] = await db
    .select()
    .from(releases)
    .where(
      and(
        eq(releases.id, id),
        eq(releases.repositoryId, repo.repositories.id)
      )
    );

  if (!release) {
    return c.json({ error: "Release not found" }, 404);
  }

  if (release.authorId !== user.id) {
    return c.json({ error: "Forbidden" }, 403);
  }

  await db.delete(releases).where(eq(releases.id, id));

  return c.json({ success: true });
});

app.post("/api/repositories/:owner/:name/releases/:id/publish", requireAuth, async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const owner = c.req.param("owner");
  const repoName = c.req.param("name");

  const [repo] = await db
    .select()
    .from(repositories)
    .where(
      and(
        eq(repositories.name, repoName),
        eq(users.username, owner)
      )
    )
    .innerJoin(users, eq(repositories.ownerId, users.id));

  if (!repo) {
    return c.json({ error: "Repository not found" }, 404);
  }

  const [release] = await db
    .select()
    .from(releases)
    .where(
      and(
        eq(releases.id, id),
        eq(releases.repositoryId, repo.repositories.id)
      )
    );

  if (!release) {
    return c.json({ error: "Release not found" }, 404);
  }

  if (release.authorId !== user.id) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const [updated] = await db
    .update(releases)
    .set({ isDraft: false, publishedAt: new Date(), updatedAt: new Date() })
    .where(eq(releases.id, id))
    .returning();

  return c.json({ data: updated });
});

app.post("/api/repositories/:owner/:name/releases/:id/assets", requireAuth, async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const owner = c.req.param("owner");
  const repoName = c.req.param("name");

  const [repo] = await db
    .select()
    .from(repositories)
    .where(
      and(
        eq(repositories.name, repoName),
        eq(users.username, owner)
      )
    )
    .innerJoin(users, eq(repositories.ownerId, users.id));

  if (!repo) {
    return c.json({ error: "Repository not found" }, 404);
  }

  const [release] = await db
    .select()
    .from(releases)
    .where(
      and(
        eq(releases.id, id),
        eq(releases.repositoryId, repo.repositories.id)
      )
    );

  if (!release) {
    return c.json({ error: "Release not found" }, 404);
  }

  if (release.authorId !== user.id) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const formData = await c.req.formData();
  const file = formData.get("asset") ?? formData.get("file");
  if (!file || !(file instanceof File)) {
    return c.json({ error: "Missing file: send as 'asset' or 'file' in multipart/form-data" }, 400);
  }

  const MAX_ASSET_SIZE = 100 * 1024 * 1024; // 100MB
  if (file.size > MAX_ASSET_SIZE) {
    return c.json({ error: "File too large; max 100MB" }, 413);
  }

  const rawName = file.name || "asset";
  const sanitized = rawName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200) || "asset";
  const contentType = file.type || "application/octet-stream";
  const unique = randomUUID();
  const storageKey = `releases/${owner}/${repoName}/${id}/${unique}_${sanitized}`;

  const buffer = Buffer.from(await file.arrayBuffer());
  await putObject(storageKey, buffer, contentType);

  const [asset] = await db
    .insert(releaseAssets)
    .values({
      releaseId: id,
      name: rawName,
      contentType,
      size: BigInt(file.size),
      storageKey,
      uploaderId: user.id,
      createdAt: new Date(),
    })
    .returning();

  return c.json({ data: asset });
});

app.get("/api/repositories/:owner/:name/releases/:id/assets", async (c) => {
  const id = c.req.param("id");

  const assets = await db
    .select()
    .from(releaseAssets)
    .where(eq(releaseAssets.releaseId, id));

  return c.json({ assets });
});

app.get("/api/repositories/:owner/:name/releases/:id/assets/:assetId", async (c) => {
  const id = c.req.param("id");
  const assetId = c.req.param("assetId");
  const owner = c.req.param("owner");
  const repoName = c.req.param("name");

  const [repo] = await db
    .select()
    .from(repositories)
    .where(
      and(
        eq(repositories.name, repoName),
        eq(users.username, owner)
      )
    )
    .innerJoin(users, eq(repositories.ownerId, users.id));

  if (!repo) {
    return c.json({ error: "Repository not found" }, 404);
  }

  const [release] = await db
    .select()
    .from(releases)
    .where(
      and(
        eq(releases.id, id),
        eq(releases.repositoryId, repo.repositories.id)
      )
    );

  if (!release) {
    return c.json({ error: "Release not found" }, 404);
  }

  const [asset] = await db
    .select()
    .from(releaseAssets)
    .where(
      and(
        eq(releaseAssets.id, assetId),
        eq(releaseAssets.releaseId, release.id)
      )
    );

  if (!asset) {
    return c.json({ error: "Asset not found" }, 404);
  }

  const stream = await getObjectStream(asset.storageKey);
  if (!stream) {
    return c.json({ error: "Asset file not found in storage" }, 404);
  }

  const disposition = `attachment; filename="${asset.name.replace(/"/g, '\\"')}"`;
  return new Response(stream, {
    headers: {
      "Content-Type": asset.contentType,
      "Content-Disposition": disposition,
    },
  });
});

app.delete("/api/repositories/:owner/:name/releases/:id/assets/:assetId", requireAuth, async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const assetId = c.req.param("assetId");
  const owner = c.req.param("owner");
  const repoName = c.req.param("name");

  const [repo] = await db
    .select()
    .from(repositories)
    .where(
      and(
        eq(repositories.name, repoName),
        eq(users.username, owner)
      )
    )
    .innerJoin(users, eq(repositories.ownerId, users.id));

  if (!repo) {
    return c.json({ error: "Repository not found" }, 404);
  }

  const [release] = await db
    .select()
    .from(releases)
    .where(
      and(
        eq(releases.id, id),
        eq(releases.repositoryId, repo.repositories.id)
      )
    );

  if (!release) {
    return c.json({ error: "Release not found" }, 404);
  }

  if (release.authorId !== user.id) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const [asset] = await db
    .select()
    .from(releaseAssets)
    .where(eq(releaseAssets.id, assetId));

  if (!asset) {
    return c.json({ error: "Asset not found" }, 404);
  }

  try {
    await deleteObject(asset.storageKey);
  } catch (err) {
    console.error("[Releases] Failed to delete asset from storage:", err);
  }
  await db.delete(releaseAssets).where(eq(releaseAssets.id, assetId));

  return c.json({ success: true });
});

export default app;
