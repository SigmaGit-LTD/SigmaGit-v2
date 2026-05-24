import { pgTable, text, timestamp, boolean, uuid, jsonb, primaryKey, integer, index, bigint, customType } from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

export type UserPreferences = {
  emailNotifications?: boolean;
  theme?: "light" | "dark" | "system";
  language?: string;
  showEmail?: boolean;
  wordWrap?: boolean;
};

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  username: text("username").notNull().unique(),
  bio: text("bio"),
  location: text("location"),
  website: text("website"),
  pronouns: text("pronouns"),
  avatarUrl: text("avatar_url"),
  company: text("company"),
  lastActiveAt: timestamp("last_active_at"),
  gitEmail: text("git_email"),
  defaultRepositoryVisibility: text("default_repository_visibility", { enum: ["public", "private"] })
    .notNull()
    .default("public"),
  role: text("role", { enum: ["user", "admin", "moderator"] }).notNull().default("user"),
  preferences: jsonb("preferences").$type<UserPreferences>(),
  socialLinks: jsonb("social_links").$type<{
    github?: string;
    twitter?: string;
    linkedin?: string;
    custom?: string[];
  }>(),
  // Nostr authentication fields
  nostrPublicKey: text("nostr_public_key").unique(),
  nostrLinkedAt: timestamp("nostr_linked_at"),
  nwcConnectionString: text("nwc_connection_string"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("sessions_expires_at_idx").on(table.expiresAt),
    index("sessions_user_id_idx").on(table.userId),
  ]
);

export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const verifications = pgTable(
  "verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [index("verifications_expires_at_idx").on(table.expiresAt)]
);

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull().unique(),
    displayName: text("display_name").notNull(),
    description: text("description"),
    avatarUrl: text("avatar_url"),
    website: text("website"),
    location: text("location"),
    email: text("email"),
    isVerified: boolean("is_verified").notNull().default(false),
    billingEmail: text("billing_email"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [index("organizations_name_idx").on(table.name)]
);

export const organizationMembers = pgTable(
  "organization_members",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "admin", "member"] }).notNull().default("member"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.userId] }),
    index("org_members_org_id_idx").on(table.organizationId),
    index("org_members_user_id_idx").on(table.userId),
  ]
);

export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    permission: text("permission", { enum: ["read", "write", "admin"] }).notNull().default("read"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("teams_org_id_idx").on(table.organizationId),
    index("teams_org_slug_idx").on(table.organizationId, table.slug),
  ]
);

export const teamMembers = pgTable(
  "team_members",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.teamId, table.userId] }),
    index("team_members_team_id_idx").on(table.teamId),
    index("team_members_user_id_idx").on(table.userId),
  ]
);

export const teamRepositories = pgTable(
  "team_repositories",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    permission: text("permission", { enum: ["read", "write", "admin"] }).notNull().default("read"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.teamId, table.repositoryId] }),
    index("team_repos_team_id_idx").on(table.teamId),
    index("team_repos_repo_id_idx").on(table.repositoryId),
  ]
);

export const organizationInvitations = pgTable(
  "organization_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email"),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    invitedById: text("invited_by_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "admin", "member"] }).notNull().default("member"),
    teamIds: jsonb("team_ids").$type<string[]>().default([]),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at").notNull(),
    acceptedAt: timestamp("accepted_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("org_invitations_org_id_idx").on(table.organizationId),
    index("org_invitations_token_idx").on(table.token),
  ]
);

export const repositories = pgTable(
  "repositories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    forkedFromId: uuid("forked_from_id").references((): AnyPgColumn => repositories.id, { onDelete: "set null" }),
    visibility: text("visibility", { enum: ["public", "private"] })
      .notNull()
      .default("public"),
    defaultBranch: text("default_branch").notNull().default("main"),
    searchVector: tsvector("search_vector"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("repositories_forked_from_id_idx").on(table.forkedFromId),
    index("repositories_organization_id_idx").on(table.organizationId),
    index("repositories_owner_updated_idx").on(table.ownerId, table.updatedAt),
    index("repositories_owner_visibility_updated_idx").on(table.ownerId, table.visibility, table.updatedAt),
    index("repositories_search_idx").using("gin", table.searchVector),
  ]
);

export const repoBranchMetadata = pgTable(
  "repo_branch_metadata",
  {
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    branch: text("branch").notNull(),
    headOid: text("head_oid").notNull(),
    commitCount: bigint("commit_count", { mode: "number" }).notNull().default(0),
    lastCommitOid: text("last_commit_oid").notNull(),
    lastCommitMessage: text("last_commit_message").notNull(),
    lastCommitAuthorName: text("last_commit_author_name").notNull(),
    lastCommitAuthorEmail: text("last_commit_author_email").notNull(),
    lastCommitTimestamp: timestamp("last_commit_timestamp").notNull(),
    readmeOid: text("readme_oid"),
    rootTree: jsonb("root_tree").$type<Array<{ name: string; type: string; oid: string; path: string }>>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.repoId, table.branch] }),
    index("repo_branch_metadata_repo_id_idx").on(table.repoId),
  ]
);

export const stars = pgTable(
  "stars",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.repositoryId] }),
    index("stars_repository_id_idx").on(table.repositoryId),
  ]
);

export const issues = pgTable(
  "issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: integer("number").notNull(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body"),
    state: text("state", { enum: ["open", "closed"] }).notNull().default("open"),
    locked: boolean("locked").notNull().default(false),
    closedAt: timestamp("closed_at"),
    closedById: text("closed_by_id").references(() => users.id),
    searchVector: tsvector("search_vector"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("issues_repository_id_idx").on(table.repositoryId),
    index("issues_repository_number_idx").on(table.repositoryId, table.number),
    index("issues_search_idx").using("gin", table.searchVector),
  ]
);

