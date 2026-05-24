import { Hono } from "hono";
import { db, repositoryMigrations, repositories, users, migrationCredentials } from "@sigmagit/db";
import { eq, and, sql, desc } from "drizzle-orm";
import { authMiddleware, requireAuth, type AuthVariables } from "../middleware/auth";
import { parseLimit, parseOffset } from "../lib/validation";
import { encryptCredential, decryptCredential } from "../lib/credential-cipher";

const app = new Hono<{ Variables: AuthVariables }>();


app.post("/api/migrations", requireAuth, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.json();
  const {
    source,
    sourceUrl,
    sourceBaseUrl,
    sourceOwner,
    sourceRepo,
    options,
    credentials,
  } = body;

  // Build the actual source URL based on source type
  let finalSourceUrl = sourceUrl;
  if (source !== "url" && sourceBaseUrl) {
    // Self-hosted instance
    finalSourceUrl = `${sourceBaseUrl}/${sourceOwner}/${sourceRepo}.git`;
  } else if (source !== "url") {
    // Default hosted service
    finalSourceUrl = `https://${source}.com/${sourceOwner}/${sourceRepo}.git`;
  }

  // Create migration record
  const [migration] = await db
    .insert(repositoryMigrations)
    .values({
      userId: user.id,
      source,
      sourceUrl: finalSourceUrl,
      sourceBaseUrl: sourceBaseUrl || null,
      sourceOwner: sourceOwner || null,
      sourceRepo: sourceRepo || null,
      status: "pending",
      progress: 0,
      options: options || {},
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  // Store credentials if provided
  if (credentials && (credentials.authToken || credentials.sshKey)) {
    await db.insert(migrationCredentials).values({
      migrationId: migration.id,
      authToken: credentials.authToken ? encryptCredential(credentials.authToken) : null,
      authType: credentials.authType || "token",
      sshKey: credentials.sshKey ? encryptCredential(credentials.sshKey) : null,
      sshKeyPassphrase: credentials.sshKeyPassphrase
        ? encryptCredential(credentials.sshKeyPassphrase)
        : null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  return c.json({ data: migration });
});

app.get("/api/migrations", requireAuth, async (c) => {
  const user = c.get("user")!;
  const limit = parseLimit(c.req.query("limit"), 20);
  const offset = parseOffset(c.req.query("offset"), 0);

  const migrations = await db
    .select()
    .from(repositoryMigrations)
    .where(eq(repositoryMigrations.userId, user.id))
    .orderBy(desc(repositoryMigrations.createdAt))
    .limit(limit + 1)
    .offset(offset);

  const hasMore = migrations.length > limit;
  const migrationsData = migrations.slice(0, limit);

  return c.json({ migrations: migrationsData, hasMore });
});

app.get("/api/migrations/:id", requireAuth, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user")!;

  const [migration] = await db
    .select()
    .from(repositoryMigrations)
    .where(
      and(
        eq(repositoryMigrations.id, id),
        eq(repositoryMigrations.userId, user.id)
      )
    );

  if (!migration) {
    return c.json({ error: "Migration not found" }, 404);
  }

  return c.json({ data: migration });
});

// Get credentials for a migration (internal use only, for worker)
app.get("/api/migrations/:id/credentials", requireAuth, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user")!;

  const [migration] = await db
    .select()
    .from(repositoryMigrations)
    .where(
      and(
        eq(repositoryMigrations.id, id),
        eq(repositoryMigrations.userId, user.id)
      )
    );

  if (!migration) {
    return c.json({ error: "Migration not found" }, 404);
  }

  const [creds] = await db
    .select()
    .from(migrationCredentials)
    .where(eq(migrationCredentials.migrationId, id));

  if (!creds) {
    return c.json({ error: "No credentials found" }, 404);
  }

  // Decrypt credentials for the response
  return c.json({
    data: {
      authType: creds.authType,
      authToken: creds.authToken ? decryptCredential(creds.authToken) : null,
      sshKey: creds.sshKey ? decryptCredential(creds.sshKey) : null,
      sshKeyPassphrase: creds.sshKeyPassphrase
        ? decryptCredential(creds.sshKeyPassphrase)
        : null,
    },
  });
});

app.post("/api/migrations/:id/cancel", requireAuth, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user")!;

  const [migration] = await db
    .select()
    .from(repositoryMigrations)
    .where(
      and(
        eq(repositoryMigrations.id, id),
        eq(repositoryMigrations.userId, user.id)
      )
    );

  if (!migration) {
    return c.json({ error: "Migration not found" }, 404);
  }

  if (migration.status === "completed" || migration.status === "failed") {
    return c.json({ error: "Cannot cancel completed migration" }, 400);
  }

  await db
    .update(repositoryMigrations)
    .set({ status: "failed", errorMessage: "Cancelled by user", updatedAt: new Date() })
    .where(eq(repositoryMigrations.id, id));

  return c.json({ success: true });
});

app.delete("/api/migrations/:id", requireAuth, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user")!;

  const [migration] = await db
    .select()
    .from(repositoryMigrations)
    .where(
      and(
        eq(repositoryMigrations.id, id),
        eq(repositoryMigrations.userId, user.id)
      )
    );

  if (!migration) {
    return c.json({ error: "Migration not found" }, 404);
  }

  // Delete credentials first (cascade should handle this, but being explicit)
  await db
    .delete(migrationCredentials)
    .where(eq(migrationCredentials.migrationId, id));

  await db.delete(repositoryMigrations).where(eq(repositoryMigrations.id, id));

  return c.json({ success: true });
});

