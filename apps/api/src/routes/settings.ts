import { Hono } from "hono";
import { db, users, repositories, accounts, userSshKeys } from "@sigmagit/db";
import { eq, ne, and, isNull } from "drizzle-orm";
import { authMiddleware, requireAuth, invalidateCachedUser, type AuthVariables } from "../middleware/auth";
import { config } from "../config";
import { putObject, deleteObject, deletePrefix, getRepoPrefix } from "../s3";
import { isPasswordCompromised } from "../security/pwned";
import { createHash } from "crypto";

const app = new Hono<{ Variables: AuthVariables }>();


function cacheBustAvatarUrl(avatarUrl: string | null, updatedAt: Date): string | null {
  if (!avatarUrl) return null;
  if (avatarUrl.includes("v=")) return avatarUrl;
  const separator = avatarUrl.includes("?") ? "&" : "?";
  return `${avatarUrl}${separator}v=${updatedAt.getTime()}`;
}

const SUPPORTED_SSH_ALGORITHMS = new Set([
  "ssh-ed25519",
  "ssh-rsa",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "sk-ssh-ed25519@openssh.com",
  "sk-ecdsa-sha2-nistp256@openssh.com",
]);

function readSshBlobString(buf: Buffer, offset: number): { value: string; nextOffset: number } {
  if (offset + 4 > buf.length) {
    throw new Error("Invalid SSH key: malformed key blob");
  }

  const len = buf.readUInt32BE(offset);
  const start = offset + 4;
  const end = start + len;

  if (end > buf.length) {
    throw new Error("Invalid SSH key: malformed key blob");
  }

  return {
    value: buf.subarray(start, end).toString("utf8"),
    nextOffset: end,
  };
}

function parseOpenSshPublicKey(rawPublicKey: string): {
  normalizedPublicKey: string;
  algorithm: string;
  fingerprintSha256: string;
  comment: string | null;
} {
  const normalized = rawPublicKey.trim().replace(/\r?\n/g, "");
  const parts = normalized.split(/\s+/);

  if (parts.length < 2) {
    throw new Error("Invalid SSH key format");
  }

  const algorithm = parts[0];
  const keyData = parts[1];
  const comment = parts.length > 2 ? parts.slice(2).join(" ") : null;

  if (!SUPPORTED_SSH_ALGORITHMS.has(algorithm)) {
    throw new Error("Unsupported SSH key algorithm");
  }

  if (!/^[A-Za-z0-9+/=]+$/.test(keyData)) {
    throw new Error("Invalid SSH key data");
  }

  const blob = Buffer.from(keyData, "base64");
  if (blob.length === 0) {
    throw new Error("Invalid SSH key data");
  }

  const { value: embeddedAlgorithm } = readSshBlobString(blob, 0);
  if (embeddedAlgorithm !== algorithm) {
    throw new Error("Invalid SSH key: algorithm mismatch");
  }

  const digest = createHash("sha256").update(blob).digest("base64").replace(/=+$/g, "");
  const fingerprintSha256 = `SHA256:${digest}`;
  const normalizedPublicKey = `${algorithm} ${keyData}${comment ? ` ${comment}` : ""}`;

  return {
    normalizedPublicKey,
    algorithm,
    fingerprintSha256,
    comment,
  };
}

function getPublicKeyPreview(publicKey: string): string {
  const parts = publicKey.split(/\s+/);
  const keyData = parts[1] ?? "";
  if (keyData.length <= 24) {
    return keyData;
  }
  return `${keyData.slice(0, 12)}...${keyData.slice(-12)}`;
}

function isInternalRequest(c: { req: { header: (name: string) => string | undefined } }): boolean {
  const provided = c.req.header("x-internal-auth");
  return Boolean(provided && provided === config.betterAuthSecret);
}

app.get("/api/settings", requireAuth, async (c) => {
  const user = c.get("user")!;

  const result = await db.query.users.findFirst({
    where: eq(users.id, user.id),
  });

  if (!result) {
    return c.json({ error: "User not found" }, 404);
  }

  return c.json({
    user: {
      ...result,
      avatarUrl: cacheBustAvatarUrl(result.avatarUrl, result.updatedAt),
    },
  });
});

