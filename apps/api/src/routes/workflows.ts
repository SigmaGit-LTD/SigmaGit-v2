import { Hono } from 'hono';
import { db, users, repositories, workflows, workflowRuns, workflowJobs, workflowSteps } from '@sigmagit/db';
import { eq, and, desc, asc, inArray } from 'drizzle-orm';
import { authMiddleware, requireAuth, type AuthVariables } from '../middleware/auth';
import { parseLimit, parsePage } from '../lib/validation';
import { canAccessRepository } from '../lib/access';
import { syncWorkflows } from '../workflows/sync';
import { triggerWorkflows } from '../workflows/trigger';

const app = new Hono<{ Variables: AuthVariables }>();


// ─── Helper ────────────────────────────────────────────────────────────────────

async function getRepoAccess(owner: string, name: string, user?: { id: string; role?: string } | null) {
  const [row] = await db
    .select({
      id: repositories.id,
      ownerId: repositories.ownerId,
      visibility: repositories.visibility,
      defaultBranch: repositories.defaultBranch,
    })
    .from(repositories)
    .innerJoin(users, eq(users.id, repositories.ownerId))
    .where(and(eq(users.username, owner), eq(repositories.name, name)))
    .limit(1);

  if (!row) return null;
  if (!(await canAccessRepository(row, user))) return null;
  return row;
}

// ─── Workflow sync ─────────────────────────────────────────────────────────────

app.post('/api/repositories/:owner/:repo/workflows/sync', requireAuth, async (c) => {
  const owner = c.req.param('owner');
  const repo = c.req.param('repo');
  const user = c.get('user')!;

  const repoRow = await getRepoAccess(owner, repo, user);
  if (!repoRow) return c.json({ error: 'Repository not found' }, 404);
  if (user.id !== repoRow.ownerId) return c.json({ error: 'Forbidden' }, 403);

  await syncWorkflows(repoRow.id);

  const wfs = await db
    .select()
    .from(workflows)
    .where(eq(workflows.repositoryId, repoRow.id))
    .orderBy(workflows.name);

  return c.json({ workflows: wfs });
});

// ─── List workflows ────────────────────────────────────────────────────────────

app.get('/api/repositories/:owner/:repo/workflows', async (c) => {
  const owner = c.req.param('owner');
  const repo = c.req.param('repo');
  const user = c.get('user');

  const repoRow = await getRepoAccess(owner, repo, user);
  if (!repoRow) return c.json({ error: 'Repository not found' }, 404);

  const wfs = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.repositoryId, repoRow.id), eq(workflows.active, true)))
    .orderBy(workflows.name);

  return c.json({ workflows: wfs });
});

// ─── Manual dispatch ───────────────────────────────────────────────────────────

app.post('/api/repositories/:owner/:repo/workflows/:workflowId/dispatch', requireAuth, async (c) => {
  const owner = c.req.param('owner');
  const repo = c.req.param('repo');
  const workflowId = c.req.param('workflowId');
  const user = c.get('user')!;

  const repoRow = await getRepoAccess(owner, repo, user);
  if (!repoRow) return c.json({ error: 'Repository not found' }, 404);
  if (user.id !== repoRow.ownerId) return c.json({ error: 'Forbidden' }, 403);

  const body = await c.req.json().catch(() => ({})) as {
    ref?: string;
    commitSha?: string;
    inputs?: Record<string, string>;
  };

  // Resolve commitSha from branch if not provided
  let commitSha = body.commitSha ?? '';
  const branch = body.ref ?? repoRow.defaultBranch;

  if (!commitSha) {
    // Try to get HEAD of the branch from repoBranchMetadata
    const { repoBranchMetadata } = await import('@sigmagit/db');
    const [meta] = await db
      .select({ headOid: repoBranchMetadata.headOid })
      .from(repoBranchMetadata)
      .where(and(eq(repoBranchMetadata.repoId, repoRow.id), eq(repoBranchMetadata.branch, branch)))
      .limit(1);
    commitSha = meta?.headOid ?? 'HEAD';
  }

  const runIds = await triggerWorkflows({
    repoId: repoRow.id,
    branch,
    commitSha,
    eventName: 'workflow_dispatch',
    eventPayload: { inputs: body.inputs ?? {} },
    triggeredBy: user.id,
    workflowId,
  });

  return c.json({ runIds });
});

// ─── List runs ─────────────────────────────────────────────────────────────────

