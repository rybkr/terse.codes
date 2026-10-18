const MAX_ACCEPTED = 8;
const DEFAULT_QUEUE_TIMEOUT_MS = 8 * 60_000;

export class RunnerQueueBusyError extends Error {
  constructor(message = 'The submission runner is busy. Try again shortly.') {
    super(message);
    this.name = 'RunnerQueueBusyError';
  }
}

export class RunnerQueueTimeoutError extends RunnerQueueBusyError {
  constructor() {
    super('The submission waited too long for the runner. Try again shortly.');
    this.name = 'RunnerQueueTimeoutError';
  }
}

export class RunnerShuttingDownError extends Error {
  constructor() {
    super('The submission runner is shutting down.');
    this.name = 'RunnerShuttingDownError';
  }
}

interface QueueJob {
  execute: (signal: AbortSignal) => Promise<void>;
  reject: (error: Error) => void;
  controller: AbortController;
  state: 'queued' | 'active' | 'settled';
  callerSettled: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export interface RunnerQueueOptions {
  queueTimeoutMs?: number;
}

export class RunnerQueue {
  private readonly queueTimeoutMs: number;
  private readonly waiting: QueueJob[] = [];
  private readonly active = new Set<QueueJob>();
  private readonly drainedWaiters: (() => void)[] = [];
  private closing = false;
  private shutdownPromise: Promise<void> | undefined;

  constructor(options: RunnerQueueOptions = {}) {
    this.queueTimeoutMs = options.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS;
    if (!Number.isFinite(this.queueTimeoutMs) || this.queueTimeoutMs <= 0) {
      throw new RangeError('queueTimeoutMs must be a positive finite number.');
    }
  }

  run<T>(execute: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new RunnerShuttingDownError());
    if (this.active.size + this.waiting.length >= MAX_ACCEPTED) {
      return Promise.reject(new RunnerQueueBusyError());
    }

    return new Promise<T>((resolve, reject) => {
      const job: QueueJob = {
        execute: async (signal) => {
          try {
            resolve(await execute(signal));
            job.callerSettled = true;
          } catch (error) {
            reject(error);
            job.callerSettled = true;
          }
        },
        reject: (error) => {
          if (job.callerSettled) return;
          job.callerSettled = true;
          reject(error);
        },
        controller: new AbortController(),
        state: 'queued',
        callerSettled: false,
        timer: undefined,
      };

      if (this.active.size === 0) {
        this.start(job);
      } else {
        job.timer = setTimeout(() => this.expire(job), this.queueTimeoutMs);
        this.waiting.push(job);
      }
    });
  }

  shutdown(graceMs: number): Promise<void> {
    if (!Number.isFinite(graceMs) || graceMs < 0) {
      return Promise.reject(new RangeError('graceMs must be a nonnegative finite number.'));
    }
    if (this.shutdownPromise) return this.shutdownPromise;

    this.closing = true;
    for (const job of this.waiting.splice(0)) {
      this.clearTimer(job);
      job.state = 'settled';
      job.reject(new RunnerShuttingDownError());
    }
    this.shutdownPromise = this.finishShutdown(graceMs);
    return this.shutdownPromise;
  }

  private async finishShutdown(graceMs: number): Promise<void> {
    if (this.active.size === 0) return;
    await this.waitForDrain(graceMs);
    for (const job of this.active) {
      job.controller.abort();
      job.reject(new RunnerShuttingDownError());
    }
    await this.waitForDrain(1000);
  }

  private start(job: QueueJob): void {
    this.clearTimer(job);
    job.state = 'active';
    this.active.add(job);
    void Promise.resolve()
      .then(() => job.execute(job.controller.signal))
      .catch((error: unknown) => {
        if (error instanceof Error) job.reject(error);
        else job.reject(new Error('The submission runner failed.'));
      })
      .finally(() => this.complete(job));
  }

  private complete(job: QueueJob): void {
    if (job.state !== 'active') return;
    job.state = 'settled';
    this.active.delete(job);
    if (this.active.size === 0) {
      for (const notify of this.drainedWaiters.splice(0)) notify();
    }
    if (!this.closing) {
      const next = this.waiting.shift();
      if (next) this.start(next);
    }
  }

  private expire(job: QueueJob): void {
    if (job.state !== 'queued') return;
    const index = this.waiting.indexOf(job);
    if (index === -1) return;
    this.waiting.splice(index, 1);
    job.state = 'settled';
    job.reject(new RunnerQueueTimeoutError());
  }

  private clearTimer(job: QueueJob): void {
    if (!job.timer) return;
    clearTimeout(job.timer);
    job.timer = undefined;
  }

  private waitForDrain(graceMs: number): Promise<void> {
    if (this.active.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        const index = this.drainedWaiters.indexOf(finish);
        if (index !== -1) this.drainedWaiters.splice(index, 1);
        resolve();
      };
      const timer = setTimeout(finish, graceMs);
      this.drainedWaiters.push(finish);
    });
  }
}