app.patch("/api/settings/profile", requireAuth, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.json<{
    name?: string;
    username?: string;
    bio?: string;
    location?: string;
    website?: string;
    pronouns?: string;
    company?: string;
    gitEmail?: string;
    defaultRepositoryVisibility?: string;
  }>();

  let normalizedUsername = body.username?.toLowerCase().replace(/ /g, "-");

  if (normalizedUsername) {
    if (!/^[a-zA-Z0-9_-]+$/.test(normalizedUsername)) {
      return c.json({ error: "Username can only contain letters, numbers, underscores, and hyphens" }, 400);
    }
    if (normalizedUsername.length < 3) {
      return c.json({ error: "Username must be at least 3 characters" }, 400);
    }

    const existing = await db.query.users.findFirst({
      where: and(eq(users.username, normalizedUsername), ne(users.id, user.id)),
    });

    if (existing) {
      return c.json({ error: "Username is already taken" }, 400);
    }
  }

  if (body.defaultRepositoryVisibility && body.defaultRepositoryVisibility !== "public" && body.defaultRepositoryVisibility !== "private") {
    return c.json({ error: "defaultRepositoryVisibility must be 'public' or 'private'" }, 400);
  }

  const currentUser = await db.query.users.findFirst({
    where: eq(users.id, user.id),
  });

  const finalUsername = normalizedUsername || currentUser?.username;

  await db
    .update(users)
    .set({
      name: body.name ?? currentUser?.name,
      username: finalUsername,
      bio: body.bio ?? currentUser?.bio,
      location: body.location ?? currentUser?.location,
      website: body.website ?? currentUser?.website,
      pronouns: body.pronouns ?? currentUser?.pronouns,
      company: body.company ?? currentUser?.company,
      gitEmail: body.gitEmail ?? currentUser?.gitEmail,
      defaultRepositoryVisibility: (body.defaultRepositoryVisibility as "public" | "private") ?? currentUser?.defaultRepositoryVisibility,
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id));

  return c.json({ success: true, username: finalUsername });
});

app.patch("/api/settings/preferences", requireAuth, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.json<{
    emailNotifications?: boolean;
    theme?: string;
    language?: string;
    showEmail?: boolean;
  }>();

  const currentUser = await db.query.users.findFirst({
    where: eq(users.id, user.id),
  });

  const currentPreferences = (currentUser?.preferences || {}) as Record<string, any>;

  const newPreferences = { ...currentPreferences };
  if (body.emailNotifications !== undefined) newPreferences.emailNotifications = body.emailNotifications;
  if (body.theme !== undefined) newPreferences.theme = body.theme;
  if (body.language !== undefined) newPreferences.language = body.language;
  if (body.showEmail !== undefined) newPreferences.showEmail = body.showEmail;

  await db
    .update(users)
    .set({
      preferences: newPreferences,
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id));

  return c.json({ success: true });
});

app.get("/api/settings/word-wrap", requireAuth, async (c) => {
  const user = c.get("user")!;

  const currentUser = await db.query.users.findFirst({
    where: eq(users.id, user.id),
  });

  const preferences = (currentUser?.preferences || {}) as Record<string, any>;
  const wordWrap = preferences.wordWrap ?? false;

  return c.json({ wordWrap });
});

app.patch("/api/settings/word-wrap", requireAuth, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.json<{ wordWrap: boolean }>();

  const currentUser = await db.query.users.findFirst({
    where: eq(users.id, user.id),
  });

  const currentPreferences = (currentUser?.preferences || {}) as Record<string, any>;
  const newPreferences = { ...currentPreferences, wordWrap: body.wordWrap };

  await db
    .update(users)
    .set({
      preferences: newPreferences,
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id));

  return c.json({ success: true, wordWrap: body.wordWrap });
});

app.patch("/api/settings/email", requireAuth, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.json<{ email: string }>();

  const existing = await db.query.users.findFirst({
    where: and(eq(users.email, body.email), ne(users.id, user.id)),
  });

  if (existing) {
    return c.json({ error: "Email already in use" }, 400);
  }

  const [updated] = await db
    .update(users)
    .set({
      email: body.email,
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id))
    .returning();

  return c.json(updated);
});

app.post("/api/settings/avatar", requireAuth, async (c) => {
  const user = c.get("user")!;
  const formData = await c.req.formData();
  const file = formData.get("avatar") as File | null;

  if (!file) {
    return c.json({ error: "No avatar file provided" }, 400);
  }

  const contentType = file.type;
  if (!contentType.startsWith("image/")) {
    return c.json({ error: "File must be an image" }, 400);
  }

  const data = await file.arrayBuffer();
  if (data.byteLength > 5 * 1024 * 1024) {
    return c.json({ error: "File size must be less than 5MB" }, 400);
  }

  const currentUser = await db.query.users.findFirst({
    where: eq(users.id, user.id),
  });

  if (currentUser?.avatarUrl) {
    const withoutQuery = currentUser.avatarUrl.split("?")[0];
    const filename = withoutQuery.replace("/api/avatar/", "");
    if (filename) {
      const oldKey = `avatars/${filename}`;
      try {
        await deleteObject(oldKey);
      } catch {}
    }
  }

  const ext = file.name.split(".").pop() || "png";
  const key = `avatars/${user.id}.${ext}`;

  await putObject(key, Buffer.from(data), contentType);

  const timestamp = Date.now();
  const avatarUrl = `/api/avatar/${user.id}.${ext}?v=${timestamp}`;

  await db
    .update(users)
    .set({
      avatarUrl,
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id));

  return c.json({ success: true, avatarUrl });
});

