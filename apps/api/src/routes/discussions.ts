import { Hono } from "hono";
import {
  db,
  users,
  repositories,
  discussions,
  discussionCategories,
  discussionComments,
  discussionReactions,
} from "@sigmagit/db";
import { eq, sql, and, desc, isNull, inArray } from "drizzle-orm";
import { authMiddleware, requireAuth, type AuthVariables } from "../middleware/auth";
import { parseLimit, parseOffset } from "../lib/validation";
import { canAccessRepository } from "../lib/access";

const app = new Hono<{ Variables: AuthVariables }>();


const VALID_EMOJIS = ["+1", "-1", "laugh", "hooray", "confused", "heart", "rocket", "eyes"];

async function getRepoAndCheckAccess(owner: string, name: string, user?: { id: string; role?: string } | null) {
  const result = await db
    .select({
      id: repositories.id,
      ownerId: repositories.ownerId,
      visibility: repositories.visibility,
    })
    .from(repositories)
    .innerJoin(users, eq(users.id, repositories.ownerId))
    .where(and(eq(users.username, owner), eq(repositories.name, name)))
    .limit(1);

  const row = result[0];
  if (!row) return null;

  if (!(await canAccessRepository(row, user))) {
    return null;
  }

  return { repoId: row.id, ownerId: row.ownerId };
}

async function getDiscussionReactionsGrouped(discussionId: string, userId?: string) {
  const counts = await db
    .select({
      emoji: discussionReactions.emoji,
      count: sql<number>`COUNT(*)`,
    })
    .from(discussionReactions)
    .where(eq(discussionReactions.discussionId, discussionId))
    .groupBy(discussionReactions.emoji);

  let userEmojis: string[] = [];
  if (userId) {
    const userReactions = await db
      .select({ emoji: discussionReactions.emoji })
      .from(discussionReactions)
      .where(and(eq(discussionReactions.discussionId, discussionId), eq(discussionReactions.userId, userId)));
    userEmojis = userReactions.map((r) => r.emoji);
  }

  return counts.map((c) => ({
    emoji: c.emoji,
    count: c.count,
    reacted: userEmojis.includes(c.emoji),
  }));
}

async function getCommentReactionsGrouped(commentId: string, userId?: string) {
  const counts = await db
    .select({
      emoji: discussionReactions.emoji,
      count: sql<number>`COUNT(*)`,
    })
    .from(discussionReactions)
    .where(eq(discussionReactions.commentId, commentId))
    .groupBy(discussionReactions.emoji);

  let userEmojis: string[] = [];
  if (userId) {
    const userReactions = await db
      .select({ emoji: discussionReactions.emoji })
      .from(discussionReactions)
      .where(and(eq(discussionReactions.commentId, commentId), eq(discussionReactions.userId, userId)));
    userEmojis = userReactions.map((r) => r.emoji);
  }

  return counts.map((c) => ({
    emoji: c.emoji,
    count: c.count,
    reacted: userEmojis.includes(c.emoji),
  }));
}

async function enrichDiscussion(discussion: any, currentUserId?: string) {
  const author = await db.query.users.findFirst({
    where: eq(users.id, discussion.authorId),
    columns: { id: true, username: true, name: true, avatarUrl: true },
  });

  const category = discussion.categoryId
    ? await db.query.discussionCategories.findFirst({
        where: eq(discussionCategories.id, discussion.categoryId),
      })
    : null;

  const [commentCount] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(discussionComments)
    .where(eq(discussionComments.discussionId, discussion.id));

  const reactions = await getDiscussionReactionsGrouped(discussion.id, currentUserId);

  return {
    id: discussion.id,
    number: discussion.number,
    title: discussion.title,
    body: discussion.body,
    author: author || { id: discussion.authorId, username: "unknown", name: "Unknown", avatarUrl: null },
    category: category ? { id: category.id, name: category.name, emoji: category.emoji } : null,
    isPinned: discussion.isPinned,
    isLocked: discussion.isLocked,
    isAnswered: discussion.isAnswered,
    answerId: discussion.answerId,
    reactions,
    commentCount: commentCount?.count || 0,
    createdAt: discussion.createdAt,
    updatedAt: discussion.updatedAt,
  };
}