export const labels = pgTable(
  "labels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    color: text("color").notNull().default("6b7280"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [index("labels_repository_id_idx").on(table.repositoryId)]
);

export const issueLabels = pgTable(
  "issue_labels",
  {
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    labelId: uuid("label_id")
      .notNull()
      .references(() => labels.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.issueId, table.labelId] })]
);

export const issueAssignees = pgTable(
  "issue_assignees",
  {
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    assignedAt: timestamp("assigned_at").notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.issueId, table.userId] })]
);

export const issueComments = pgTable(
  "issue_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issueId: uuid("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [index("issue_comments_issue_id_idx").on(table.issueId)]
);

export const issueReactions = pgTable(
  "issue_reactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "cascade" }),
    commentId: uuid("comment_id").references(() => issueComments.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    emoji: text("emoji").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("issue_reactions_issue_id_idx").on(table.issueId),
    index("issue_reactions_comment_id_idx").on(table.commentId),
  ]
);

export const apiKeys = pgTable("api_key", {
  id: text("id").primaryKey(),
  name: text("name"),
  start: text("start"),
  prefix: text("prefix"),
  key: text("key").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  refillInterval: integer("refill_interval"),
  refillAmount: integer("refill_amount"),
  lastRefillAt: timestamp("last_refill_at"),
  enabled: boolean("enabled").notNull().default(true),
  rateLimitEnabled: boolean("rate_limit_enabled").notNull().default(false),
  rateLimitTimeWindow: integer("rate_limit_time_window"),
  rateLimitMax: integer("rate_limit_max"),
  requestCount: integer("request_count").notNull().default(0),
  remaining: integer("remaining"),
  lastRequest: timestamp("last_request"),
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  permissions: text("permissions"),
  metadata: jsonb("metadata"),
});

export const pullRequests = pgTable(
  "pull_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: integer("number").notNull(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body"),
    state: text("state", { enum: ["open", "closed", "merged"] }).notNull().default("open"),
    isDraft: boolean("is_draft").notNull().default(false),
    headRepoId: uuid("head_repo_id")
      .notNull()
      .references(() => repositories.id),
    headBranch: text("head_branch").notNull(),
    headOid: text("head_oid").notNull(),
    baseRepoId: uuid("base_repo_id")
      .notNull()
      .references(() => repositories.id),
    baseBranch: text("base_branch").notNull(),
    baseOid: text("base_oid").notNull(),
    merged: boolean("merged").notNull().default(false),
    mergedAt: timestamp("merged_at"),
    mergedById: text("merged_by_id").references(() => users.id),
    mergeCommitOid: text("merge_commit_oid"),
    closedAt: timestamp("closed_at"),
    closedById: text("closed_by_id").references(() => users.id),
    searchVector: tsvector("search_vector"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("pull_requests_repository_id_idx").on(table.repositoryId),
    index("pull_requests_repository_number_idx").on(table.repositoryId, table.number),
    index("pull_requests_head_repo_id_idx").on(table.headRepoId),
    index("pull_requests_base_repo_id_idx").on(table.baseRepoId),
    index("pull_requests_search_idx").using("gin", table.searchVector),
  ]
);

export const prReviews = pgTable(
  "pr_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pullRequestId: uuid("pull_request_id")
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    body: text("body"),
    state: text("state", { enum: ["approved", "changes_requested", "commented"] }).notNull(),
    commitOid: text("commit_oid").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [index("pr_reviews_pull_request_id_idx").on(table.pullRequestId)]
);

export const prComments = pgTable(
  "pr_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pullRequestId: uuid("pull_request_id")
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    filePath: text("file_path"),
    side: text("side", { enum: ["left", "right"] }),
    lineNumber: integer("line_number"),
    commitOid: text("commit_oid"),
    replyToId: uuid("reply_to_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("pr_comments_pull_request_id_idx").on(table.pullRequestId),
    index("pr_comments_file_path_idx").on(table.pullRequestId, table.filePath),
  ]
);

export const prLabels = pgTable(
  "pr_labels",
  {
    pullRequestId: uuid("pull_request_id")
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    labelId: uuid("label_id")
      .notNull()
      .references(() => labels.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.pullRequestId, table.labelId] })]
);

export const prAssignees = pgTable(
  "pr_assignees",
  {
    pullRequestId: uuid("pull_request_id")
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    assignedAt: timestamp("assigned_at").notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.pullRequestId, table.userId] })]
);

export const prReviewers = pgTable(
  "pr_reviewers",
  {
    pullRequestId: uuid("pull_request_id")
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requestedAt: timestamp("requested_at").notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.pullRequestId, table.userId] })]
);

export const prReactions = pgTable(
  "pr_reactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pullRequestId: uuid("pull_request_id").references(() => pullRequests.id, { onDelete: "cascade" }),
    commentId: uuid("comment_id").references(() => prComments.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    emoji: text("emoji").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("pr_reactions_pull_request_id_idx").on(table.pullRequestId),
    index("pr_reactions_comment_id_idx").on(table.commentId),
  ]
);