app.delete("/api/settings/avatar", requireAuth, async (c) => {
  const user = c.get("user")!;

  const currentUser = await db.query.users.findFirst({
    where: eq(users.id, user.id),
  });

  if (currentUser?.avatarUrl) {
    const withoutQuery = currentUser.avatarUrl.split("?")[0];
    const filename = withoutQuery.replace("/api/avatar/", "");
    if (filename) {
      const oldKey = `avatars/${filename}`;
      try {
        await deleteObject(oldKey);
      } catch {}
    }
  }

  await db
    .update(users)
    .set({
      avatarUrl: null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id));

  return c.json({ success: true, avatarUrl: null });
});

app.patch("/api/settings/social-links", requireAuth, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.json<{
    github?: string;
    twitter?: string;
    linkedin?: string;
    custom?: string[];
  }>();

  const socialLinks: {
    github?: string;
    twitter?: string;
    linkedin?: string;
    custom?: string[];
  } = {};

  if (body.github?.trim()) {
    socialLinks.github = body.github.trim();
  }
  if (body.twitter?.trim()) {
    socialLinks.twitter = body.twitter.trim();
  }
  if (body.linkedin?.trim()) {
    socialLinks.linkedin = body.linkedin.trim();
  }
  if (body.custom?.filter((s) => s.trim()).length) {
    socialLinks.custom = body.custom.filter((s) => s.trim());
  }

  await db
    .update(users)
    .set({
      socialLinks,
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id));

  return c.json({ success: true });
});

app.patch("/api/settings/password", requireAuth, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.json<{
    currentPassword: string;
    newPassword: string;
  }>();

  const account = await db.query.accounts.findFirst({
    where: and(eq(accounts.userId, user.id), eq(accounts.providerId, "credential")),
  });

  if (!account || !account.password) {
    return c.json({ error: "No password set for this account" }, 400);
  }

  const valid = await Bun.password.verify(body.currentPassword, account.password);
  if (!valid) {
    return c.json({ error: "Current password is incorrect" }, 400);
  }

  if (await isPasswordCompromised(body.newPassword)) {
    return c.json(
      {
        code: "PASSWORD_COMPROMISED",
        error: "Please choose a more secure password.",
      },
      400
    );
  }

  const newHash = await Bun.password.hash(body.newPassword, { algorithm: "bcrypt", cost: 12 });

  await db
    .update(accounts)
    .set({
      password: newHash,
      updatedAt: new Date(),
    })
    .where(eq(accounts.id, account.id));

  return c.json({ success: true });
});

