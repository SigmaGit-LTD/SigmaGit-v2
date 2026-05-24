import { db, repositories, organizations, users } from '@sigmagit/db';
import { eq, and, isNull } from 'drizzle-orm';
import { createGitStore, type GitStore } from '../git';

export function getStorageOwnerId(repo: { ownerId: string; organizationId?: string | null }): string {
  return repo.organizationId ?? repo.ownerId;
}

export type ResolvedRepo = {
  id: string;
  name: string;
  description: string | null;
  ownerId: string;
  organizationId: string | null;
  visibility: string;
  defaultBranch: string;
  storageOwnerId: string;
  ownerSlug: string;
  ownerType: 'user' | 'org';
  ownerDisplay: string;
};

export async function resolveRepositoryBySlug(
  ownerSlug: string,
  repoName: string
): Promise<ResolvedRepo | null> {
  const normalizedRepoName = repoName.replace(/\.git$/, '');

  const orgResult = await db
    .select({
      id: repositories.id,
      name: repositories.name,
      description: repositories.description,
      ownerId: repositories.ownerId,
      organizationId: repositories.organizationId,
      visibility: repositories.visibility,
      defaultBranch: repositories.defaultBranch,
      orgName: organizations.name,
      orgDisplayName: organizations.displayName,
    })
    .from(repositories)
    .innerJoin(organizations, eq(organizations.id, repositories.organizationId))
    .where(and(eq(organizations.name, ownerSlug), eq(repositories.name, normalizedRepoName)))
    .limit(1);

  const orgRow = orgResult[0];
  if (orgRow) {
    return {
      id: orgRow.id,
      name: orgRow.name,
      description: orgRow.description,
      ownerId: orgRow.ownerId,
      organizationId: orgRow.organizationId,
      visibility: orgRow.visibility,
      defaultBranch: orgRow.defaultBranch,
      storageOwnerId: getStorageOwnerId(orgRow),
      ownerSlug: orgRow.orgName,
      ownerType: 'org',
      ownerDisplay: orgRow.orgDisplayName || orgRow.orgName,
    };
  }

  const userResult = await db
    .select({
      id: repositories.id,
      name: repositories.name,
      description: repositories.description,
      ownerId: repositories.ownerId,
      organizationId: repositories.organizationId,
      visibility: repositories.visibility,
      defaultBranch: repositories.defaultBranch,
      username: users.username,
      userName: users.name,
    })
    .from(repositories)
    .innerJoin(users, eq(users.id, repositories.ownerId))
    .where(
      and(
        eq(users.username, ownerSlug),
        isNull(repositories.organizationId),
        eq(repositories.name, normalizedRepoName)
      )
    )
    .limit(1);

  const userRow = userResult[0];
  if (!userRow) {
    return null;
  }

  return {
    id: userRow.id,
    name: userRow.name,
    description: userRow.description,
    ownerId: userRow.ownerId,
    organizationId: userRow.organizationId,
    visibility: userRow.visibility,
    defaultBranch: userRow.defaultBranch,
    storageOwnerId: getStorageOwnerId(userRow),
    ownerSlug: userRow.username,
    ownerType: 'user',
    ownerDisplay: userRow.userName || userRow.username,
  };
}

export function createRepoGitStore(repo: ResolvedRepo): GitStore {
  return createGitStore(repo.storageOwnerId, repo.name);
}