export const discussionCategories = pgTable(
  "discussion_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    emoji: text("emoji"),
    description: text("description"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [index("discussion_categories_repo_id_idx").on(table.repositoryId)]
);

export const discussions = pgTable(
  "discussions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: integer("number").notNull(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id").references(() => discussionCategories.id, { onDelete: "set null" }),
    authorId: text("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body").notNull(),
    isPinned: boolean("is_pinned").notNull().default(false),
    isLocked: boolean("is_locked").notNull().default(false),
    isAnswered: boolean("is_answered").notNull().default(false),
    answerId: uuid("answer_id"),
    searchVector: tsvector("search_vector"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("discussions_repo_id_idx").on(table.repositoryId),
    index("discussions_repo_number_idx").on(table.repositoryId, table.number),
    index("discussions_search_idx").using("gin", table.searchVector),
  ]
);

export const discussionComments = pgTable(
  "discussion_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    discussionId: uuid("discussion_id")
      .notNull()
      .references(() => discussions.id, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id"),
    body: text("body").notNull(),
    isAnswer: boolean("is_answer").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("discussion_comments_discussion_id_idx").on(table.discussionId),
    index("discussion_comments_parent_id_idx").on(table.parentId),
  ]
);

export const discussionReactions = pgTable(
  "discussion_reactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    discussionId: uuid("discussion_id").references(() => discussions.id, { onDelete: "cascade" }),
    commentId: uuid("comment_id").references(() => discussionComments.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    emoji: text("emoji").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("discussion_reactions_discussion_id_idx").on(table.discussionId),
    index("discussion_reactions_comment_id_idx").on(table.commentId),
  ]
);

export const discussionCategoryRelations = relations(discussionCategories, ({ one, many }) => ({
  repository: one(repositories, {
    fields: [discussionCategories.repositoryId],
    references: [repositories.id],
  }),
  discussions: many(discussions),
}));

export const discussionRelations = relations(discussions, ({ one, many }) => ({
  repository: one(repositories, {
    fields: [discussions.repositoryId],
    references: [repositories.id],
  }),
  category: one(discussionCategories, {
    fields: [discussions.categoryId],
    references: [discussionCategories.id],
  }),
  author: one(users, {
    fields: [discussions.authorId],
    references: [users.id],
  }),
  comments: many(discussionComments),
  reactions: many(discussionReactions),
}));

export const discussionCommentRelations = relations(discussionComments, ({ one, many }) => ({
  discussion: one(discussions, {
    fields: [discussionComments.discussionId],
    references: [discussions.id],
  }),
  author: one(users, {
    fields: [discussionComments.authorId],
    references: [users.id],
  }),
  parent: one(discussionComments, {
    fields: [discussionComments.parentId],
    references: [discussionComments.id],
    relationName: "parentChild",
  }),
  replies: many(discussionComments, { relationName: "parentChild" }),
  reactions: many(discussionReactions),
}));

export const discussionReactionRelations = relations(discussionReactions, ({ one }) => ({
  discussion: one(discussions, {
    fields: [discussionReactions.discussionId],
    references: [discussions.id],
  }),
  comment: one(discussionComments, {
    fields: [discussionReactions.commentId],
    references: [discussionComments.id],
  }),
  user: one(users, {
    fields: [discussionReactions.userId],
    references: [users.id],
  }),
}));

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [index("projects_repo_id_idx").on(table.repositoryId)]
);

export const projectColumns = pgTable(
  "project_columns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [index("project_columns_project_id_idx").on(table.projectId)]
);

export const projectItems = pgTable(
  "project_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    columnId: uuid("column_id")
      .notNull()
      .references(() => projectColumns.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "cascade" }),
    pullRequestId: uuid("pull_request_id").references(() => pullRequests.id, { onDelete: "cascade" }),
    noteContent: text("note_content"),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("project_items_column_id_idx").on(table.columnId),
    index("project_items_project_id_idx").on(table.projectId),
  ]
);

export const projectRelations = relations(projects, ({ one, many }) => ({
  repository: one(repositories, {
    fields: [projects.repositoryId],
    references: [repositories.id],
  }),
  columns: many(projectColumns),
  items: many(projectItems),
}));

export const projectColumnRelations = relations(projectColumns, ({ one, many }) => ({
  project: one(projects, {
    fields: [projectColumns.projectId],
    references: [projects.id],
  }),
  items: many(projectItems),
}));

export const projectItemRelations = relations(projectItems, ({ one }) => ({
  project: one(projects, {
    fields: [projectItems.projectId],
    references: [projects.id],
  }),
  column: one(projectColumns, {
    fields: [projectItems.columnId],
    references: [projectColumns.id],
  }),
  issue: one(issues, {
    fields: [projectItems.issueId],
    references: [issues.id],
  }),
  pullRequest: one(pullRequests, {
    fields: [projectItems.pullRequestId],
    references: [pullRequests.id],
  }),
}));

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    resourceType: text("resource_type"),
    resourceId: uuid("resource_id"),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    repoOwner: text("repo_owner"),
    repoName: text("repo_name"),
    resourceNumber: integer("resource_number"),
    read: boolean("read").notNull().default(false),
    emailSent: boolean("email_sent").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("notifications_user_id_idx").on(table.userId),
    index("notifications_user_read_idx").on(table.userId, table.read),
  ]
);

export const notificationRelations = relations(notifications, ({ one }) => ({
  user: one(users, {
    fields: [notifications.userId],
    references: [users.id],
  }),
  actor: one(users, {
    fields: [notifications.actorId],
    references: [users.id],
  }),
}));

// ─── Repository Collaborators ────────────────────────────────────────────────