type UserSummary = { id: string; username: string; name: string; avatarUrl: string | null };

async function getUsersByIds(userIds: string[]): Promise<Map<string, UserSummary>> {
  if (userIds.length === 0) return new Map();
  const uniq = [...new Set(userIds)];
  const rows = await db
    .select({ id: users.id, username: users.username, name: users.name, avatarUrl: users.avatarUrl })
    .from(users)
    .where(inArray(users.id, uniq));
  return new Map(rows.map((u) => [u.id, u]));
}

async function enrichDiscussionsBatch(
  discussionRows: { id: string; authorId: string; categoryId: string | null; number: number; title: string; body: string | null; isPinned: boolean; isLocked: boolean; isAnswered: boolean; answerId: string | null; createdAt: Date; updatedAt: Date }[],
  currentUserId?: string
) {
  const discussionIds = discussionRows.map((d) => d.id);
  if (discussionIds.length === 0) return [];

  const authorIds = discussionRows.map((d) => d.authorId);
  const categoryIds = [...new Set(discussionRows.filter((d) => d.categoryId).map((d) => d.categoryId!))];

  const [usersById, categoriesById, commentCountRows, reactionCounts, userReactionRows] = await Promise.all([
    getUsersByIds(authorIds),
    categoryIds.length === 0
      ? Promise.resolve(new Map())
      : (async () => {
          const rows = await db.select().from(discussionCategories).where(inArray(discussionCategories.id, categoryIds));
          return new Map(rows.map((c) => [c.id, c]));
        })(),
    db
      .select({
        discussionId: discussionComments.discussionId,
        count: sql<number>`COUNT(*)`.as("count"),
      })
      .from(discussionComments)
      .where(inArray(discussionComments.discussionId, discussionIds))
      .groupBy(discussionComments.discussionId),
    db
      .select({
        discussionId: discussionReactions.discussionId,
        emoji: discussionReactions.emoji,
        count: sql<number>`COUNT(*)`.as("count"),
      })
      .from(discussionReactions)
      .where(inArray(discussionReactions.discussionId, discussionIds))
      .groupBy(discussionReactions.discussionId, discussionReactions.emoji),
    currentUserId
      ? db
          .select({ discussionId: discussionReactions.discussionId, emoji: discussionReactions.emoji })
          .from(discussionReactions)
          .where(and(inArray(discussionReactions.discussionId, discussionIds), eq(discussionReactions.userId, currentUserId)))
      : Promise.resolve([]),
  ]);

  const userEmojisByDiscussionId = new Map<string, string[]>();
  for (const r of userReactionRows) {
    const list = userEmojisByDiscussionId.get(r.discussionId) ?? [];
    if (!list.includes(r.emoji)) list.push(r.emoji);
    userEmojisByDiscussionId.set(r.discussionId, list);
  }
  const reactionsByDiscussionId = new Map<string, { emoji: string; count: number; reacted: boolean }[]>();
  for (const c of reactionCounts) {
    const list = reactionsByDiscussionId.get(c.discussionId) ?? [];
    list.push({
      emoji: c.emoji,
      count: Number(c.count),
      reacted: (userEmojisByDiscussionId.get(c.discussionId) ?? []).includes(c.emoji),
    });
    reactionsByDiscussionId.set(c.discussionId, list);
  }
  const commentCountByDiscussionId = new Map<string, number>();
  for (const r of commentCountRows) {
    commentCountByDiscussionId.set(r.discussionId, Number(r.count) || 0);
  }

  return discussionRows.map((d) => {
    const author = usersById.get(d.authorId) ?? { id: d.authorId, username: "unknown", name: "Unknown", avatarUrl: null };
    const category = d.categoryId ? categoriesById.get(d.categoryId) : null;
    const commentCount = commentCountByDiscussionId.get(d.id) ?? 0;
    const reactions = reactionsByDiscussionId.get(d.id) ?? [];
    return {
      id: d.id,
      number: d.number,
      title: d.title,
      body: d.body,
      author,
      category: category ? { id: category.id, name: category.name, emoji: category.emoji } : null,
      isPinned: d.isPinned,
      isLocked: d.isLocked,
      isAnswered: d.isAnswered,
      answerId: d.answerId,
      reactions,
      commentCount,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    };
  });
}

