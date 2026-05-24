import { createMiddleware } from "hono/factory";
import { getAuth, type Session } from "../auth";
import { db, users } from "@sigmagit/db";
import { eq } from "drizzle-orm";
import { appCache, CACHE_TTL, getCached, setCache } from "../redis";

export type AuthUser = {
  id: string;
  name: string;
  email: string;
  username: string;
  avatarUrl?: string | null;
  gitEmail?: string | null;
  role?: "user" | "admin" | "moderator";
};

export type AuthVariables = {
  user: AuthUser | null;
  session: Session | null;
};

export type AdminVariables = AuthVariables;

export async function invalidateCachedUser(userId: string): Promise<void> {
  await appCache.invalidateUser(userId);
}

export const authMiddleware = createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
  const auth = getAuth();

  try {
    const session = await auth.api.getSession({
      headers: c.req.raw.headers,
    });

    if (session?.user) {
      const cached = await getCached<AuthUser>(appCache.userKey(session.user.id));

      if (cached) {
        c.set("user", cached);
      } else {
        const dbUser = await db.query.users.findFirst({
          where: eq(users.id, session.user.id),
          columns: {
            id: true,
            name: true,
            email: true,
            username: true,
            avatarUrl: true,
            role: true,
          },
        });

        const user: AuthUser = {
          id: session.user.id,
          name: session.user.name,
          email: session.user.email,
          username: (session.user as any).username || dbUser?.username || "",
          avatarUrl: session.user.image || dbUser?.avatarUrl || null,
          role: dbUser?.role || (session.user as any).role || "user",
        };

        await setCache(appCache.userKey(session.user.id), user, CACHE_TTL.user);
        c.set("user", user);
      }

      c.set("session", session);
    } else {
      c.set("user", null);
      c.set("session", null);
    }
  } catch (error) {
    console.error("[API] Auth middleware error:", error instanceof Error ? error.message : "Unknown error");
    c.set("user", null);
    c.set("session", null);
  }

  await next();
});

export const requireAuth = createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
  const user = c.get("user");

  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  await next();
});

export const optionalAuth = authMiddleware;

export const requireAdmin = createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
  const user = c.get("user");

  if (!user || user.role !== "admin") {
    return c.json({ error: "Forbidden" }, 403);
  }

  await next();
});