export const repositoryCollaborators = pgTable(
  "repository_collaborators",
  {
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    permission: text("permission", { enum: ["read", "write", "admin"] })
      .notNull()
      .default("read"),
    invitedById: text("invited_by_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.repositoryId, table.userId] }),
    index("repo_collaborators_repo_id_idx").on(table.repositoryId),
    index("repo_collaborators_user_id_idx").on(table.userId),
  ]
);

export const repositoryCollaboratorRelations = relations(repositoryCollaborators, ({ one }) => ({
  repository: one(repositories, {
    fields: [repositoryCollaborators.repositoryId],
    references: [repositories.id],
  }),
  user: one(users, {
    fields: [repositoryCollaborators.userId],
    references: [users.id],
  }),
  invitedBy: one(users, {
    fields: [repositoryCollaborators.invitedById],
    references: [users.id],
    relationName: "collaboratorInvitedBy",
  }),
}));

// ─── Branch Protection Rules ─────────────────────────────────────────────────

export const branchProtectionRules = pgTable(
  "branch_protection_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    pattern: text("pattern").notNull(),
    requirePullRequest: boolean("require_pull_request").notNull().default(false),
    requireApprovals: integer("require_approvals").notNull().default(0),
    dismissStaleReviews: boolean("dismiss_stale_reviews").notNull().default(false),
    requireStatusChecks: boolean("require_status_checks").notNull().default(false),
    requiredStatusChecks: jsonb("required_status_checks").$type<string[]>().default([]),
    allowForcePush: boolean("allow_force_push").notNull().default(false),
    allowDeletion: boolean("allow_deletion").notNull().default(false),
    createdById: text("created_by_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [index("branch_protection_rules_repo_id_idx").on(table.repositoryId)]
);

export const branchProtectionRuleRelations = relations(branchProtectionRules, ({ one }) => ({
  repository: one(repositories, {
    fields: [branchProtectionRules.repositoryId],
    references: [repositories.id],
  }),
  createdBy: one(users, {
    fields: [branchProtectionRules.createdById],
    references: [users.id],
  }),
}));

// ─── Repository Webhooks ─────────────────────────────────────────────────────

export const repositoryWebhooks = pgTable(
  "repository_webhooks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    secret: text("secret"),
    events: jsonb("events")
      .$type<Array<"push" | "pull_request" | "issues" | "tag" | "branch">>()
      .notNull()
      .default([]),
    active: boolean("active").notNull().default(true),
    contentType: text("content_type", { enum: ["json", "form"] })
      .notNull()
      .default("json"),
    createdById: text("created_by_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [index("repo_webhooks_repo_id_idx").on(table.repositoryId)]
);

export const repositoryWebhookRelations = relations(repositoryWebhooks, ({ one }) => ({
  repository: one(repositories, {
    fields: [repositoryWebhooks.repositoryId],
    references: [repositories.id],
  }),
  createdBy: one(users, {
    fields: [repositoryWebhooks.createdById],
    references: [users.id],
  }),
}))

export const releases = pgTable(
  "releases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tagName: text("tag_name").notNull(),
    name: text("name").notNull(),
    body: text("body"),
    isDraft: boolean("is_draft").notNull().default(false),
    isPrerelease: boolean("is_prerelease").notNull().default(false),
    targetCommitish: text("target_commitish").notNull().default("main"),
    publishedAt: timestamp("published_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("releases_repository_id_idx").on(table.repositoryId),
    index("releases_repo_tag_idx").on(table.repositoryId, table.tagName),
  ]
);

export const releaseAssets = pgTable(
  "release_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    releaseId: uuid("release_id")
      .notNull()
      .references(() => releases.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    label: text("label"),
    contentType: text("content_type").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    downloadCount: integer("download_count").notNull().default(0),
    storageKey: text("storage_key").notNull(),
    uploaderId: text("uploader_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [index("release_assets_release_id_idx").on(table.releaseId)]
);

export const releaseComments = pgTable(
  "release_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    releaseId: uuid("release_id")
      .notNull()
      .references(() => releases.id, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [index("release_comments_release_id_idx").on(table.releaseId)]
);

export const releaseReactions = pgTable(
  "release_reactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    releaseId: uuid("release_id").references(() => releases.id, { onDelete: "cascade" }),
    commentId: uuid("comment_id").references(() => releaseComments.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    emoji: text("emoji").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("release_reactions_release_id_idx").on(table.releaseId),
    index("release_reactions_comment_id_idx").on(table.commentId),
  ]
);

export const releaseRelations = relations(releases, ({ one, many }) => ({
  repository: one(repositories, {
    fields: [releases.repositoryId],
    references: [repositories.id],
  }),
  author: one(users, {
    fields: [releases.authorId],
    references: [users.id],
  }),
  assets: many(releaseAssets),
  comments: many(releaseComments),
  reactions: many(releaseReactions),
}));

export const releaseAssetRelations = relations(releaseAssets, ({ one }) => ({
  release: one(releases, {
    fields: [releaseAssets.releaseId],
    references: [releases.id],
  }),
  uploader: one(users, {
    fields: [releaseAssets.uploaderId],
    references: [users.id],
  }),
}));

export const releaseCommentRelations = relations(releaseComments, ({ one, many }) => ({
  release: one(releases, {
    fields: [releaseComments.releaseId],
    references: [releases.id],
  }),
  author: one(users, {
    fields: [releaseComments.authorId],
    references: [users.id],
  }),
  reactions: many(releaseReactions),
}));

export const releaseReactionRelations = relations(releaseReactions, ({ one }) => ({
  release: one(releases, {
    fields: [releaseReactions.releaseId],
    references: [releases.id],
  }),
  comment: one(releaseComments, {
    fields: [releaseReactions.commentId],
    references: [releaseComments.id],
  }),
  user: one(users, {
    fields: [releaseReactions.userId],
    references: [users.id],
  }),
}));

export const gists = pgTable(
  "gists",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    description: text("description"),
    visibility: text("visibility", { enum: ["public", "secret"] }).notNull().default("public"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("gists_owner_id_idx").on(table.ownerId),
    index("gists_created_at_idx").on(table.createdAt),
  ]
);

export const gistFiles = pgTable(
  "gist_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    gistId: uuid("gist_id")
      .notNull()
      .references(() => gists.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    content: text("content").notNull(),
    language: text("language"),
    size: integer("size").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [index("gist_files_gist_id_idx").on(table.gistId)]
);

export const gistComments = pgTable(
  "gist_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    gistId: uuid("gist_id")
      .notNull()
      .references(() => gists.id, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [index("gist_comments_gist_id_idx").on(table.gistId)]
);

export const gistStars = pgTable(
  "gist_stars",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    gistId: uuid("gist_id")
      .notNull()
      .references(() => gists.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.gistId] })]
);

export const gistForks = pgTable(
  "gist_forks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    gistId: uuid("gist_id")
      .notNull()
      .references(() => gists.id, { onDelete: "cascade" }),
    forkedFromId: uuid("forked_from_id")
      .notNull()
      .references(() => gists.id, { onDelete: "cascade" }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [index("gist_forks_gist_id_idx").on(table.gistId)]
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    ipAddress: text("ip_address"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("audit_logs_actor_id_idx").on(table.actorId),
    index("audit_logs_created_at_idx").on(table.createdAt),
  ]
);

export const auditLogRelations = relations(auditLogs, ({ one }) => ({
  actor: one(users, {
    fields: [auditLogs.actorId],
    references: [users.id],
  }),
}));

export const systemSettings = pgTable("system_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const systemSettingsRelations = relations(systemSettings, ({ one }) => ({
  updatedByUser: one(users, {
    fields: [systemSettings.updatedBy],
    references: [users.id],
  }),
}));

export const gistRelations = relations(gists, ({ one, many }) => ({
  owner: one(users, {
    fields: [gists.ownerId],
    references: [users.id],
  }),
  files: many(gistFiles),
  comments: many(gistComments),
  stars: many(gistStars),
  // Forks where this gist is the original (forkedFromId points to this gist)
  forks: many(gistForks, {
    relationName: "forkedFrom",
  }),
}));

export const gistFileRelations = relations(gistFiles, ({ one }) => ({
  gist: one(gists, {
    fields: [gistFiles.gistId],
    references: [gists.id],
  }),
}));

export const gistCommentRelations = relations(gistComments, ({ one }) => ({
  gist: one(gists, {
    fields: [gistComments.gistId],
    references: [gists.id],
  }),
  author: one(users, {
    fields: [gistComments.authorId],
    references: [users.id],
  }),
}));

export const gistStarRelations = relations(gistStars, ({ one }) => ({
  gist: one(gists, {
    fields: [gistStars.gistId],
    references: [gists.id],
  }),
  user: one(users, {
    fields: [gistStars.userId],
    references: [users.id],
  }),
}));

export const gistForkRelations = relations(gistForks, ({ one }) => ({
  gist: one(gists, {
    fields: [gistForks.gistId],
    references: [gists.id],
    relationName: "forkedGist",
  }),
  forkedFrom: one(gists, {
    fields: [gistForks.forkedFromId],
    references: [gists.id],
    relationName: "forkedFrom",
  }),
  owner: one(users, {
    fields: [gistForks.ownerId],
    references: [users.id],
  }),
}));

export const repositoryMigrations = pgTable(
  "repository_migrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id").references(() => repositories.id, { onDelete: "set null" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    source: text("source", { enum: ["github", "gitlab", "bitbucket", "gitea", "url"] }).notNull(),
    sourceUrl: text("source_url").notNull(),
    sourceBaseUrl: text("source_base_url"), // For self-hosted GitLab/Gitea instances
    sourceOwner: text("source_owner"),
    sourceRepo: text("source_repo"),
    status: text("status", { enum: ["pending", "cloning", "importing", "completed", "failed"] }).notNull().default("pending"),
    progress: integer("progress").notNull().default(0),
    errorMessage: text("error_message"),
    options: jsonb("options").$type<{
      importIssues?: boolean;
      importPRs?: boolean;
      importWiki?: boolean;
      importLabels?: boolean;
      mirror?: boolean;
    }>().default({}),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("repo_migrations_user_id_idx").on(table.userId),
    index("repo_migrations_status_idx").on(table.status),
  ]
);

// Separate table for encrypted migration credentials
export const migrationCredentials = pgTable(
  "migration_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    migrationId: uuid("migration_id")
      .notNull()
      .references(() => repositoryMigrations.id, { onDelete: "cascade" }),
    // Encrypted authentication token/password
    authToken: text("auth_token"),
    authType: text("auth_type", { enum: ["token", "password", "ssh_key"] }).default("token"),
    // For SSH key imports
    sshKey: text("ssh_key"),
    sshKeyPassphrase: text("ssh_key_passphrase"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("migration_creds_migration_id_idx").on(table.migrationId),
  ]
);

export const repositoryMigrationRelations = relations(repositoryMigrations, ({ one }) => ({
  repository: one(repositories, {
    fields: [repositoryMigrations.repositoryId],
    references: [repositories.id],
  }),
  user: one(users, {
    fields: [repositoryMigrations.userId],
    references: [users.id],
  }),
  credentials: one(migrationCredentials, {
    fields: [repositoryMigrations.id],
    references: [migrationCredentials.migrationId],
  }),
}));

export const migrationCredentialRelations = relations(migrationCredentials, ({ one }) => ({
  migration: one(repositoryMigrations, {
    fields: [migrationCredentials.migrationId],
    references: [repositoryMigrations.id],
  }),
}));

export const passkeys = pgTable(
  "passkey",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    publicKey: text("public_key").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    credentialID: text("credential_id").notNull(),
    counter: integer("counter").notNull(),
    deviceType: text("device_type").notNull(),
    backedUp: boolean("backed_up").notNull(),
    transports: text("transports"),
    createdAt: timestamp("created_at"),
    aaguid: text("aaguid"),
  },
  (table) => [index("passkey_userId_idx").on(table.userId), index("passkey_credentialID_idx").on(table.credentialID)]
);

export const userSshKeys = pgTable(
  "user_ssh_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title"),
    publicKey: text("public_key").notNull(),
    algorithm: text("algorithm").notNull(),
    fingerprintSha256: text("fingerprint_sha256").notNull().unique(),
    lastUsedAt: timestamp("last_used_at"),
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [index("user_ssh_keys_user_id_idx").on(table.userId), index("user_ssh_keys_revoked_at_idx").on(table.revokedAt)]
);

export const passkeyRelations = relations(passkeys, ({ one }) => ({
  user: one(users, {
    fields: [passkeys.userId],
    references: [users.id],
  }),
}));

export const userSshKeyRelations = relations(userSshKeys, ({ one }) => ({
  user: one(users, {
    fields: [userSshKeys.userId],
    references: [users.id],
  }),
}));

export const userRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  accounts: many(accounts),
  apikeys: many(apiKeys),
  passkeys: many(passkeys),
  sshKeys: many(userSshKeys),
  auditLogs: many(auditLogs),
}));