app.get("/api/repositories/:owner/:name/discussions", async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const currentUser = c.get("user");
  const categoryFilter = c.req.query("category");
  const limit = parseLimit(c.req.query("limit"), 20, 50);
  const offset = parseOffset(c.req.query("offset"), 0);

  const repoAccess = await getRepoAndCheckAccess(owner, name, currentUser);
  if (!repoAccess) {
    return c.json({ error: "Repository not found" }, 404);
  }

  const conditions = [eq(discussions.repositoryId, repoAccess.repoId)];
  if (categoryFilter) {
    conditions.push(eq(discussions.categoryId, categoryFilter));
  }

  const rows = await db
    .select()
    .from(discussions)
    .where(and(...conditions))
    .orderBy(desc(discussions.isPinned), desc(discussions.createdAt))
    .limit(limit + 1)
    .offset(offset);

  const hasMore = rows.length > limit;
  const discussionRows = rows.slice(0, limit);
  const discussionsList = await enrichDiscussionsBatch(discussionRows, currentUser?.id);

  return c.json({ discussions: discussionsList, hasMore });
});

app.get("/api/repositories/:owner/:name/discussions/categories", async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const currentUser = c.get("user");

  const repoAccess = await getRepoAndCheckAccess(owner, name, currentUser);
  if (!repoAccess) {
    return c.json({ error: "Repository not found" }, 404);
  }

  const categories = await db
    .select()
    .from(discussionCategories)
    .where(eq(discussionCategories.repositoryId, repoAccess.repoId))
    .orderBy(discussionCategories.name);

  return c.json({ categories });
});

app.post("/api/repositories/:owner/:name/discussions/categories", requireAuth, async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const user = c.get("user")!;
  const body = await c.req.json<{ name: string; emoji?: string; description?: string }>();

  const repoAccess = await getRepoAndCheckAccess(owner, name, user);
  if (!repoAccess) {
    return c.json({ error: "Repository not found" }, 404);
  }

  if (user.id !== repoAccess.ownerId) {
    return c.json({ error: "Only repo owner can create categories" }, 403);
  }

  if (!body.name?.trim()) {
    return c.json({ error: "Category name is required" }, 400);
  }

  const [inserted] = await db
    .insert(discussionCategories)
    .values({
      repositoryId: repoAccess.repoId,
      name: body.name,
      emoji: body.emoji,
      description: body.description,
    })
    .returning();

  return c.json(inserted);
});

app.get("/api/repositories/:owner/:name/discussions/:number", async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const number = parseInt(c.req.param("number"), 10);
  const currentUser = c.get("user");

  const repoAccess = await getRepoAndCheckAccess(owner, name, currentUser);
  if (!repoAccess) {
    return c.json({ error: "Repository not found" }, 404);
  }

  const discussion = await db.query.discussions.findFirst({
    where: and(eq(discussions.repositoryId, repoAccess.repoId), eq(discussions.number, number)),
  });

  if (!discussion) {
    return c.json({ error: "Discussion not found" }, 404);
  }

  const enriched = await enrichDiscussion(discussion, currentUser?.id);
  return c.json(enriched);
});

