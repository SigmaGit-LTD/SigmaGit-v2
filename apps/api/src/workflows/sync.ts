/**
 * Sync workflow definitions from the repository's git tree into the DB.
 *
 * Reads `.sigmagit/workflows/*.yml` (and `.yml`-adjacent `.yaml`) files from
 * the HEAD of the given branch and upserts the `workflows` table.
 */
import { db, repositories, users, workflows } from '@sigmagit/db';
import { and, eq, notInArray } from 'drizzle-orm';
import { createGitStore, getTree, getBlobByOid } from '../git';
import { getStorageOwnerId } from '../lib/repo-helpers';

const WORKFLOW_DIRS = ['.sigmagit/workflows', '.github/workflows'];

interface WorkflowTriggers {
  push?: { branches?: string[] };
  pull_request?: { branches?: string[] };
  workflow_dispatch?: boolean;
}

/** Minimal YAML parser — only handles the `name:` and `on:` top-level keys */
function parseWorkflowYaml(content: string): {
  name: string;
  triggers: WorkflowTriggers;
} {
  const lines = content.split('\n');
  let name = 'Unnamed Workflow';
  const triggers: WorkflowTriggers = {};
  let inOn = false;
  let inPush = false;
  let inPR = false;
  let indent = 0;

  for (const line of lines) {
    const trimmed = line.trimStart();
    const currentIndent = line.length - trimmed.length;

    // top-level keys
    if (currentIndent === 0) {
      inOn = false;
      inPush = false;
      inPR = false;
    }

    if (currentIndent === 0 && trimmed.startsWith('name:')) {
      name = trimmed.slice(5).trim().replace(/^["']|["']$/g, '');
    }

    if (currentIndent === 0 && (trimmed === 'on:' || trimmed.startsWith('on: '))) {
      inOn = true;
      indent = currentIndent;
      // Handle inline: on: [push, pull_request]
      const inline = trimmed.slice(3).trim();
      if (inline.startsWith('[')) {
        const events = inline.replace(/[\[\]]/g, '').split(',').map((s) => s.trim());
        if (events.includes('push')) triggers.push = {};
        if (events.includes('pull_request')) triggers.pull_request = {};
        if (events.includes('workflow_dispatch')) triggers.workflow_dispatch = true;
        inOn = false;
      }
      continue;
    }

    if (inOn) {
      if (currentIndent > indent) {
        if (trimmed.startsWith('push:') || trimmed === 'push') {
          triggers.push = {};
          inPush = true;
          inPR = false;
        } else if (trimmed.startsWith('pull_request:') || trimmed === 'pull_request') {
          triggers.pull_request = {};
          inPush = false;
          inPR = true;
        } else if (trimmed.startsWith('workflow_dispatch:') || trimmed === 'workflow_dispatch') {
          triggers.workflow_dispatch = true;
          inPush = false;
          inPR = false;
        } else if (inPush && trimmed.startsWith('branches:')) {
          // Parse branches list
          const branchInline = trimmed.slice(9).trim();
          if (branchInline.startsWith('[')) {
            const branches = branchInline.replace(/[\[\]]/g, '').split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
            triggers.push = { ...triggers.push, branches };
          }
        } else if (inPR && trimmed.startsWith('branches:')) {
          const branchInline = trimmed.slice(9).trim();
          if (branchInline.startsWith('[')) {
            const branches = branchInline.replace(/[\[\]]/g, '').split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
            triggers.pull_request = { ...triggers.pull_request, branches };
          }
        }
      }
    }
  }

  return { name, triggers };
}

export async function syncWorkflows(repoId: string): Promise<void> {
  try {
    // Get repository info
    const [repo] = await db
      .select({
        ownerId: repositories.ownerId,
        organizationId: repositories.organizationId,
        name: repositories.name,
        defaultBranch: repositories.defaultBranch,
      })
      .from(repositories)
      .where(eq(repositories.id, repoId))
      .limit(1);

    if (!repo) return;

    const [owner] = await db
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, repo.ownerId))
      .limit(1);

    if (!owner) return;

    const storageOwnerId = getStorageOwnerId(repo);
    const { fs, dir } = createGitStore(storageOwnerId, repo.name);

    const foundWorkflows: Array<{ path: string; name: string; content: string; triggers: WorkflowTriggers }> = [];

    for (const workflowDir of WORKFLOW_DIRS) {
      const entries = await getTree(fs, dir, repo.defaultBranch, workflowDir);
      if (!entries) continue;

      for (const entry of entries) {
        if (entry.type !== 'blob') continue;
        if (!entry.name.endsWith('.yml') && !entry.name.endsWith('.yaml')) continue;

        const content = await getBlobByOid(fs, dir, entry.oid);
        if (!content) continue;

        const { name, triggers } = parseWorkflowYaml(content);
        foundWorkflows.push({ path: entry.path, name, content, triggers });
      }
    }

    if (foundWorkflows.length === 0) {
      // Deactivate all workflows for repo
      await db
        .update(workflows)
        .set({ active: false })
        .where(eq(workflows.repositoryId, repoId));
      return;
    }

    const foundPaths = foundWorkflows.map((w) => w.path);

    // Deactivate workflows not found in tree
    const existing = await db
      .select({ id: workflows.id, path: workflows.path })
      .from(workflows)
      .where(eq(workflows.repositoryId, repoId));

    const toDeactivate = existing
      .filter((w) => !foundPaths.includes(w.path))
      .map((w) => w.id);

    if (toDeactivate.length > 0) {
      await db
        .update(workflows)
        .set({ active: false })
        .where(and(eq(workflows.repositoryId, repoId), notInArray(workflows.id, toDeactivate)));
    }

    // Upsert each found workflow
    for (const wf of foundWorkflows) {
      const [existingWf] = await db
        .select({ id: workflows.id })
        .from(workflows)
        .where(and(eq(workflows.repositoryId, repoId), eq(workflows.path, wf.path)))
        .limit(1);

      if (existingWf) {
        await db
          .update(workflows)
          .set({ name: wf.name, content: wf.content, triggers: wf.triggers, active: true, updatedAt: new Date() })
          .where(eq(workflows.id, existingWf.id));
      } else {
        await db.insert(workflows).values({
          repositoryId: repoId,
          name: wf.name,
          path: wf.path,
          content: wf.content,
          triggers: wf.triggers,
          active: true,
        });
      }
    }

    console.log(`[Workflows] Synced ${foundWorkflows.length} workflow(s) for repo ${repoId}`);
  } catch (err) {
    console.error('[Workflows] syncWorkflows error:', err);
  }
}
