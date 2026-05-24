import { Hono } from "hono";
import { setSignedCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import { db, users, sessions } from "@sigmagit/db";
import { getAuth } from "../auth";
import { config } from "../config";
import { invalidateCachedUser } from "../middleware/auth";
import { authRateLimitOnFailure } from "../middleware/rate-limit";
import { createNostrChallenge, consumeNostrChallenge } from "../lib/nostr-challenge";

const app = new Hono();

app.use("/api/auth/nostr*", authRateLimitOnFailure);

console.log("[Nostr Auth] Routes loading...");

// Default Nostr relays to fetch profile from
const DEFAULT_NOSTR_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.snort.social",
  "wss://relay.primal.net",
  "wss://nostr.mom",
];

interface NostrProfile {
  name?: string;
  displayName?: string;
  about?: string;
  bio?: string;
  picture?: string;
  avatarUrl?: string;
  banner?: string;
  bannerUrl?: string;
}

// Lazy load nostr-tools to avoid startup issues
let nostrTools: typeof import("nostr-tools") | null = null;
async function getNostrTools() {
  if (!nostrTools) {
    nostrTools = await import("nostr-tools");
  }
  return nostrTools;
}

/**
 * Convert hex pubkey to npub (bech32)
 */
async function hexToNpub(hex: string): Promise<string | null> {
  try {
    const { nip19 } = await getNostrTools();
    return nip19.npubEncode(hex);
  } catch {
    return null;
  }
}

/**
 * Fetch Nostr profile (Kind 0) from relays
 */
async function fetchNostrProfile(pubkey: string): Promise<NostrProfile | null> {
  try {
    const { SimplePool } = await getNostrTools();
    const pool = new SimplePool();

    const relays = DEFAULT_NOSTR_RELAYS;
    const filter = {
      kinds: [0],
      authors: [pubkey],
      limit: 1,
    };

    const event = await Promise.race([
      pool.get(relays, filter),
      new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error("Profile fetch timeout")), 5000)
      ),
    ]).catch(() => null);

    pool.close(relays);

    if (!event) return null;

    try {
      const content = JSON.parse(event.content);
      return {
        name: content.name,
        displayName: content.display_name || content.displayName,
        about: content.about,
        bio: content.about,
        picture: content.picture,
        avatarUrl: content.picture,
        banner: content.banner,
        bannerUrl: content.banner,
      };
    } catch {
      return null;
    }
  } catch (error) {
    console.error("[Nostr] Failed to fetch profile:", error);
    return null;
  }
}

/**
 * Generate a username from npub
 */
function generateUsernameFromNpub(npub: string): string {
  // Take first 8 chars after npub1 prefix
  const suffix = npub.replace("npub1", "").slice(0, 8);
  return `nostr_${suffix}`;
}

/**
 * Generate a temporary email from npub
 */
function generateTempEmailFromNpub(npub: string): string {
  const suffix = npub.replace("npub1", "").slice(0, 16);
  return `nostr_${suffix}@sigmagit.com`;
}

interface NostrAuthEvent {
  kind: number;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
  id: string;
  sig: string;
}

async function normalizePubkeyInput(npub: string): Promise<{ normalizedNpub: string; hexPubkey: string | null }> {
  let normalizedNpub = npub;
  let hexPubkey: string | null = null;

  if (npub.startsWith("npub1")) {
    try {
      const { nip19 } = await getNostrTools();
      const decoded = nip19.decode(npub);
      if (decoded.type === "npub") {
        hexPubkey = decoded.data as string;
      }
    } catch {
      // continue with npub as-is
    }
  } else if (/^[0-9a-fA-F]{64}$/.test(npub)) {
    hexPubkey = npub.toLowerCase();
    const converted = await hexToNpub(hexPubkey);
    if (converted) {
      normalizedNpub = converted;
    } else {
      throw new Error("Invalid hex public key format");
    }
  } else {
    throw new Error("Invalid public key format. Expected npub1... or 64-char hex");
  }

  return { normalizedNpub, hexPubkey };
}

async function verifyNostrAuthEvent(
  event: NostrAuthEvent,
  expectedChallenge: string,
  expectedHexPubkey: string | null
): Promise<boolean> {
  if (event.kind !== 22242) {
    return false;
  }

  if (expectedHexPubkey && event.pubkey.toLowerCase() !== expectedHexPubkey.toLowerCase()) {
    return false;
  }

  const challengeTag = event.tags.find((tag) => tag[0] === "challenge");
  if (!challengeTag?.[1] || challengeTag[1] !== expectedChallenge) {
    return false;
  }

  const { verifyEvent } = await getNostrTools();
  return verifyEvent(event as any);
}