app.post("/api/repositories/:owner/:name/discussions", requireAuth, async (c) => {
  const owner = c.req.param("owner");
  const name = c.req.param("name");
  const user = c.get("user")!;
  const body = await c.req.json<{ title: string; body: string; categoryId?: string }>();

  const repoAccess = await getRepoAndCheckAccess(owner, name, user);
  if (!repoAccess) {
    return c.json({ error: "Repository not found" }, 404);
  }

  if (!body.title?.trim()) {
    return c.json({ error: "Title is required" }, 400);
  }

  if (!body.body?.trim()) {
    return c.json({ error: "Body is required" }, 400);
  }

  const [maxNumber] = await db
    .select({ max: sql<number>`COALESCE(MAX(number), 0)` })
    .from(discussions)
    .where(eq(discussions.repositoryId, repoAccess.repoId));

  const [inserted] = await db
    .insert(discussions)
    .values({
      repositoryId: repoAccess.repoId,
      authorId: user.id,
      title: body.title,
      body: body.body,
      categoryId: body.categoryId || null,
      number: (maxNumber?.max || 0) + 1,
    })
    .returning();

  const enriched = await enrichDiscussion(inserted, user.id);
  return c.json(enriched);
});

app.patch("/api/discussions/:id", requireAuth, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user")!;
  const body = await c.req.json<{ title?: string; body?: string; categoryId?: string }>();

  const discussion = await db.query.discussions.findFirst({
    where: eq(discussions.id, id),
  });

  if (!discussion) {
    return c.json({ error: "Discussion not found" }, 404);
  }

  const repo = await db.query.repositories.findFirst({
    where: eq(repositories.id, discussion.repositoryId),
  });

  if (user.id !== discussion.authorId && user.id !== repo?.ownerId) {
    return c.json({ error: "Not authorized" }, 403);
  }

  const updates: Record<string, any> = { updatedAt: new Date() };
  if (body.title !== undefined) updates.title = body.title;
  if (body.body !== undefined) updates.body = body.body;
  if (body.categoryId !== undefined) updates.categoryId = body.categoryId || null;

  await db.update(discussions).set(updates).where(eq(discussions.id, id));

  return c.json({ success: true });
});

app.patch("/api/discussions/:id/pin", requireAuth, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user")!;

  const discussion = await db.query.discussions.findFirst({
    where: eq(discussions.id, id),
  });

  if (!discussion) {
    return c.json({ error: "Discussion not found" }, 404);
  }

  const repo = await db.query.repositories.findFirst({
    where: eq(repositories.id, discussion.repositoryId),
  });

  if (user.id !== repo?.ownerId) {
    return c.json({ error: "Only repo owner can pin discussions" }, 403);
  }

  await db
    .update(discussions)
    .set({ isPinned: !discussion.isPinned, updatedAt: new Date() })
    .where(eq(discussions.id, id));

  return c.json({ success: true, isPinned: !discussion.isPinned });
});

app.patch("/api/discussions/:id/lock", requireAuth, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user")!;

  const discussion = await db.query.discussions.findFirst({
    where: eq(discussions.id, id),
  });

  if (!discussion) {
    return c.json({ error: "Discussion not found" }, 404);
  }

  const repo = await db.query.repositories.findFirst({
    where: eq(repositories.id, discussion.repositoryId),
  });

  if (user.id !== repo?.ownerId) {
    return c.json({ error: "Only repo owner can lock discussions" }, 403);
  }

  await db
    .update(discussions)
    .set({ isLocked: !discussion.isLocked, updatedAt: new Date() })
    .where(eq(discussions.id, id));

  return c.json({ success: true, isLocked: !discussion.isLocked });
});