export const sessionRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
}));

export const accountRelations = relations(accounts, ({ one }) => ({
  user: one(users, {
    fields: [accounts.userId],
    references: [users.id],
  }),
}));

export const apiKeyRelations = relations(apiKeys, ({ one }) => ({
  user: one(users, {
    fields: [apiKeys.userId],
    references: [users.id],
  }),
}));

export const repoBranchMetadataRelations = relations(repoBranchMetadata, ({ one }) => ({
  repo: one(repositories, {
    fields: [repoBranchMetadata.repoId],
    references: [repositories.id],
  }),
}));

export const repositoryRelations = relations(repositories, ({ one }) => ({
  organization: one(organizations, {
    fields: [repositories.organizationId],
    references: [organizations.id],
  }),
}));

export const issueRelations = relations(issues, ({ one, many }) => ({
  repository: one(repositories, {
    fields: [issues.repositoryId],
    references: [repositories.id],
  }),
  author: one(users, {
    fields: [issues.authorId],
    references: [users.id],
  }),
  closedBy: one(users, {
    fields: [issues.closedById],
    references: [users.id],
  }),
  labels: many(issueLabels),
  assignees: many(issueAssignees),
  comments: many(issueComments),
  reactions: many(issueReactions),
}));

export const labelRelations = relations(labels, ({ one, many }) => ({
  repository: one(repositories, {
    fields: [labels.repositoryId],
    references: [repositories.id],
  }),
  issues: many(issueLabels),
  pullRequests: many(prLabels),
}));