// GET /api/auth/nostr/challenge - Issue one-time auth challenge (NIP-42)
app.get("/api/auth/nostr/challenge", async (c) => {
  const challenge = await createNostrChallenge();
  return c.json({ challenge });
});

// POST /api/auth/nostr - Sign in or sign up with Nostr
app.post("/api/auth/nostr", async (c) => {
  try {
    const body = await c.req.json<{
      npub: string;
      event: NostrAuthEvent;
      challenge: string;
      profile?: NostrProfile;
      nwcConnectionString?: string;
    }>();

    const { npub, event, challenge, profile: clientProfile, nwcConnectionString } = body;

    if (!npub || !event || !challenge) {
      return c.json({ error: "npub, signed event, and challenge are required" }, 400);
    }

    const challengeValid = await consumeNostrChallenge(challenge);
    if (!challengeValid) {
      return c.json({ error: "Invalid or expired challenge" }, 401);
    }

    const { normalizedNpub, hexPubkey } = await normalizePubkeyInput(npub);

    const signatureValid = await verifyNostrAuthEvent(event, challenge, hexPubkey);
    if (!signatureValid) {
      return c.json({ error: "Invalid Nostr signature" }, 401);
    }

    // Check if user already exists with this npub
    let user = await db.query.users.findFirst({
      where: eq(users.nostrPublicKey, normalizedNpub),
    });

    // Fetch profile from relays if we have hex pubkey
    let serverProfile: NostrProfile | null = null;
    if (hexPubkey) {
      serverProfile = await fetchNostrProfile(hexPubkey);
    }

    // Merge profile data: server (relays) > client > defaults
    const profile = {
      name:
        serverProfile?.displayName ||
        serverProfile?.name ||
        clientProfile?.displayName ||
        clientProfile?.name,
      bio: serverProfile?.about || clientProfile?.about || clientProfile?.bio,
      avatarUrl:
        serverProfile?.picture ||
        serverProfile?.avatarUrl ||
        clientProfile?.picture ||
        clientProfile?.avatarUrl,
      bannerUrl:
        serverProfile?.banner ||
        serverProfile?.bannerUrl ||
        clientProfile?.banner ||
        clientProfile?.bannerUrl,
    };

    if (!user) {
      // Create new user
      const username = generateUsernameFromNpub(normalizedNpub);
      const tempEmail = generateTempEmailFromNpub(normalizedNpub);

      const newUser = {
        id: crypto.randomUUID(),
        name: profile.name || username,
        email: tempEmail,
        emailVerified: true,
        username,
        bio: profile.bio || null,
        avatarUrl: profile.avatarUrl || null,
        nostrPublicKey: normalizedNpub,
        nostrLinkedAt: new Date(),
        nwcConnectionString: nwcConnectionString || null,
        role: "user" as const,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await db.insert(users).values(newUser).returning();
      user = result[0];
    } else {
      // Update existing user's Nostr data
      const updates: Partial<typeof users.$inferInsert> = {
        nostrLinkedAt: new Date(),
        updatedAt: new Date(),
      };

      if (nwcConnectionString) {
        updates.nwcConnectionString = nwcConnectionString;
      }

      // Update profile fields if not already set
      if (profile.name && !user.name?.startsWith("nostr_")) {
        updates.name = profile.name;
      }
      if (profile.bio && !user.bio) {
        updates.bio = profile.bio;
      }
      if (profile.avatarUrl && !user.avatarUrl) {
        updates.avatarUrl = profile.avatarUrl;
      }

      await db.update(users).set(updates).where(eq(users.id, user.id));
      await invalidateCachedUser(user.id);

      // Refresh user data
      const refreshed = await db.query.users.findFirst({
        where: eq(users.id, user.id),
      });
      if (refreshed) {
        user = refreshed;
      }
    }

    // Create session directly in database
    const sessionId = crypto.randomUUID();
    const sessionToken = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    await db.insert(sessions).values({
      id: sessionId,
      userId: user.id,
      token: sessionToken,
      expiresAt,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Better Auth expects a signed cookie named `${cookiePrefix}.session_token`.
    // Using an unsigned or differently-named cookie causes getSession() to return null.
    const cookiePrefix = config.nodeEnv === "production" ? "sigmagit" : "sigmagit_dev";
    const cookieName = `${cookiePrefix}.session_token`;
    await setSignedCookie(c, cookieName, sessionToken, config.betterAuthSecret, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      secure: config.nodeEnv === "production",
      maxAge: 30 * 24 * 60 * 60,
    });

    return c.json({
      success: true,
      token: sessionToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        username: user.username,
        avatarUrl: user.avatarUrl,
        nostrPublicKey: user.nostrPublicKey,
      },
      session: {
        id: sessionId,
        expiresAt,
      },
    });
  } catch (error) {
    console.error("[Nostr Auth] Error:", error);
    return c.json(
      {
        error: "Authentication failed",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

// POST /api/auth/nostr/link - Link Nostr to existing account
app.post("/api/auth/nostr/link", async (c) => {
  try {
    // Verify user is authenticated
    const auth = getAuth();
    const sessionResult = await auth.api.getSession({
      headers: c.req.header(),
    });

    if (!sessionResult || "error" in sessionResult || !sessionResult.user) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const currentUser = sessionResult.user;
    const body = await c.req.json<{
      npub: string;
      event: NostrAuthEvent;
      challenge: string;
      nwcConnectionString?: string;
    }>();

    const { npub, event, challenge, nwcConnectionString } = body;

    if (!npub || !event || !challenge) {
      return c.json({ error: "npub, signed event, and challenge are required" }, 400);
    }

    const challengeValid = await consumeNostrChallenge(challenge);
    if (!challengeValid) {
      return c.json({ error: "Invalid or expired challenge" }, 401);
    }

    const { normalizedNpub, hexPubkey } = await normalizePubkeyInput(npub);

    const signatureValid = await verifyNostrAuthEvent(event, challenge, hexPubkey);
    if (!signatureValid) {
      return c.json({ error: "Invalid Nostr signature" }, 401);
    }

    // Check if npub is already linked to another user
    const existingUser = await db.query.users.findFirst({
      where: eq(users.nostrPublicKey, normalizedNpub),
    });

    if (existingUser && existingUser.id !== currentUser.id) {
      return c.json({ error: "This Nostr key is already linked to another account" }, 409);
    }

    let profile: NostrProfile | null = null;
    if (hexPubkey) {
      profile = await fetchNostrProfile(hexPubkey);
    }

    // Update user with Nostr details
    const updates: Partial<typeof users.$inferInsert> = {
      nostrPublicKey: normalizedNpub,
      nostrLinkedAt: new Date(),
      updatedAt: new Date(),
    };

    if (nwcConnectionString) {
      updates.nwcConnectionString = nwcConnectionString;
    }

    // Update profile fields if not already set
    const currentUserData = await db.query.users.findFirst({
      where: eq(users.id, currentUser.id),
    });

    if (currentUserData) {
      if (profile?.name && (!currentUserData.name || currentUserData.name === currentUserData.username)) {
        updates.name = profile.name;
      }
      if (profile?.about && !currentUserData.bio) {
        updates.bio = profile.about;
      }
      if (profile?.picture && !currentUserData.avatarUrl) {
        updates.avatarUrl = profile.picture;
      }
    }

    await db.update(users).set(updates).where(eq(users.id, currentUser.id));
    await invalidateCachedUser(currentUser.id);

    return c.json({
      success: true,
      message: "Nostr identity linked successfully",
      nostrPublicKey: normalizedNpub,
    });
  } catch (error) {
    console.error("[Nostr Link] Error:", error);
    return c.json(
      {
        error: "Failed to link Nostr identity",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

// DELETE /api/auth/nostr/link - Unlink Nostr from account
app.delete("/api/auth/nostr/link", async (c) => {
  try {
    // Verify user is authenticated
    const auth = getAuth();
    const sessionResult = await auth.api.getSession({
      headers: c.req.header(),
    });

    if (!sessionResult || "error" in sessionResult || !sessionResult.user) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const currentUser = sessionResult.user;

    // Clear Nostr fields
    await db
      .update(users)
      .set({
        nostrPublicKey: null,
        nostrLinkedAt: null,
        nwcConnectionString: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, currentUser.id));

    return c.json({
      success: true,
      message: "Nostr identity unlinked successfully",
    });
  } catch (error) {
    console.error("[Nostr Unlink] Error:", error);
    return c.json(
      {
        error: "Failed to unlink Nostr identity",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

// GET /api/auth/nostr/status - Check Nostr auth status
app.get("/api/auth/nostr/status", async (c) => {
  try {
    const auth = getAuth();
    const sessionResult = await auth.api.getSession({
      headers: c.req.header(),
    });

    if (!sessionResult || "error" in sessionResult || !sessionResult.user) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const user = await db.query.users.findFirst({
      where: eq(users.id, sessionResult.user.id),
      columns: {
        nostrPublicKey: true,
        nostrLinkedAt: true,
      },
    });

    return c.json({
      linked: !!user?.nostrPublicKey,
      nostrPublicKey: user?.nostrPublicKey || null,
      linkedAt: user?.nostrLinkedAt || null,
    });
  } catch (error) {
    console.error("[Nostr Status] Error:", error);
    return c.json({ error: "Failed to check status" }, 500);
  }
});

console.log("[Nostr Auth] Routes loaded successfully");

export default app;