app.delete("/api/discussions/:id", requireAuth, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user")!;

  const discussion = await db.query.discussions.findFirst({
    where: eq(discussions.id, id),
  });

  if (!discussion) {
    return c.json({ error: "Discussion not found" }, 404);
  }

  const repo = await db.query.repositories.findFirst({
    where: eq(repositories.id, discussion.repositoryId),
  });

  if (user.id !== repo?.ownerId) {
    return c.json({ error: "Only repo owner can delete discussions" }, 403);
  }

  await db.delete(discussions).where(eq(discussions.id, id));

  return c.json({ success: true });
});

app.get("/api/discussions/:id/comments", async (c) => {
  const id = c.req.param("id");
  const currentUser = c.get("user");

  const discussion = await db.query.discussions.findFirst({
    where: eq(discussions.id, id),
  });

  if (!discussion) {
    return c.json({ error: "Discussion not found" }, 404);
  }

  const comments = await db
    .select()
    .from(discussionComments)
    .where(eq(discussionComments.discussionId, id))
    .orderBy(discussionComments.createdAt);

  if (comments.length === 0) {
    return c.json({ comments: [] });
  }

  const commentIds = comments.map((c) => c.id);
  const authorIds = [...new Set(comments.map((c) => c.authorId))];

  const [usersById, reactionCounts, userReactionRows] = await Promise.all([
    getUsersByIds(authorIds),
    db
      .select({
        commentId: discussionReactions.commentId,
        emoji: discussionReactions.emoji,
        count: sql<number>`COUNT(*)`.as("count"),
      })
      .from(discussionReactions)
      .where(inArray(discussionReactions.commentId, commentIds))
      .groupBy(discussionReactions.commentId, discussionReactions.emoji),
    currentUser?.id
      ? db
          .select({ commentId: discussionReactions.commentId, emoji: discussionReactions.emoji })
          .from(discussionReactions)
          .where(and(inArray(discussionReactions.commentId, commentIds), eq(discussionReactions.userId, currentUser.id)))
      : Promise.resolve([]),
  ]);

  const userEmojisByCommentId = new Map<string, string[]>();
  for (const r of userReactionRows) {
    if (!r.commentId) continue;
    const list = userEmojisByCommentId.get(r.commentId) ?? [];
    if (!list.includes(r.emoji)) list.push(r.emoji);
    userEmojisByCommentId.set(r.commentId, list);
  }
  const reactionsByCommentId = new Map<string, { emoji: string; count: number; reacted: boolean }[]>();
  for (const c of reactionCounts) {
    if (!c.commentId) continue;
    const list = reactionsByCommentId.get(c.commentId) ?? [];
    list.push({
      emoji: c.emoji,
      count: Number(c.count),
      reacted: (userEmojisByCommentId.get(c.commentId) ?? []).includes(c.emoji),
    });
    reactionsByCommentId.set(c.commentId, list);
  }

  const commentsList = comments.map((comment) => {
    const author = usersById.get(comment.authorId) ?? { id: comment.authorId, username: "unknown", name: "Unknown", avatarUrl: null };
    const reactions = reactionsByCommentId.get(comment.id) ?? [];
    return {
      id: comment.id,
      body: comment.body,
      parentId: comment.parentId,
      isAnswer: comment.isAnswer,
      author,
      reactions,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    };
  });

  return c.json({ comments: commentsList });
});

app.post("/api/discussions/:id/comments", requireAuth, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user")!;
  const body = await c.req.json<{ body: string; parentId?: string }>();

  if (!body.body?.trim()) {
    return c.json({ error: "Comment cannot be empty" }, 400);
  }

  const discussion = await db.query.discussions.findFirst({
    where: eq(discussions.id, id),
  });

  if (!discussion) {
    return c.json({ error: "Discussion not found" }, 404);
  }

  if (discussion.isLocked) {
    return c.json({ error: "Discussion is locked" }, 403);
  }

  const [inserted] = await db
    .insert(discussionComments)
    .values({
      discussionId: id,
      authorId: user.id,
      body: body.body,
      parentId: body.parentId || null,
    })
    .returning();

  return c.json({
    id: inserted.id,
    body: inserted.body,
    parentId: inserted.parentId,
    isAnswer: inserted.isAnswer,
    author: { id: user.id, username: user.username, name: user.name, avatarUrl: user.avatarUrl },
    reactions: [],
    createdAt: inserted.createdAt,
    updatedAt: inserted.updatedAt,
  });
});