export const issueLabelRelations = relations(issueLabels, ({ one }) => ({
  issue: one(issues, {
    fields: [issueLabels.issueId],
    references: [issues.id],
  }),
  label: one(labels, {
    fields: [issueLabels.labelId],
    references: [labels.id],
  }),
}));

export const issueAssigneeRelations = relations(issueAssignees, ({ one }) => ({
  issue: one(issues, {
    fields: [issueAssignees.issueId],
    references: [issues.id],
  }),
  user: one(users, {
    fields: [issueAssignees.userId],
    references: [users.id],
  }),
}));

export const issueCommentRelations = relations(issueComments, ({ one, many }) => ({
  issue: one(issues, {
    fields: [issueComments.issueId],
    references: [issues.id],
  }),
  author: one(users, {
    fields: [issueComments.authorId],
    references: [users.id],
  }),
  reactions: many(issueReactions),
}));

export const issueReactionRelations = relations(issueReactions, ({ one }) => ({
  issue: one(issues, {
    fields: [issueReactions.issueId],
    references: [issues.id],
  }),
  comment: one(issueComments, {
    fields: [issueReactions.commentId],
    references: [issueComments.id],
  }),
  user: one(users, {
    fields: [issueReactions.userId],
    references: [users.id],
  }),
}));

export const pullRequestRelations = relations(pullRequests, ({ one, many }) => ({
  repository: one(repositories, {
    fields: [pullRequests.repositoryId],
    references: [repositories.id],
    relationName: "pullRequestRepository",
  }),
  author: one(users, {
    fields: [pullRequests.authorId],
    references: [users.id],
    relationName: "pullRequestAuthor",
  }),
  headRepo: one(repositories, {
    fields: [pullRequests.headRepoId],
    references: [repositories.id],
    relationName: "pullRequestHeadRepo",
  }),
  baseRepo: one(repositories, {
    fields: [pullRequests.baseRepoId],
    references: [repositories.id],
    relationName: "pullRequestBaseRepo",
  }),
  mergedBy: one(users, {
    fields: [pullRequests.mergedById],
    references: [users.id],
    relationName: "pullRequestMergedBy",
  }),
  closedBy: one(users, {
    fields: [pullRequests.closedById],
    references: [users.id],
    relationName: "pullRequestClosedBy",
  }),
  labels: many(prLabels),
  assignees: many(prAssignees),
  reviewers: many(prReviewers),
  reviews: many(prReviews),
  comments: many(prComments),
  reactions: many(prReactions),
}));

