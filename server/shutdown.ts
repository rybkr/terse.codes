import type { Server } from 'node:http';

const DEFAULT_RUNNER_GRACE_MS = 20_000;
const DEFAULT_PERSISTENCE_GRACE_MS = 3_000;
const shutdowns = new WeakMap<Server, Promise<void>>();

export interface ShutdownOptions {
  runnerGraceMs?: number;
  persistenceGraceMs?: number;
}

export function shutdownServer(
  server: Server,
  stopRunner: (graceMs: number) => Promise<void>,
  flush: () => Promise<void>,
  options: ShutdownOptions = {},
): Promise<void> {
  const existing = shutdowns.get(server);
  if (existing) return existing;

  const runnerGraceMs = options.runnerGraceMs ?? DEFAULT_RUNNER_GRACE_MS;
  const persistenceGraceMs = options.persistenceGraceMs ?? DEFAULT_PERSISTENCE_GRACE_MS;
  if (!Number.isFinite(runnerGraceMs) || runnerGraceMs < 0) {
    return Promise.reject(new RangeError('runnerGraceMs must be a nonnegative finite number.'));
  }
  if (!Number.isFinite(persistenceGraceMs) || persistenceGraceMs < 0) {
    return Promise.reject(new RangeError('persistenceGraceMs must be a nonnegative finite number.'));
  }

  const shutdown = finishShutdown(server, stopRunner, flush, runnerGraceMs, persistenceGraceMs);
  shutdowns.set(server, shutdown);
  return shutdown;
}

async function finishShutdown(
  server: Server,
  stopRunner: (graceMs: number) => Promise<void>,
  flush: () => Promise<void>,
  runnerGraceMs: number,
  persistenceGraceMs: number,
): Promise<void> {
  try {
    server.close((error) => {
      if (error) console.error('HTTP server did not close cleanly.');
    });
  } catch {
    console.error('HTTP server did not close cleanly.');
  }

  try {
    await stopRunner(runnerGraceMs);
  } catch {
    console.error('Submission runner did not stop cleanly.');
  }

  try {
    await flushWithin(flush, persistenceGraceMs);
  } finally {
    server.closeAllConnections();
  }
}

async function flushWithin(flush: () => Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    const flushed = await Promise.race([
      flush().then(() => true, () => false),
      timedOut,
    ]);
    if (!flushed) console.error('Queued stats could not be saved before shutdown.');
  } finally {
    if (timer) clearTimeout(timer);
  }
}
