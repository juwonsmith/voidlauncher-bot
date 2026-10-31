// Runs queued launch jobs without polling the database. The worker wakes when a job is queued, on startup,
// and when the next retry or stale-job recovery comes due, so a scale-to-zero database can sleep between launches.

const MAX_WAKE_DELAY_MS = 60 * 60 * 1000;
const ERROR_RETRY_DELAY_MS = 15_000;

export interface LaunchJobWorkerDeps<Job> {
  claimNext(): Promise<Job | undefined>;
  execute(job: Job): Promise<void>;
  nextRunAt(): Promise<Date | undefined>;
  onError(error: unknown): void;
}

export interface LaunchJobWorker {
  run(): Promise<void>;
  isBusy(): boolean;
  nextWakeAt(): Date | undefined;
}

export function createLaunchJobWorker<Job>(deps: LaunchJobWorkerDeps<Job>): LaunchJobWorker {
  let busy = false;
  let rerun = false;
  let wakeTimer: NodeJS.Timeout | undefined;
  let wakeAt: number | undefined;

  function scheduleWake(delayMs: number): void {
    const delay = Math.min(Math.max(0, delayMs), MAX_WAKE_DELAY_MS);
    const at = Date.now() + delay;
    if (wakeAt !== undefined && wakeAt <= at) return;

    clearTimeout(wakeTimer);
    wakeAt = at;
    wakeTimer = setTimeout(() => {
      wakeTimer = undefined;
      wakeAt = undefined;
      void run();
    }, delay);
    wakeTimer.unref();
  }

  async function run(): Promise<void> {
    if (busy) {
      // A job was queued mid-run; check again once this run finishes so it is not missed.
      rerun = true;
      return;
    }

    busy = true;
    rerun = false;
    try {
      while (true) {
        const job = await deps.claimNext();
        if (!job) break;
        await deps.execute(job);
      }
      const nextRunAt = await deps.nextRunAt();
      if (nextRunAt) scheduleWake(nextRunAt.getTime() - Date.now());
    } catch (error) {
      deps.onError(error);
      scheduleWake(ERROR_RETRY_DELAY_MS);
    } finally {
      busy = false;
    }

    if (rerun) await run();
  }

  return {
    run,
    isBusy: () => busy,
    nextWakeAt: () => (wakeAt === undefined ? undefined : new Date(wakeAt))
  };
}
