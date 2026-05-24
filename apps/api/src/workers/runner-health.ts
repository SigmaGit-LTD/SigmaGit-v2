import { db, runners, workflowJobs } from '@sigmagit/db';
import { and, eq, inArray, isNotNull, lt, or } from 'drizzle-orm';

const OFFLINE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes
const STALE_JOB_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

let healthInterval: NodeJS.Timeout | null = null;

async function checkRunnerHealth() {
  const now = new Date();
  const offlineCutoff = new Date(now.getTime() - OFFLINE_THRESHOLD_MS);

  try {
    // Mark runners as offline if they haven't sent a heartbeat recently
    const offlineRunners = await db
      .update(runners)
      .set({ status: 'offline', updatedAt: now })
      .where(
        and(
          or(eq(runners.status, 'online'), eq(runners.status, 'busy')),
          lt(runners.lastSeenAt, offlineCutoff)
        )
      )
      .returning({ id: runners.id, name: runners.name });

    if (offlineRunners.length > 0) {
      console.log(`[RunnerHealth] Marked ${offlineRunners.length} runner(s) offline:`, offlineRunners.map((r) => r.name));
    }

    // Find jobs stuck in_progress/assigned with no active runner, and fail them
    const staleJobCutoff = new Date(now.getTime() - STALE_JOB_THRESHOLD_MS);
    const offlineRunnerIds = offlineRunners.map((r) => r.id);

    if (offlineRunnerIds.length > 0) {
      const stalledJobs = await db
        .update(workflowJobs)
        .set({ status: 'failed', conclusion: 'failure', completedAt: now })
        .where(
          and(
            inArray(workflowJobs.runnerId, offlineRunnerIds),
            or(eq(workflowJobs.status, 'assigned'), eq(workflowJobs.status, 'in_progress'))
          )
        )
        .returning({ id: workflowJobs.id, runnerId: workflowJobs.runnerId });

      if (stalledJobs.length > 0) {
        console.log(`[RunnerHealth] Failed ${stalledJobs.length} stalled job(s) from offline runners`);

        await db
          .update(runners)
          .set({ currentJobId: null, updatedAt: now })
          .where(inArray(runners.id, offlineRunnerIds));
      }
    }

    // Also fail jobs stuck in_progress for too long regardless of runner
    await db
      .update(workflowJobs)
      .set({ status: 'failed', conclusion: 'failure', completedAt: now })
      .where(
        and(
          or(eq(workflowJobs.status, 'assigned'), eq(workflowJobs.status, 'in_progress')),
          isNotNull(workflowJobs.startedAt),
          lt(workflowJobs.startedAt, staleJobCutoff)
        )
      );
  } catch (err) {
    console.error('[RunnerHealth] Error during health check:', err);
  }
}

export function startRunnerHealthWorker() {
  if (healthInterval) return;

  console.log('[RunnerHealth] Starting runner health worker');
  healthInterval = setInterval(checkRunnerHealth, 60_000); // every 60s

  // Run once on startup after a short delay
  setTimeout(checkRunnerHealth, 5_000);
}

export function stopRunnerHealthWorker() {
  if (healthInterval) {
    clearInterval(healthInterval);
    healthInterval = null;
  }
}
