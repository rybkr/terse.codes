import { createServer } from 'node:http';
import { ProblemRepository } from '../../server/problems.js';
import { RunnerShuttingDownError } from '../../server/runner-queue.js';
import { runCode, shutdownRunner } from '../../server/runner.js';
import { shutdownServer } from '../../server/shutdown.js';

const problem = new ProblemRepository().get('summary-ranges');
const acceptedCount = 8;
let accepted = 0;
let flushed = 0;
let shuttingDown = false;

const server = createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/submit') {
    response.writeHead(404);
    response.end();
    return;
  }

  void (async () => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    const submission = JSON.parse(body) as { code: string };
    accepted += 1;
    if (accepted === acceptedCount) process.send?.({ event: 'accepted', count: accepted });

    try {
      const result = await runCode(submission.code, problem);
      const cancelled = result.error?.startsWith('Submission cancelled because the server is shutting down.') ?? false;
      const outcome = result.solved ? 'solved' : cancelled ? 'cancelled' : 'failed';
      response.writeHead(outcome === 'solved' ? 200 : outcome === 'cancelled' ? 503 : 422, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ outcome, passed: result.passed, total: result.total }));
    } catch (error) {
      const outcome = error instanceof RunnerShuttingDownError ? 'cancelled' : 'failed';
      response.writeHead(outcome === 'cancelled' ? 503 : 500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ outcome }));
    }
  })().catch(() => {
    if (!response.headersSent) response.writeHead(500);
    response.end(JSON.stringify({ outcome: 'failed' }));
  });
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Expected a TCP server address.');
process.send?.({ event: 'ready', port: address.port });

const configuredGraceMs = process.argv[2] ? Number(process.argv[2]) : undefined;
const shutdownOptions = configuredGraceMs === undefined ? {} : { runnerGraceMs: configuredGraceMs };
const stop = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  void shutdownServer(server, shutdownRunner, async () => { flushed += 1; }, shutdownOptions).then(() => {
    process.send?.({ event: 'stopped', flushCount: flushed });
  });
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
