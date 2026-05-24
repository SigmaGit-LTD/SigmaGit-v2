import {
  db,
  repositoryCollaborators,
  organizationMembers,
  teamRepositories,
  teamMembers,
} from '@sigmagit/db';
import { eq, and } from 'drizzle-orm';

export type AccessUser = { id: string; role?: string } | null | undefined;
export type Repository = {
  id: string;
  ownerId: string;
  organizationId?: string | null;
  visibility: string;
};

type RepoPermission = 'read' | 'write' | 'admin';

const PERMISSION_RANK: Record<RepoPermission, number> = {
  read: 1,
  write: 2,
  admin: 3,
};

function hasWritePermission(permission: RepoPermission): boolean {
  return permission === 'write' || permission === 'admin';
}

function satisfiesAccess(permission: RepoPermission, writeRequired: boolean): boolean {
  if (writeRequired) {
    return hasWritePermission(permission);
  }
  return true;
}

async function getCollaboratorPermission(
  repositoryId: string,
  userId: string
): Promise<RepoPermission | null> {
  const collaborator = await db.query.repositoryCollaborators.findFirst({
    where: and(
      eq(repositoryCollaborators.repositoryId, repositoryId),
      eq(repositoryCollaborators.userId, userId)
    ),
  });

  return collaborator?.permission ?? null;
}

async function getBestTeamPermission(
  repositoryId: string,
  userId: string
): Promise<RepoPermission | null> {
  const rows = await db
    .select({ permission: teamRepositories.permission })
    .from(teamRepositories)
    .innerJoin(teamMembers, eq(teamMembers.teamId, teamRepositories.teamId))
    .where(and(eq(teamRepositories.repositoryId, repositoryId), eq(teamMembers.userId, userId)));

  if (rows.length === 0) {
    return null;
  }

  return rows.reduce<RepoPermission>(
    (best, row) => (PERMISSION_RANK[row.permission] > PERMISSION_RANK[best] ? row.permission : best),
    rows[0].permission
  );
}

async function getOrgMemberRole(
  organizationId: string,
  userId: string
): Promise<'owner' | 'admin' | 'member' | null> {
  const member = await db.query.organizationMembers.findFirst({
    where: and(
      eq(organizationMembers.organizationId, organizationId),
      eq(organizationMembers.userId, userId)
    ),
  });

  return member?.role ?? null;
}

/**
 * Check if a user can access a repository.
 *
 * - Admins always have READ access to all repos
 * - Public repos are readable by anyone
 * - Private repos require owner, collaborator, org membership, or team access
 * - Org owners/admins have full access to org repos
 * - Org members can read public org repos
 * - Team access is granted via teamRepositories joined through teamMembers
 * - For write operations, admins still need explicit collaborator status
 */
export async function canAccessRepository(
  repo: Repository,
  user: AccessUser,
  writeRequired = false
): Promise<boolean> {
  // Admins always have READ access to everything
  if (user?.role === 'admin' && user?.id) {
    // For write operations, admins still need to be owner or write/admin collaborator
    if (!writeRequired) return true;
    if (user.id === repo.ownerId) return true;
    const permission = await getCollaboratorPermission(repo.id, user.id);
    return permission != null && hasWritePermission(permission);
  }

  // Public repos - anyone can read
  if (repo.visibility === 'public' && !writeRequired) return true;

  // Need auth for private repos (check both user existence and id)
  if (!user?.id) return false;

  // Owner always has access
  if (user.id === repo.ownerId) return true;

  // Organization membership
  if (repo.organizationId) {
    const role = await getOrgMemberRole(repo.organizationId, user.id);
    if (role === 'owner' || role === 'admin') return true;
    if (role === 'member' && repo.visibility === 'public' && !writeRequired) return true;
  }

  // Check collaborator status
  const collaboratorPermission = await getCollaboratorPermission(repo.id, user.id);
  if (collaboratorPermission != null) {
    return satisfiesAccess(collaboratorPermission, writeRequired);
  }

  // Check team repository access
  const teamPermission = await getBestTeamPermission(repo.id, user.id);
  if (teamPermission != null) {
    return satisfiesAccess(teamPermission, writeRequired);
  }

  return false;
}