app.get('/api/repositories/:owner/:repo/runs', async (c) => {
  const owner = c.req.param('owner');
  const repo = c.req.param('repo');
  const user = c.get('user');

  const repoRow = await getRepoAccess(owner, repo, user);
  if (!repoRow) return c.json({ error: 'Repository not found' }, 404);

  const page = parsePage(c.req.query('page'), 1);
  const perPage = parseLimit(c.req.query('per_page'), 20, 100);
  const offset = (page - 1) * perPage;

  const runs = await db
    .select({
      id: workflowRuns.id,
      workflowId: workflowRuns.workflowId,
      commitSha: workflowRuns.commitSha,
      branch: workflowRuns.branch,
      eventName: workflowRuns.eventName,
      status: workflowRuns.status,
      conclusion: workflowRuns.conclusion,
      startedAt: workflowRuns.startedAt,
      completedAt: workflowRuns.completedAt,
      createdAt: workflowRuns.createdAt,
      workflowName: workflows.name,
    })
    .from(workflowRuns)
    .leftJoin(workflows, eq(workflows.id, workflowRuns.workflowId))
    .where(eq(workflowRuns.repositoryId, repoRow.id))
    .orderBy(desc(workflowRuns.createdAt))
    .limit(perPage)
    .offset(offset);

  return c.json({ runs });
});

// ─── Get single run ────────────────────────────────────────────────────────────

app.get('/api/repositories/:owner/:repo/runs/:runId', async (c) => {
  const owner = c.req.param('owner');
  const repo = c.req.param('repo');
  const runId = c.req.param('runId');
  const user = c.get('user');

  const repoRow = await getRepoAccess(owner, repo, user);
  if (!repoRow) return c.json({ error: 'Repository not found' }, 404);

  const [run] = await db
    .select()
    .from(workflowRuns)
    .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.repositoryId, repoRow.id)))
    .limit(1);

  if (!run) return c.json({ error: 'Run not found' }, 404);

  const jobs = await db
    .select()
    .from(workflowJobs)
    .where(eq(workflowJobs.runId, runId))
    .orderBy(asc(workflowJobs.createdAt));

  const jobIds = jobs.map((j) => j.id);
  const stepsByJobId = new Map<string, typeof workflowSteps.$inferSelect[]>();
  if (jobIds.length > 0) {
    const allSteps = await db
      .select()
      .from(workflowSteps)
      .where(inArray(workflowSteps.jobId, jobIds))
      .orderBy(asc(workflowSteps.number));
    for (const step of allSteps) {
      const list = stepsByJobId.get(step.jobId) ?? [];
      list.push(step);
      stepsByJobId.set(step.jobId, list);
    }
  }
  const jobsWithSteps = jobs.map((job) => ({ ...job, steps: stepsByJobId.get(job.id) ?? [] }));

  return c.json({ run, jobs: jobsWithSteps });
});

// ─── Job logs ──────────────────────────────────────────────────────────────────

app.get('/api/repositories/:owner/:repo/runs/:runId/jobs/:jobId/logs', async (c) => {
  const owner = c.req.param('owner');
  const repo = c.req.param('repo');
  const runId = c.req.param('runId');
  const jobId = c.req.param('jobId');
  const user = c.get('user');

  const repoRow = await getRepoAccess(owner, repo, user);
  if (!repoRow) return c.json({ error: 'Repository not found' }, 404);

  const [job] = await db
    .select({ id: workflowJobs.id })
    .from(workflowJobs)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowJobs.runId))
    .where(
      and(
        eq(workflowJobs.id, jobId),
        eq(workflowRuns.id, runId),
        eq(workflowRuns.repositoryId, repoRow.id)
      )
    )
    .limit(1);

  if (!job) return c.json({ error: 'Job not found' }, 404);

  const steps = await db
    .select()
    .from(workflowSteps)
    .where(eq(workflowSteps.jobId, jobId))
    .orderBy(asc(workflowSteps.number));

  // Aggregate log output
  const logs = steps
    .map((s) => `=== Step ${s.number}: ${s.name} ===\n${s.logOutput ?? '(no output)'}`)
    .join('\n\n');

  return c.json({ logs, steps });
});

// ─── Cancel run ────────────────────────────────────────────────────────────────

app.post('/api/repositories/:owner/:repo/runs/:runId/cancel', requireAuth, async (c) => {
  const owner = c.req.param('owner');
  const repo = c.req.param('repo');
  const runId = c.req.param('runId');
  const user = c.get('user')!;

  const repoRow = await getRepoAccess(owner, repo, user);
  if (!repoRow) return c.json({ error: 'Repository not found' }, 404);
  if (user.id !== repoRow.ownerId) return c.json({ error: 'Forbidden' }, 403);

  const now = new Date();

  // Cancel queued/assigned jobs
  await db
    .update(workflowJobs)
    .set({ status: 'cancelled', conclusion: 'cancelled', completedAt: now })
    .where(and(eq(workflowJobs.runId, runId)));

  await db
    .update(workflowRuns)
    .set({ status: 'completed', conclusion: 'cancelled', completedAt: now })
    .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.repositoryId, repoRow.id)));

  return c.json({ success: true });
});

export default app;
