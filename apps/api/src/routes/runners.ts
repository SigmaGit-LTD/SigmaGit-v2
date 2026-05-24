import { Hono } from 'hono';
import { db, repositories, repositoryCollaborators, runners, users, workflowJobs, workflowRuns, workflowSteps } from '@sigmagit/db';
import { and, eq, isNull, asc, or } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { authMiddleware, requireAdmin, type AuthVariables } from '../middleware/auth';
import { requireRunnerAuth, type RunnerVariables } from '../middleware/runner-auth';
import { notifyUsers } from '../websocket';
import { config } from '../config';

type Variables = AuthVariables & RunnerVariables;

const app = new Hono<{ Variables: Variables }>();

function authorizeRunnerRegistration(c: { req: { header: (name: string) => string | undefined }; get: (key: string) => AuthUser | null }): boolean {
  const secret = config.runnerRegistrationSecret;
  if (!secret) {
    return !config.isProduction;
  }
  const authHeader = c.req.header('authorization');
  if (authHeader?.startsWith('Bearer ') && authHeader.slice(7) === secret) {
    return true;
  }
  const user = c.get('user');
  return user?.role === 'admin';
}

type AuthUser = AuthVariables['user'];


app.post('/api/runners/register', async (c) => {
  if (!authorizeRunnerRegistration(c)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const body = await c.req.json().catch(() => ({}));
  const { name, labels, os, arch, version } = body as {
    name?: string;
    labels?: string[];
    os?: string;
    arch?: string;
    version?: string;
  };

  if (!name) {
    return c.json({ error: 'name is required' }, 400);
  }

  const token = `RUNNER_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex')}`;

  const [runner] = await db
    .insert(runners)
    .values({
      name,
      token,
      labels: labels ?? [],
      status: 'online',
      lastSeenAt: new Date(),
      ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? null,
      os: os ?? null,
      arch: arch ?? null,
      version: version ?? null,
    })
    .returning({ id: runners.id });

  console.log(`[Runners] Registered runner: ${name} (${runner.id})`);

  return c.json({ id: runner.id, token });
});

// ─── Heartbeat — poll for jobs ─────────────────────────────────────────────────

app.post('/api/runners/:runnerId/heartbeat', requireRunnerAuth, async (c) => {
  const runner = c.get('runner');
  const now = new Date();

  // Update heartbeat
  await db
    .update(runners)
    .set({ lastSeenAt: now, updatedAt: now })
    .where(eq(runners.id, runner.id));

  // Atomically claim next queued job (conditional update prevents double-assign)
  const [nextJob] = await db
    .select({ id: workflowJobs.id })
    .from(workflowJobs)
    .where(and(eq(workflowJobs.status, 'queued'), isNull(workflowJobs.runnerId)))
    .orderBy(asc(workflowJobs.createdAt))
    .limit(1);

  let job: {
    id: string;
    runId: string;
    name: string;
    workflowDefinition: unknown;
  } | null = null;

  if (nextJob) {
    const [claimed] = await db
      .update(workflowJobs)
      .set({ runnerId: runner.id, status: 'assigned', startedAt: now })
      .where(
        and(
          eq(workflowJobs.id, nextJob.id),
          eq(workflowJobs.status, 'queued'),
          isNull(workflowJobs.runnerId)
        )
      )
      .returning({
        id: workflowJobs.id,
        runId: workflowJobs.runId,
        name: workflowJobs.name,
        workflowDefinition: workflowJobs.workflowDefinition,
      });
    job = claimed ?? null;
  }

  if (!job) {
    await db
      .update(runners)
      .set({ status: 'online', currentJobId: null, updatedAt: now })
      .where(eq(runners.id, runner.id));
    return c.json({ job: null });
  }

  await db
    .update(runners)
    .set({ status: 'busy', currentJobId: job.id, updatedAt: now })
    .where(eq(runners.id, runner.id));

  // Fetch run context for the job
  const [run] = await db
    .select({
      commitSha: workflowRuns.commitSha,
      branch: workflowRuns.branch,
      eventName: workflowRuns.eventName,
      eventPayload: workflowRuns.eventPayload,
      repositoryId: workflowRuns.repositoryId,
      repoOwner: users.username,
      repoName: repositories.name,
    })
    .from(workflowRuns)
    .innerJoin(repositories, eq(repositories.id, workflowRuns.repositoryId))
    .innerJoin(users, eq(users.id, repositories.ownerId))
    .where(eq(workflowRuns.id, job.runId))
    .limit(1);

  console.log(`[Runners] Assigned job ${job.id} (${job.name}) to runner ${runner.id}`);

  return c.json({
    job: {
      id: job.id,
      runId: job.runId,
      name: job.name,
      workflowDefinition: job.workflowDefinition,
      commitSha: run?.commitSha ?? '',
      branch: run?.branch ?? '',
      eventName: run?.eventName ?? 'push',
      eventPayload: run?.eventPayload ?? {},
      repoOwner: run?.repoOwner ?? '',
      repoName: run?.repoName ?? '',
    },
  });
});

// ─── Progress — streaming step updates ─────────────────────────────────────────

app.post('/api/runners/:runnerId/jobs/:jobId/progress', requireRunnerAuth, async (c) => {
  const jobId = c.req.param('jobId');
  const body = await c.req.json().catch(() => ({}));
  const { stepName, stepNumber, status, logChunk, exitCode } = body as {
    stepName?: string;
    stepNumber?: number;
    status?: string;
    logChunk?: string;
    exitCode?: number;
  };

  const now = new Date();

  // Mark job as in_progress if needed
  await db
    .update(workflowJobs)
    .set({ status: 'in_progress' })
    .where(and(eq(workflowJobs.id, jobId), eq(workflowJobs.status, 'assigned')));

  // Upsert step record
  if (stepName && stepNumber != null) {
    const existingStep = await db.query.workflowSteps.findFirst({
      where: and(eq(workflowSteps.jobId, jobId), eq(workflowSteps.number, stepNumber)),
    });

    if (existingStep) {
      await db
        .update(workflowSteps)
        .set({
          status: (status as any) ?? existingStep.status,
          exitCode: exitCode ?? existingStep.exitCode,
          logOutput: logChunk
            ? (existingStep.logOutput ?? '') + logChunk
            : existingStep.logOutput,
          ...(status === 'in_progress' && !existingStep.startedAt ? { startedAt: now } : {}),
          ...(status === 'completed' || status === 'failed'
            ? { completedAt: now }
            : {}),
        })
        .where(eq(workflowSteps.id, existingStep.id));
    } else {
      await db.insert(workflowSteps).values({
        jobId,
        number: stepNumber,
        name: stepName,
        status: (status as any) ?? 'in_progress',
        exitCode: exitCode ?? null,
        logOutput: logChunk ?? null,
        startedAt: status === 'in_progress' ? now : null,
      });
    }
  }

  // Notify subscribed users via WebSocket (best-effort); include repoOwner/repoName/runId for client cache invalidation
  try {
    const [run] = await db
      .select({
        triggeredBy: workflowRuns.triggeredBy,
        repositoryId: workflowRuns.repositoryId,
        runId: workflowRuns.id,
        repoOwner: users.username,
        repoName: repositories.name,
        repoOwnerId: users.id,
      })
      .from(workflowJobs)
      .innerJoin(workflowRuns, eq(workflowRuns.id, workflowJobs.runId))
      .innerJoin(repositories, eq(repositories.id, workflowRuns.repositoryId))
      .innerJoin(users, eq(users.id, repositories.ownerId))
      .where(eq(workflowJobs.id, jobId))
      .limit(1);

    if (run) {
      const payload = {
        type: 'workflow_job.log_chunk',
        jobId,
        runId: run.runId,
        repoOwner: run.repoOwner,
        repoName: run.repoName,
        stepNumber,
        stepName,
        logChunk,
        status,
      };
      const collaborators = await db
        .select({ userId: repositoryCollaborators.userId })
        .from(repositoryCollaborators)
        .where(eq(repositoryCollaborators.repositoryId, run.repositoryId));
      const recipientIds = new Set<string>(collaborators.map((c) => c.userId));
      if (run.triggeredBy) recipientIds.add(run.triggeredBy);
      if (run.repoOwnerId) recipientIds.add(run.repoOwnerId);
      notifyUsers(Array.from(recipientIds), payload);
    }
  } catch {
    // Non-critical
  }

  return c.json({ success: true });
});

// ─── Complete — job finished ────────────────────────────────────────────────────

app.post('/api/runners/:runnerId/jobs/:jobId/complete', requireRunnerAuth, async (c) => {
  const runner = c.get('runner');
  const jobId = c.req.param('jobId');
  const body = await c.req.json().catch(() => ({}));
  const { status, conclusion, steps } = body as {
    status?: string;
    conclusion?: string;
    steps?: Array<{ name: string; number: number; exitCode?: number; logOutput?: string; status?: string }>;
  };

  const now = new Date();

  // Update job
  await db
    .update(workflowJobs)
    .set({
      status: (status as any) ?? 'completed',
      conclusion: (conclusion as any) ?? null,
      completedAt: now,
    })
    .where(eq(workflowJobs.id, jobId));

  // Bulk upsert step records
  if (steps && steps.length > 0) {
    for (const step of steps) {
      const existing = await db.query.workflowSteps.findFirst({
        where: and(eq(workflowSteps.jobId, jobId), eq(workflowSteps.number, step.number)),
      });

      if (existing) {
        await db
          .update(workflowSteps)
          .set({
            status: (step.status as any) ?? 'completed',
            exitCode: step.exitCode ?? existing.exitCode,
            logOutput: step.logOutput ?? existing.logOutput,
            completedAt: now,
          })
          .where(eq(workflowSteps.id, existing.id));
      } else {
        await db.insert(workflowSteps).values({
          jobId,
          number: step.number,
          name: step.name,
          status: (step.status as any) ?? 'completed',
          exitCode: step.exitCode ?? null,
          logOutput: step.logOutput ?? null,
          completedAt: now,
        });
      }
    }
  }

  // Clear runner state
  await db
    .update(runners)
    .set({ status: 'online', currentJobId: null, updatedAt: now })
    .where(eq(runners.id, runner.id));

  // Check if all jobs in the run are done → finalize workflow_runs
  const [job] = await db
    .select({ runId: workflowJobs.runId })
    .from(workflowJobs)
    .where(eq(workflowJobs.id, jobId))
    .limit(1);

  if (job?.runId) {
    await finalizeRunIfComplete(job.runId, now);

    // Notify via WebSocket; include repoOwner/repoName so client can invalidate workflow-run and workflow-runs
    try {
      const [run] = await db
        .select({
          triggeredBy: workflowRuns.triggeredBy,
          repositoryId: workflowRuns.repositoryId,
          repoOwner: users.username,
          repoName: repositories.name,
          repoOwnerId: users.id,
        })
        .from(workflowRuns)
        .innerJoin(repositories, eq(repositories.id, workflowRuns.repositoryId))
        .innerJoin(users, eq(users.id, repositories.ownerId))
        .where(eq(workflowRuns.id, job.runId))
        .limit(1);

      if (run) {
        const payload = {
          type: 'workflow_job.status_changed',
          jobId,
          runId: job.runId,
          repoOwner: run.repoOwner,
          repoName: run.repoName,
          status,
          conclusion,
        };
        const collaborators = await db
          .select({ userId: repositoryCollaborators.userId })
          .from(repositoryCollaborators)
          .where(eq(repositoryCollaborators.repositoryId, run.repositoryId));
        const recipientIds = new Set<string>(collaborators.map((c) => c.userId));
        if (run.triggeredBy) recipientIds.add(run.triggeredBy);
        if (run.repoOwnerId) recipientIds.add(run.repoOwnerId);
        notifyUsers(Array.from(recipientIds), payload);
      }
    } catch {
      // Non-critical
    }
  }

  console.log(`[Runners] Job ${jobId} completed with ${conclusion ?? status} by runner ${runner.id}`);

  return c.json({ success: true });
});

async function finalizeRunIfComplete(runId: string, now: Date) {
  const allJobs = await db
    .select({ status: workflowJobs.status, conclusion: workflowJobs.conclusion })
    .from(workflowJobs)
    .where(eq(workflowJobs.runId, runId));

  const pending = allJobs.filter(
    (j) => j.status === 'queued' || j.status === 'assigned' || j.status === 'in_progress'
  );

  if (pending.length > 0) return;

  const anyFailed = allJobs.some((j) => j.conclusion === 'failure' || j.status === 'failed');
  const anyCancelled = allJobs.some((j) => j.conclusion === 'cancelled' || j.status === 'cancelled');

  await db
    .update(workflowRuns)
    .set({
      status: 'completed',
      conclusion: anyFailed ? 'failure' : anyCancelled ? 'cancelled' : 'success',
      completedAt: now,
    })
    .where(eq(workflowRuns.id, runId));
}

// ─── Admin endpoints ───────────────────────────────────────────────────────────

app.use('/api/runners', requireAdmin);

app.get('/api/runners', async (c) => {
  const rows = await db
    .select({
      id: runners.id,
      name: runners.name,
      status: runners.status,
      labels: runners.labels,
      os: runners.os,
      arch: runners.arch,
      version: runners.version,
      lastSeenAt: runners.lastSeenAt,
      currentJobId: runners.currentJobId,
      ipAddress: runners.ipAddress,
      createdAt: runners.createdAt,
      currentRunId: workflowRuns.id,
      repoOwner: users.username,
      repoName: repositories.name,
    })
    .from(runners)
    .leftJoin(workflowJobs, eq(workflowJobs.id, runners.currentJobId))
    .leftJoin(workflowRuns, eq(workflowRuns.id, workflowJobs.runId))
    .leftJoin(repositories, eq(repositories.id, workflowRuns.repositoryId))
    .leftJoin(users, eq(users.id, repositories.ownerId))
    .orderBy(runners.createdAt);

  let jobStats: Array<{ runnerId: string; total: number; success: number }> = [];
  if (rows.length > 0) {
    const raw = await db.execute(sql`
      SELECT runner_id as "runnerId",
        count(*)::int as total,
        count(*) FILTER (WHERE conclusion = 'success')::int as success
      FROM workflow_jobs
      WHERE runner_id IS NOT NULL
        AND status IN ('completed', 'failed', 'cancelled')
      GROUP BY runner_id
    `);
    const rawRows = Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? [];
    jobStats = rawRows as Array<{ runnerId: string; total: number; success: number }>;
  }

  const countMap = new Map<string, { total: number; success: number }>();
  for (const row of jobStats) {
    if (row.runnerId) countMap.set(row.runnerId, { total: row.total, success: row.success });
  }

  const runnersList = rows.map((r) => {
    const counts = r.id ? countMap.get(r.id) : null;
    return {
      id: r.id,
      name: r.name,
      status: r.status,
      labels: r.labels,
      os: r.os,
      arch: r.arch,
      version: r.version,
      lastSeenAt: r.lastSeenAt,
      currentJobId: r.currentJobId,
      ipAddress: r.ipAddress,
      createdAt: r.createdAt,
      ...(r.currentJobId && r.currentRunId && r.repoOwner && r.repoName
        ? { currentRunId: r.currentRunId, repoOwner: r.repoOwner, repoName: r.repoName }
        : {}),
      ...(counts
        ? {
            jobsRunCount: counts.total,
            jobsSuccessCount: counts.success,
            successRate: counts.total > 0 ? Math.round((counts.success / counts.total) * 100) : null,
          }
        : {}),
    };
  });

  return c.json({ runners: runnersList });
});

app.delete('/api/runners/:runnerId', authMiddleware, requireAdmin, async (c) => {
  const runnerId = c.req.param('runnerId');
  const now = new Date();

  // Fail any active jobs
  await db
    .update(workflowJobs)
    .set({ status: 'failed', conclusion: 'failure', completedAt: now })
    .where(
      and(
        eq(workflowJobs.runnerId, runnerId),
        or(eq(workflowJobs.status, 'assigned'), eq(workflowJobs.status, 'in_progress'))
      )
    );

  await db.delete(runners).where(eq(runners.id, runnerId));

  return c.json({ success: true });
});

export default app;