export const prReviewRelations = relations(prReviews, ({ one }) => ({
  pullRequest: one(pullRequests, {
    fields: [prReviews.pullRequestId],
    references: [pullRequests.id],
  }),
  author: one(users, {
    fields: [prReviews.authorId],
    references: [users.id],
  }),
}));

export const prCommentRelations = relations(prComments, ({ one, many }) => ({
  pullRequest: one(pullRequests, {
    fields: [prComments.pullRequestId],
    references: [pullRequests.id],
  }),
  author: one(users, {
    fields: [prComments.authorId],
    references: [users.id],
  }),
  reactions: many(prReactions),
}));

export const prLabelRelations = relations(prLabels, ({ one }) => ({
  pullRequest: one(pullRequests, {
    fields: [prLabels.pullRequestId],
    references: [pullRequests.id],
  }),
  label: one(labels, {
    fields: [prLabels.labelId],
    references: [labels.id],
  }),
}));

export const prAssigneeRelations = relations(prAssignees, ({ one }) => ({
  pullRequest: one(pullRequests, {
    fields: [prAssignees.pullRequestId],
    references: [pullRequests.id],
  }),
  user: one(users, {
    fields: [prAssignees.userId],
    references: [users.id],
  }),
}));

export const prReviewerRelations = relations(prReviewers, ({ one }) => ({
  pullRequest: one(pullRequests, {
    fields: [prReviewers.pullRequestId],
    references: [pullRequests.id],
  }),
  user: one(users, {
    fields: [prReviewers.userId],
    references: [users.id],
  }),
}));

export const prReactionRelations = relations(prReactions, ({ one }) => ({
  pullRequest: one(pullRequests, {
    fields: [prReactions.pullRequestId],
    references: [pullRequests.id],
  }),
  comment: one(prComments, {
    fields: [prReactions.commentId],
    references: [prComments.id],
  }),
  user: one(users, {
    fields: [prReactions.userId],
    references: [users.id],
  }),
}));

import { discordLinks, linkTokens } from './discord';
export { discordLinks, linkTokens };

// ─── Runner System ─────────────────────────────────────────────────────────────

export const runners = pgTable(
  "runners",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    token: text("token").notNull().unique(),
    labels: jsonb("labels").$type<string[]>().default([]),
    status: text("status", { enum: ["online", "offline", "busy"] }).notNull().default("offline"),
    lastSeenAt: timestamp("last_seen_at"),
    currentJobId: uuid("current_job_id"),
    ipAddress: text("ip_address"),
    os: text("os"),
    arch: text("arch"),
    version: text("version"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("runners_status_idx").on(table.status),
    index("runners_token_idx").on(table.token),
    index("runners_last_seen_at_idx").on(table.lastSeenAt),
  ]
);

export const workflows = pgTable(
  "workflows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    path: text("path").notNull(),
    content: text("content").notNull(),
    triggers: jsonb("triggers").$type<{
      push?: { branches?: string[] };
      pull_request?: { branches?: string[] };
      workflow_dispatch?: boolean;
    }>(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [index("workflows_repository_id_idx").on(table.repositoryId)]
);

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    triggeredBy: text("triggered_by").references(() => users.id, { onDelete: "set null" }),
    commitSha: text("commit_sha").notNull(),
    branch: text("branch").notNull(),
    eventName: text("event_name").notNull(),
    eventPayload: jsonb("event_payload").$type<Record<string, unknown>>(),
    status: text("status", {
      enum: ["queued", "in_progress", "completed", "failed", "cancelled"],
    })
      .notNull()
      .default("queued"),
    conclusion: text("conclusion", { enum: ["success", "failure", "cancelled", "skipped"] }),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("workflow_runs_repository_id_idx").on(table.repositoryId),
    index("workflow_runs_workflow_id_idx").on(table.workflowId),
    index("workflow_runs_status_idx").on(table.status),
  ]
);

export const workflowJobs = pgTable(
  "workflow_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    runnerId: uuid("runner_id").references(() => runners.id, { onDelete: "set null" }),
    status: text("status", {
      enum: ["queued", "assigned", "in_progress", "completed", "failed", "cancelled"],
    })
      .notNull()
      .default("queued"),
    conclusion: text("conclusion", { enum: ["success", "failure", "cancelled", "skipped"] }),
    workflowDefinition: jsonb("workflow_definition").$type<Record<string, unknown>>(),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("workflow_jobs_run_id_idx").on(table.runId),
    index("workflow_jobs_status_idx").on(table.status),
    index("workflow_jobs_runner_id_idx").on(table.runnerId),
    index("workflow_jobs_status_created_at_idx").on(table.status, table.createdAt),
  ]
);

export const workflowSteps = pgTable(
  "workflow_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => workflowJobs.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    name: text("name").notNull(),
    status: text("status", {
      enum: ["queued", "in_progress", "completed", "failed", "cancelled"],
    })
      .notNull()
      .default("queued"),
    exitCode: integer("exit_code"),
    logOutput: text("log_output"),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [index("workflow_steps_job_id_idx").on(table.jobId)]
);

export const jobListings = pgTable(
  "job_listings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    department: text("department"),
    location: text("location"),
    employmentType: text("employment_type", { enum: ["full_time", "part_time", "contract", "internship"] })
      .notNull()
      .default("full_time"),
    open: boolean("open").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("job_listings_slug_idx").on(table.slug),
    index("job_listings_open_idx").on(table.open),
  ]
);