app.get("/api/settings/ssh-keys", requireAuth, async (c) => {
  const user = c.get("user")!;

  const keys = await db
    .select({
      id: userSshKeys.id,
      title: userSshKeys.title,
      algorithm: userSshKeys.algorithm,
      publicKey: userSshKeys.publicKey,
      fingerprintSha256: userSshKeys.fingerprintSha256,
      createdAt: userSshKeys.createdAt,
      lastUsedAt: userSshKeys.lastUsedAt,
      revokedAt: userSshKeys.revokedAt,
    })
    .from(userSshKeys)
    .where(eq(userSshKeys.userId, user.id));

  return c.json({
    sshKeys: keys
      .map((key) => {
        const parsed = key.publicKey.split(/\s+/);
        const comment = parsed.length > 2 ? parsed.slice(2).join(" ") : null;
        return {
          id: key.id,
          title: key.title,
          algorithm: key.algorithm,
          fingerprintSha256: key.fingerprintSha256,
          publicKeyPreview: getPublicKeyPreview(key.publicKey),
          comment,
          createdAt: key.createdAt,
          lastUsedAt: key.lastUsedAt,
          revokedAt: key.revokedAt,
        };
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
  });
});

app.post("/api/settings/ssh-keys", requireAuth, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.json<{ title?: string; publicKey?: string }>();

  if (!body.publicKey || typeof body.publicKey !== "string") {
    return c.json({ error: "publicKey is required" }, 400);
  }

  const title = body.title?.trim() || null;
  if (title && title.length > 100) {
    return c.json({ error: "Title must be 100 characters or less" }, 400);
  }

  let parsedKey: ReturnType<typeof parseOpenSshPublicKey>;
  try {
    parsedKey = parseOpenSshPublicKey(body.publicKey);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid SSH key";
    return c.json({ error: message }, 400);
  }

  const existing = await db.query.userSshKeys.findFirst({
    where: eq(userSshKeys.fingerprintSha256, parsedKey.fingerprintSha256),
  });
  if (existing) {
    return c.json({ error: "This SSH key is already registered" }, 409);
  }

  const [created] = await db
    .insert(userSshKeys)
    .values({
      userId: user.id,
      title,
      publicKey: parsedKey.normalizedPublicKey,
      algorithm: parsedKey.algorithm,
      fingerprintSha256: parsedKey.fingerprintSha256,
    })
    .returning({
      id: userSshKeys.id,
      title: userSshKeys.title,
      algorithm: userSshKeys.algorithm,
      publicKey: userSshKeys.publicKey,
      fingerprintSha256: userSshKeys.fingerprintSha256,
      createdAt: userSshKeys.createdAt,
      lastUsedAt: userSshKeys.lastUsedAt,
      revokedAt: userSshKeys.revokedAt,
    });

  return c.json({
    sshKey: {
      id: created.id,
      title: created.title,
      algorithm: created.algorithm,
      fingerprintSha256: created.fingerprintSha256,
      publicKeyPreview: getPublicKeyPreview(created.publicKey),
      comment: parsedKey.comment,
      createdAt: created.createdAt,
      lastUsedAt: created.lastUsedAt,
      revokedAt: created.revokedAt,
    },
  });
});

app.delete("/api/settings/ssh-keys/:keyId", requireAuth, async (c) => {
  const user = c.get("user")!;
  const keyId = c.req.param("keyId");

  const [deleted] = await db
    .delete(userSshKeys)
    .where(and(eq(userSshKeys.id, keyId), eq(userSshKeys.userId, user.id)))
    .returning({ id: userSshKeys.id });

  if (!deleted) {
    return c.json({ error: "SSH key not found" }, 404);
  }

  return c.json({ success: true });
});

app.get("/api/internal/ssh/authorized-keys", async (c) => {
  if (!isInternalRequest(c)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const username = (c.req.query("username") || "").trim();
  if (!username) {
    return c.json({ error: "username is required" }, 400);
  }

  // This endpoint is designed for the sshd AuthorizedKeysCommand lookup flow for a single unix user.
  if (username !== "git") {
    return c.json({ keys: [] });
  }

  const keys = await db
    .select({
      keyId: userSshKeys.id,
      userId: userSshKeys.userId,
      publicKey: userSshKeys.publicKey,
      fingerprintSha256: userSshKeys.fingerprintSha256,
    })
    .from(userSshKeys)
    .where(isNull(userSshKeys.revokedAt));

  return c.json({ keys });
});

app.delete("/api/settings/account", requireAuth, async (c) => {
  const user = c.get("user")!;

  const repos = await db.query.repositories.findMany({
    where: eq(repositories.ownerId, user.id),
    columns: { name: true },
  });

  const storageErrors: string[] = [];

  for (const repo of repos) {
    const repoPrefix = getRepoPrefix(user.id, repo.name);
    try {
      await deletePrefix(repoPrefix);
    } catch (error) {
      console.error(`[Settings] Failed to delete storage for repo ${repo.name}:`, error);
      storageErrors.push(repo.name);
    }
  }

  const avatarPrefix = `avatars/${user.id}`;
  try {
    await deletePrefix(avatarPrefix);
  } catch (error) {
    console.error(`[Settings] Failed to delete avatar storage for user ${user.id}:`, error);
    storageErrors.push('avatar');
  }

  await db.delete(users).where(eq(users.id, user.id));

  return c.json({
    success: true,
    storageCleanupErrors: storageErrors.length > 0 ? storageErrors : undefined,
  });
});

app.get("/api/settings/current-user", requireAuth, async (c) => {
  const user = c.get("user")!;

  const result = await db.query.users.findFirst({
    where: eq(users.id, user.id),
  });

  if (!result) {
    return c.json({ error: "User not found" }, 404);
  }

  return c.json({
    id: result.id,
    name: result.name,
    email: result.email,
    emailVerified: result.emailVerified,
    username: result.username,
    bio: result.bio,
    location: result.location,
    website: result.website,
    pronouns: result.pronouns,
    avatarUrl: result.avatarUrl,
    company: result.company,
    gitEmail: result.gitEmail,
    defaultRepositoryVisibility: result.defaultRepositoryVisibility,
    preferences: result.preferences,
    socialLinks: result.socialLinks,
    createdAt: result.createdAt,
    updatedAt: result.updatedAt,
    lastActiveAt: result.lastActiveAt,
  });
});

export default app;
