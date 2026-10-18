import { createServer, get, type IncomingMessage, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shutdownServer } from '../server/shutdown.js';

const servers: Server[] = [];

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP server address.');
  return address.port;
}

async function openResponse(port: number): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = get({ host: '127.0.0.1', port }, resolve);
    request.on('error', reject);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) server.closeAllConnections();
});

describe('shutdownServer', () => {
  it('stops admission immediately and closes existing connections after runner and persistence work', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200);
      response.flushHeaders();
    });
    const port = await listen(server);
    const response = await openResponse(port);
    const connectionClosed = new Promise<void>((resolve) => response.once('close', resolve));
    const runnerGate = deferred<void>();
    const persistenceGate = deferred<void>();
    const flushStarted = deferred<void>();
    const stopRunner = vi.fn(() => runnerGate.promise);
    const flush = vi.fn(() => {
      flushStarted.resolve();
      return persistenceGate.promise;
    });

    const shutdown = shutdownServer(server, stopRunner, flush, {
      runnerGraceMs: 40,
      persistenceGraceMs: 40,
    });
    expect(shutdownServer(server, stopRunner, flush)).toBe(shutdown);
    expect(stopRunner).toHaveBeenCalledWith(40);
    expect(flush).not.toHaveBeenCalled();
    await expect(openResponse(port)).rejects.toThrow();

    runnerGate.resolve();
    await flushStarted.promise;
    expect(response.destroyed).toBe(false);
    persistenceGate.resolve();
    await shutdown;
    await connectionClosed;
    expect(flush).toHaveBeenCalledOnce();
  });

  it('logs failed runner shutdown and bounded persistence timeout, then closes connections', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200);
      response.flushHeaders();
    });
    const port = await listen(server);
    const response = await openResponse(port);
    const connectionClosed = new Promise<void>((resolve) => response.once('close', resolve));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await shutdownServer(
      server,
      async () => { throw new Error('runner failed'); },
      () => new Promise<void>(() => undefined),
      { runnerGraceMs: 0, persistenceGraceMs: 15 },
    );
    await connectionClosed;

    expect(error).toHaveBeenCalledWith('Submission runner did not stop cleanly.');
    expect(error).toHaveBeenCalledWith('Queued stats could not be saved before shutdown.');
  });
});
