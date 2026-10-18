import { describe, expect, it } from 'vitest';
import {
  RunnerQueue,
  RunnerQueueBusyError,
  RunnerQueueTimeoutError,
  RunnerShuttingDownError,
} from '../server/runner-queue.js';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

describe('RunnerQueue', () => {
  it('runs one job at a time and rejects work beyond the eight accepted slots', async () => {
    const queue = new RunnerQueue();
    const firstGate = deferred<number>();
    const order: number[] = [];
    const first = queue.run(async () => {
      order.push(1);
      return firstGate.promise;
    });
    const rest = Array.from({ length: 7 }, (_, index) => queue.run(async () => {
      order.push(index + 2);
      return index + 2;
    }));

    await expect(queue.run(async () => 9)).rejects.toBeInstanceOf(RunnerQueueBusyError);
    firstGate.resolve(1);
    await expect(Promise.all([first, ...rest])).resolves.toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(order).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    await queue.shutdown(0);
  });

  it('closes admission, rejects queued jobs, and aborts active work after the grace period', async () => {
    const queue = new RunnerQueue();
    let aborted = false;
    const active = queue.run((signal) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('aborted'));
      }, { once: true });
    }));
    const queued = queue.run(async () => 'never runs');

    const shutdown = queue.shutdown(10);
    await expect(queued).rejects.toBeInstanceOf(RunnerShuttingDownError);
    await expect(queue.run(async () => 'rejected')).rejects.toBeInstanceOf(RunnerShuttingDownError);
    expect(aborted).toBe(false);
    await shutdown;
    expect(aborted).toBe(true);
    await expect(active).rejects.toBeInstanceOf(RunnerShuttingDownError);
  });

  it('lets active work finish during shutdown grace', async () => {
    const queue = new RunnerQueue();
    const gate = deferred<string>();
    let aborted = false;
    const active = queue.run((signal) => {
      signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      return gate.promise;
    });
    const shutdown = queue.shutdown(1000);
    gate.resolve('finished');

    await expect(active).resolves.toBe('finished');
    await shutdown;
    expect(aborted).toBe(false);
  });

  it('waits for bounded active cleanup after aborting a job', async () => {
    const queue = new RunnerQueue();
    const cleanup = deferred<void>();
    let aborted = false;
    let shutdownFinished = false;
    const active = queue.run((signal) => new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        void cleanup.promise.then(resolve);
      }, { once: true });
    }));
    const shutdown = queue.shutdown(0).then(() => { shutdownFinished = true; });

    await expect(active).rejects.toBeInstanceOf(RunnerShuttingDownError);
    expect(aborted).toBe(true);
    expect(shutdownFinished).toBe(false);
    cleanup.resolve();
    await shutdown;
    expect(shutdownFinished).toBe(true);
  });

  it('removes queued work when its wait limit expires', async () => {
    const queue = new RunnerQueue({ queueTimeoutMs: 10 });
    const active = queue.run((signal) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const queued = queue.run(async () => 'never runs');

    await expect(queued).rejects.toBeInstanceOf(RunnerQueueTimeoutError);
    await queue.shutdown(0);
    await expect(active).rejects.toBeInstanceOf(RunnerShuttingDownError);
  });
});