// Normalized repo shape for list-repos responses
interface ListRepoItem {
  id: string;
  fullName: string;
  private: boolean;
  defaultBranch?: string;
  url: string;
}

const FETCH_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(
  url: string,
  options: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

function ensureHttps(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:";
  } catch {
    return false;
  }
}

// External service integrations
app.get("/api/migrations/github/repos", requireAuth, async (c) => {
  const token = c.req.query("token");

  if (!token) {
    return c.json({ error: "GitHub token required" }, 400);
  }

  try {
    const res = await fetchWithTimeout(
      "https://api.github.com/user/repos?per_page=100&sort=updated",
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
        },
      }
    );
    if (res.status === 401 || res.status === 403) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }
    if (!res.ok) {
      return c.json({ error: "Failed to fetch repositories from GitHub" }, 502);
    }
    const data = (await res.json()) as Array<{
      id: number;
      full_name: string;
      private: boolean;
      default_branch?: string;
      clone_url: string;
    }>;
    const repos: ListRepoItem[] = (data || []).map((r) => ({
      id: String(r.id),
      fullName: r.full_name,
      private: r.private,
      defaultBranch: r.default_branch,
      url: r.clone_url,
    }));
    return c.json({ repos });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return c.json({ error: "Request timed out" }, 504);
    }
    throw err;
  }
});

app.get("/api/migrations/gitlab/repos", requireAuth, async (c) => {
  const token = c.req.query("token");
  const baseUrl = (c.req.query("baseUrl") || "https://gitlab.com").replace(
    /\/$/,
    ""
  );

  if (!token) {
    return c.json({ error: "GitLab token required" }, 400);
  }

  if (process.env.NODE_ENV === "production" && !ensureHttps(baseUrl)) {
    return c.json({ error: "baseUrl must use HTTPS" }, 400);
  }

  try {
    const url = `${baseUrl}/api/v4/projects?membership=true&per_page=100`;
    const res = await fetchWithTimeout(url, {
      headers: { "PRIVATE-TOKEN": token },
    });
    if (res.status === 401 || res.status === 403) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }
    if (!res.ok) {
      return c.json({ error: "Failed to fetch repositories from GitLab" }, 502);
    }
    const data = (await res.json()) as Array<{
      id: number;
      path_with_namespace: string;
      visibility: string;
      default_branch?: string;
      http_url_to_repo: string;
    }>;
    const repos: ListRepoItem[] = (data || []).map((r) => ({
      id: String(r.id),
      fullName: r.path_with_namespace,
      private: r.visibility === "private",
      defaultBranch: r.default_branch,
      url: r.http_url_to_repo,
    }));
    return c.json({ repos });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return c.json({ error: "Request timed out" }, 504);
    }
    throw err;
  }
});

app.get("/api/migrations/gitea/repos", requireAuth, async (c) => {
  const token = c.req.query("token");
  const baseUrl = c.req.query("baseUrl");

  if (!token) {
    return c.json({ error: "Gitea token required" }, 400);
  }

  if (!baseUrl) {
    return c.json({ error: "Gitea base URL required" }, 400);
  }

  const normalizedBase = (baseUrl as string).replace(/\/$/, "");
  if (process.env.NODE_ENV === "production" && !ensureHttps(normalizedBase)) {
    return c.json({ error: "baseUrl must use HTTPS" }, 400);
  }

  try {
    const url = `${normalizedBase}/api/v1/user/repos?limit=50`;
    const res = await fetchWithTimeout(url, {
      headers: { Authorization: `token ${token}` },
    });
    if (res.status === 401 || res.status === 403) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }
    if (!res.ok) {
      return c.json({ error: "Failed to fetch repositories from Gitea" }, 502);
    }
    const data = (await res.json()) as Array<{
      id: number;
      full_name: string;
      private: boolean;
      default_branch?: string;
      clone_url: string;
    }>;
    const repos: ListRepoItem[] = (data || []).map((r) => ({
      id: String(r.id),
      fullName: r.full_name,
      private: r.private,
      defaultBranch: r.default_branch,
      url: r.clone_url,
    }));
    return c.json({ repos });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return c.json({ error: "Request timed out" }, 504);
    }
    throw err;
  }
});

app.get("/api/migrations/bitbucket/repos", requireAuth, async (c) => {
  const token = c.req.query("token");

  if (!token) {
    return c.json({ error: "Bitbucket token required" }, 400);
  }

  try {
    const res = await fetchWithTimeout(
      "https://api.bitbucket.org/2.0/repositories?role=member&pagelen=100",
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    if (res.status === 401 || res.status === 403) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }
    if (!res.ok) {
      return c.json({ error: "Failed to fetch repositories from Bitbucket" }, 502);
    }
    const body = (await res.json()) as {
      values?: Array<{
        uuid: string;
        full_name?: string;
        name?: string;
        is_private?: boolean;
        mainbranch?: { name?: string };
        links?: { clone?: Array<{ href: string; name?: string }> };
      }>;
    };
    const values = body?.values ?? [];
    const repos: ListRepoItem[] = values.map((r) => {
      const cloneLink = r.links?.clone?.find((l) => l.name === "https") ?? r.links?.clone?.[0];
      return {
        id: r.uuid ?? String(r.name),
        fullName: r.full_name ?? r.name ?? "unknown",
        private: r.is_private ?? false,
        defaultBranch: r.mainbranch?.name,
        url: cloneLink?.href ?? "",
      };
    });
    return c.json({ repos });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return c.json({ error: "Request timed out" }, 504);
    }
    throw err;
  }
});

export default app;