export const jobApplications = pgTable(
  "job_applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobListingId: uuid("job_listing_id")
      .notNull()
      .references(() => jobListings.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    email: text("email").notNull(),
    phone: text("phone"),
    coverLetter: text("cover_letter"),
    resumeUrl: text("resume_url"),
    linkedInUrl: text("linkedin_url"),
    status: text("status", { enum: ["new", "reviewing", "interview", "offer", "rejected"] })
      .notNull()
      .default("new"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("job_applications_job_listing_id_idx").on(table.jobListingId),
    index("job_applications_email_idx").on(table.email),
    index("job_applications_status_idx").on(table.status),
  ]
);

export const reports = pgTable(
  "reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reporterId: text("reporter_id").references(() => users.id, { onDelete: "set null" }),
    targetType: text("target_type", {
      enum: ["user", "repository", "gist", "organization"],
    }).notNull(),
    targetId: text("target_id").notNull(),
    reason: text("reason", {
      enum: ["spam", "harassment", "inappropriate", "impersonation", "other"],
    }).notNull(),
    description: text("description").notNull(),
    status: text("status", {
      enum: ["pending", "reviewing", "resolved", "dismissed"],
    }).notNull().default("pending"),
    adminNotes: text("admin_notes"),
    resolvedById: text("resolved_by_id").references(() => users.id, { onDelete: "set null" }),
    resolvedAt: timestamp("resolved_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("reports_status_idx").on(table.status),
    index("reports_target_type_idx").on(table.targetType),
    index("reports_created_at_idx").on(table.createdAt),
  ]
);

export const dmcaRequests = pgTable(
  "dmca_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requesterId: text("requester_id").references(() => users.id, { onDelete: "set null" }),
    targetType: text("target_type", { enum: ["repository", "gist"] }).notNull(),
    targetId: text("target_id").notNull(),
    copyrightHolder: text("copyright_holder").notNull(),
    copyrightHolderEmail: text("copyright_holder_email").notNull(),
    copyrightHolderAddress: text("copyright_holder_address").notNull(),
    copyrightHolderPhone: text("copyright_holder_phone"),
    originalWorkDescription: text("original_work_description").notNull(),
    originalWorkUrl: text("original_work_url"),
    infringingUrls: text("infringing_urls").notNull(),
    description: text("description").notNull(),
    swornStatement: boolean("sworn_statement").notNull(),
    perjuryStatement: boolean("perjury_statement").notNull(),
    signature: text("signature").notNull(),
    status: text("status", {
      enum: ["pending", "reviewing", "approved", "rejected", "counter_filed"],
    }).notNull().default("pending"),
    adminNotes: text("admin_notes"),
    resolvedById: text("resolved_by_id").references(() => users.id, { onDelete: "set null" }),
    resolvedAt: timestamp("resolved_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("dmca_requests_status_idx").on(table.status),
    index("dmca_requests_target_type_idx").on(table.targetType),
    index("dmca_requests_created_at_idx").on(table.createdAt),
  ]
);

export const jobListingsRelations = relations(jobListings, ({ many }) => ({
  applications: many(jobApplications),
}));

export const jobApplicationsRelations = relations(jobApplications, ({ one }) => ({
  jobListing: one(jobListings, {
    fields: [jobApplications.jobListingId],
    references: [jobListings.id],
  }),
}));

export const reportsRelations = relations(reports, ({ one }) => ({
  reporter: one(users, {
    fields: [reports.reporterId],
    references: [users.id],
  }),
  resolvedBy: one(users, {
    fields: [reports.resolvedById],
    references: [users.id],
  }),
}));

export const dmcaRequestsRelations = relations(dmcaRequests, ({ one }) => ({
  requester: one(users, {
    fields: [dmcaRequests.requesterId],
    references: [users.id],
  }),
  resolvedBy: one(users, {
    fields: [dmcaRequests.resolvedById],
    references: [users.id],
  }),
}));

// Relations
export const runnersRelations = relations(runners, ({ one, many }) => ({
  currentJob: one(workflowJobs, {
    fields: [runners.currentJobId],
    references: [workflowJobs.id],
  }),
  jobs: many(workflowJobs),
}));

export const workflowsRelations = relations(workflows, ({ one, many }) => ({
  repository: one(repositories, {
    fields: [workflows.repositoryId],
    references: [repositories.id],
  }),
  runs: many(workflowRuns),
}));

export const workflowRunsRelations = relations(workflowRuns, ({ one, many }) => ({
  workflow: one(workflows, {
    fields: [workflowRuns.workflowId],
    references: [workflows.id],
  }),
  repository: one(repositories, {
    fields: [workflowRuns.repositoryId],
    references: [repositories.id],
  }),
  triggeredByUser: one(users, {
    fields: [workflowRuns.triggeredBy],
    references: [users.id],
  }),
  jobs: many(workflowJobs),
}));

export const workflowJobsRelations = relations(workflowJobs, ({ one, many }) => ({
  run: one(workflowRuns, {
    fields: [workflowJobs.runId],
    references: [workflowRuns.id],
  }),
  runner: one(runners, {
    fields: [workflowJobs.runnerId],
    references: [runners.id],
  }),
  steps: many(workflowSteps),
}));

export const workflowStepsRelations = relations(workflowSteps, ({ one }) => ({
  job: one(workflowJobs, {
    fields: [workflowSteps.jobId],
    references: [workflowJobs.id],
  }),
}));
