import type { SolverId } from '../shared/system.js';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { CoverageProvider } from './integrations/apple.js';
import { Repository } from './repository.js';
import { AppError } from './errors.js';
import { BatchRepository } from './batches.js';
import { integrationsConfigured, solverConfigured } from './config.js';

export function startWorker(repo: Repository, provider: CoverageProvider, demo = false) {
  const batches = new BatchRepository(repo);
  const id = randomUUID();
  const stop = new AbortController();
  const active = new Set<Promise<void>>();
  const runningControllers = new Set<AbortController>();
  let lastHousekeeping = 0;
  let healthy = true;

  async function processJob(job: {
    id: string;
    serial: string;
    token: string;
    proxy: string;
    solver: SolverId;
    priorRateLimits?: number;
  }) {
    const controller = new AbortController();
    runningControllers.add(controller);
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(repo.config.CHECK_TIMEOUT_MS),
    ]);
    let renewing = false;
    const heartbeat = setInterval(async () => {
      if (renewing) return;
      renewing = true;
      try {
        if (!(await repo.renew(job.id, job.token))) controller.abort();
      } catch {
        controller.abort();
      } finally {
        renewing = false;
      }
    }, 15000);
    try {
      await repo.diagnostic(
        job.id,
        job.token,
        'started',
        `Rozpoczęto sprawdzenie; proxy: ${job.proxy}; solver: ${job.solver}.`,
      );
      const result = await provider.check(
        job.serial,
        signal,
        (stage) => repo.stage(job.id, job.token, stage),
        {
          proxy: job.proxy,
          priorRateLimits: job.priorRateLimits,
          solver: job.solver,
          beginSession: () => repo.beginSession(job.id, job.token, job.proxy),
          endSession: (sid, m) => repo.endSession(job.id, job.token, sid, m),
          log: (step, message) => repo.diagnostic(job.id, job.token, step, message),
          beginCaptcha: () => repo.beginCaptcha(job.id, job.token, job.solver),
          endCaptcha: (measurement, ms, outcome) =>
            repo.endCaptcha(job.id, job.token, measurement, ms, outcome),
        },
      );
      signal.throwIfAborted();
      await repo.diagnostic(job.id, job.token, 'completed', 'Sprawdzenie zakończone poprawnie.');
      await repo.finish(job.id, job.token, result, null);
      console.info(JSON.stringify({ event: 'check_finished', id: job.id, status: 'completed' }));
    } catch (e) {
      // On shutdown leave the lease intact; recovery will requeue with a bounded attempt count.
      if (!stop.signal.aborted && !controller.signal.aborted) {
        const code = signal.aborted
          ? 'CHECK_TIMEOUT'
          : e instanceof AppError
            ? e.code
            : 'INTERNAL_ERROR';
        await repo.diagnostic(
          job.id,
          job.token,
          'failed',
          `${code}: ${new AppError(code).message}`,
        );
        await repo.finish(job.id, job.token, null, code);
        console.info(
          JSON.stringify({ event: 'check_finished', id: job.id, status: 'failed', code }),
        );
      }
    } finally {
      clearInterval(heartbeat);
      runningControllers.delete(controller);
    }
  }
  const loop = (async () => {
    while (!stop.signal.aborted) {
      try {
        await repo.workerHeartbeat(id);
        await repo.recover();
        if (Date.now() - lastHousekeeping > 600000) {
          await repo.cleanupEphemeral();
          lastHousekeeping = Date.now();
        }
        if (active.size < (await repo.concurrency())) {
          const configured =
            demo ||
            (integrationsConfigured(repo.config) &&
              solverConfigured(repo.config, (await repo.settings()).solverId));
          if (configured) await batches.dispatch();
          const job = configured ? await repo.claim() : null;
          if (job) {
            const task = processJob(job).catch(() => {
              console.error('Worker could not persist a result; lease recovery will handle it.');
            });
            active.add(task);
            void task.finally(() => active.delete(task));
          }
        }
        healthy = true;
      } catch {
        healthy = false;
        console.error('Worker database operation failed.');
      }
      try {
        await delay(2000, undefined, { signal: stop.signal });
      } catch {
        /* shutdown */
      }
    }
  })();
  return {
    healthy: () => healthy,
    async close() {
      stop.abort();
      for (const controller of runningControllers) controller.abort();
      await loop;
      await Promise.allSettled([...active]);
      await repo.db.query('DELETE FROM worker_heartbeats WHERE id=$1', [id]);
    },
  };
}
