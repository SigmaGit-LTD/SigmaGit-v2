import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db, users, discordLinks, linkTokens } from "@sigmagit/db";
import { randomBytes } from "crypto";
import { authMiddleware, requireAuth, type AuthVariables } from "../middleware/auth";
function calculateTokenExpiry(): Date {
  const expiry = new Date();
  expiry.setHours(expiry.getHours() + 24);
  return expiry;
}

const app = new Hono<{ Variables: AuthVariables }>();


interface LinkRequest {
  discordId: string;
  sigmagitEmail?: string;
}

interface VerifyLinkRequest {
  token: string;
  sigmagitUserId: string;
  discordId?: string;
}

async function generateLinkTokenForUser(discordId: string, userId: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  const expiresAt = calculateTokenExpiry();

  await db.insert(linkTokens).values({
    token,
    userId,
    expiresAt,
    used: false,
  });

  return token;
}

app.post('/api/discord/link/generate', requireAuth, async (c) => {
  try {
    const user = c.get("user")!;
    const { discordId } = await c.req.json() as LinkRequest;

    if (!discordId) {
      return c.json({ error: 'Discord ID is required' }, 400);
    }

    const token = await generateLinkTokenForUser(discordId, user.id);

    return c.json({ success: true, token });
  } catch (error) {
    console.error('[Discord] Error generating link token:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

app.post('/api/discord/link/verify', async (c) => {
  try {
    const { token, sigmagitUserId, discordId } = await c.req.json() as VerifyLinkRequest;

    if (!token || !sigmagitUserId) {
      return c.json({ error: 'Token and user ID are required' }, 400);
    }

    const linkToken = await db.query.linkTokens.findFirst({
      where: eq(linkTokens.token, token),
    });

    if (!linkToken) {
      return c.json({ error: 'Invalid or expired token' }, 400);
    }

    if (linkToken.used) {
      return c.json({ error: 'Token has already been used' }, 400);
    }

    const now = new Date();
    if (now > linkToken.expiresAt) {
      return c.json({ error: 'Token has expired' }, 400);
    }

    if (linkToken.userId !== sigmagitUserId) {
      return c.json({ error: 'Token does not match the provided user ID' }, 400);
    }

    const user = await db.query.users.findFirst({
      where: eq(users.id, sigmagitUserId),
    });

    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }

    await db.update(linkTokens)
      .set({ used: true })
      .where(eq(linkTokens.token, token));

    // Look up existing link by sigmagitUserId first, then by discordId if provided
    let existingLink = await db.query.discordLinks.findFirst({
      where: eq(discordLinks.sigmagitUserId, sigmagitUserId),
    });

    if (!existingLink && discordId) {
      existingLink = await db.query.discordLinks.findFirst({
        where: eq(discordLinks.discordId, discordId),
      });
    }

    // Use provided discordId or try to get it from existing link
    const finalDiscordId = discordId || existingLink?.discordId;

    if (!finalDiscordId) {
      return c.json({ error: 'Discord ID is required for linking' }, 400);
    }

    if (existingLink) {
      await db.update(discordLinks)
        .set({
          discordId: finalDiscordId,
          sigmagitUserId: user.id,
          sigmagitUsername: user.username,
          sigmagitEmail: user.email,
          lastVerifiedAt: now,
          verified: true,
        })
        .where(eq(discordLinks.id, existingLink.id));

      return c.json({ success: true, linked: true, user: user });
    } else {
      await db.insert(discordLinks).values({
        discordId: finalDiscordId,
        sigmagitUserId: user.id,
        sigmagitUsername: user.username,
        sigmagitEmail: user.email,
        linkedAt: now,
        verified: true,
        lastVerifiedAt: now,
      });

      return c.json({ success: true, linked: true, user: user });
    }
  } catch (error) {
    console.error('[Discord] Error verifying link:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

app.post('/api/discord/link/unlink', async (c) => {
  try {
    const { discordId } = await c.req.json() as { discordId: string };

    if (!discordId) {
      return c.json({ error: 'Discord ID is required' }, 400);
    }

    const link = await db.query.discordLinks.findFirst({
      where: eq(discordLinks.discordId, discordId),
    });

    if (!link) {
      return c.json({ error: 'No link found for this Discord ID' }, 404);
    }

    await db.delete(discordLinks).where(eq(discordLinks.id, link.id));

    return c.json({ success: true, unlinked: true });
  } catch (error) {
    console.error('[Discord] Error unlinking account:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

app.get('/api/discord/link/status/:discordId', async (c) => {
  try {
    const discordId = c.req.param('discordId');

    if (!discordId) {
      return c.json({ error: 'Discord ID is required' }, 400);
    }

    const link = await db.query.discordLinks.findFirst({
      where: eq(discordLinks.discordId, discordId),
    });

    if (!link) {
      return c.json({ linked: false });
    }

    const user = await db.query.users.findFirst({
      where: eq(users.id, link.sigmagitUserId),
      columns: {
        id: true,
        username: true,
        name: true,
        avatarUrl: true,
      },
    });

    return c.json({
      linked: true,
      verified: link.verified,
      user: user ? {
        id: user.id,
        username: user.username,
        name: user.name,
        avatarUrl: user.avatarUrl,
      } : null,
      linkedAt: link.linkedAt,
    });
  } catch (error) {
    console.error('[Discord] Error getting link status:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

app.post('/api/discord/link/relink', async (c) => {
  try {
    const { discordId, sigmagitEmail } = await c.req.json() as LinkRequest;

    if (!discordId || !sigmagitEmail) {
      return c.json({ error: 'Discord ID and email are required for relinking' }, 400);
    }

    const existingLink = await db.query.discordLinks.findFirst({
      where: eq(discordLinks.discordId, discordId),
    });

    if (existingLink) {
      const user = await db.query.users.findFirst({
        where: eq(users.email, sigmagitEmail),
      });

      if (!user) {
        return c.json({ error: 'User not found with that email' }, 404);
      }

      await db.update(discordLinks)
        .set({
          sigmagitUserId: user.id,
          sigmagitUsername: user.username,
          sigmagitEmail: user.email,
          lastVerifiedAt: new Date(),
          verified: true,
        })
        .where(eq(discordLinks.id, existingLink.id));

      return c.json({ success: true, relinked: true, user: user });
    } else {
      return c.json({ error: 'No existing link found' }, 404);
    }
  } catch (error) {
    console.error('[Discord] Error relinking account:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

export default app;