app.patch("/api/discussions/comments/:id/answer", requireAuth, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user")!;

  const comment = await db.query.discussionComments.findFirst({
    where: eq(discussionComments.id, id),
  });

  if (!comment) {
    return c.json({ error: "Comment not found" }, 404);
  }

  const discussion = await db.query.discussions.findFirst({
    where: eq(discussions.id, comment.discussionId),
  });

  if (!discussion) {
    return c.json({ error: "Discussion not found" }, 404);
  }

  if (user.id !== discussion.authorId) {
    return c.json({ error: "Only discussion author can mark answers" }, 403);
  }

  if (comment.isAnswer) {
    await db
      .update(discussionComments)
      .set({ isAnswer: false })
      .where(eq(discussionComments.id, id));

    await db
      .update(discussions)
      .set({ isAnswered: false, answerId: null, updatedAt: new Date() })
      .where(eq(discussions.id, discussion.id));

    return c.json({ success: true, isAnswer: false });
  }

  await db
    .update(discussionComments)
    .set({ isAnswer: false })
    .where(eq(discussionComments.discussionId, discussion.id));

  await db
    .update(discussionComments)
    .set({ isAnswer: true })
    .where(eq(discussionComments.id, id));

  await db
    .update(discussions)
    .set({ isAnswered: true, answerId: id, updatedAt: new Date() })
    .where(eq(discussions.id, discussion.id));

  return c.json({ success: true, isAnswer: true });
});

app.post("/api/discussions/:id/reactions", requireAuth, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user")!;
  const body = await c.req.json<{ emoji: string }>();

  if (!VALID_EMOJIS.includes(body.emoji)) {
    return c.json({ error: "Invalid emoji" }, 400);
  }

  const discussion = await db.query.discussions.findFirst({
    where: eq(discussions.id, id),
  });

  if (!discussion) {
    return c.json({ error: "Discussion not found" }, 404);
  }

  const existing = await db.query.discussionReactions.findFirst({
    where: and(
      eq(discussionReactions.discussionId, id),
      eq(discussionReactions.userId, user.id),
      eq(discussionReactions.emoji, body.emoji)
    ),
  });

  if (existing) {
    await db.delete(discussionReactions).where(eq(discussionReactions.id, existing.id));
    return c.json({ added: false });
  } else {
    await db.insert(discussionReactions).values({
      discussionId: id,
      userId: user.id,
      emoji: body.emoji,
    });
    return c.json({ added: true });
  }
});

app.post("/api/discussions/comments/:id/reactions", requireAuth, async (c) => {
  const id = c.req.param("id");
  const user = c.get("user")!;
  const body = await c.req.json<{ emoji: string }>();

  if (!VALID_EMOJIS.includes(body.emoji)) {
    return c.json({ error: "Invalid emoji" }, 400);
  }

  const comment = await db.query.discussionComments.findFirst({
    where: eq(discussionComments.id, id),
  });

  if (!comment) {
    return c.json({ error: "Comment not found" }, 404);
  }

  const existing = await db.query.discussionReactions.findFirst({
    where: and(
      eq(discussionReactions.commentId, id),
      eq(discussionReactions.userId, user.id),
      eq(discussionReactions.emoji, body.emoji)
    ),
  });

  if (existing) {
    await db.delete(discussionReactions).where(eq(discussionReactions.id, existing.id));
    return c.json({ added: false });
  } else {
    await db.insert(discussionReactions).values({
      commentId: id,
      userId: user.id,
      emoji: body.emoji,
    });
    return c.json({ added: true });
  }
});

export default app;
