import { fork, type ChildProcess } from 'node:child_process';
import { request, type IncomingMessage } from 'node:http';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type FixtureMessage =
  | { event: 'ready'; port: number }
  | { event: 'accepted'; count: number }
  | { event: 'stopped'; flushCount: number };

interface SubmissionResponse {
  statusCode: number;
  outcome: 'solved' | 'cancelled' | 'failed';
  passed?: number;
  total?: number;
}

function isFixtureMessage(value: unknown): value is FixtureMessage {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (record.event === 'ready' && typeof record.port === 'number')
    || (record.event === 'accepted' && typeof record.count === 'number')
    || (record.event === 'stopped' && typeof record.flushCount === 'number');
}

function waitForMessage(child: ChildProcess, event: FixtureMessage['event'], timeoutMs: number): Promise<FixtureMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for child event ${event}.`)), timeoutMs);
    const onMessage = (value: unknown) => {
      if (isFixtureMessage(value) && value.event === event) finish(undefined, value);
    };
    const onExit = () => finish(new Error(`Child exited before event ${event}.`));
    const onError = (error: Error) => finish(error);
    const finish = (error?: Error, value?: FixtureMessage) => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error) reject(error);
      else if (value) resolve(value);
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function postSubmission(port: number, code: string): Promise<SubmissionResponse> {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      host: '127.0.0.1', port, path: '/submit', method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, (incoming: IncomingMessage) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => {
        try {
          const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (body === null || typeof body !== 'object' || !('outcome' in body)) {
            throw new Error('Invalid submission response from child fixture.');
          }
          const record = body as Record<string, unknown>;
          const outcome = record.outcome;
          if (outcome !== 'solved' && outcome !== 'cancelled' && outcome !== 'failed') {
            throw new Error('Invalid submission outcome from child fixture.');
          }
          resolve({
            statusCode: incoming.statusCode ?? 0,
            outcome,
            ...(typeof record.passed === 'number' ? { passed: record.passed } : {}),
            ...(typeof record.total === 'number' ? { total: record.total } : {}),
          });
        } catch (error) {
          reject(error);
        }
      });
      incoming.on('error', reject);
    });
    outgoing.on('error', reject);
    outgoing.end(JSON.stringify({ code }));
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      if (code === 0 && signal === null) resolve();
      else reject(new Error(`Shutdown fixture exited with code ${code} and signal ${signal}.`));
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Shutdown fixture did not exit within its bound.'));
    }, timeoutMs);
    if (child.exitCode !== null || child.signalCode !== null) finish(child.exitCode, child.signalCode);
    else child.once('exit', finish);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runShutdownScenario(graceMs?: number): Promise<SubmissionResponse[]> {
  const fixture = fileURLToPath(new URL('./fixtures/shutdown-runner.ts', import.meta.url));
  const args = graceMs === undefined ? [] : [String(graceMs)];
  const child = fork(fixture, args, {
    cwd: process.cwd(),
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  try {
    const ready = await waitForMessage(child, 'ready', 10_000);
    if (ready.event !== 'ready') throw new Error('Child fixture did not provide a port.');
    const code = `import time
class Solution:
    def summaryRanges(self, nums):
        time.sleep(0.01)
        if not nums:
            return []
        ranges = []
        start = previous = nums[0]
        for value in nums[1:]:
            if value != previous + 1:
                ranges.append(f"{start}->{previous}" if start != previous else str(start))
                start = value
            previous = value
        ranges.append(f"{start}->{previous}" if start != previous else str(start))
        return ranges
`;
    const submissions = Array.from({ length: 8 }, () => postSubmission(ready.port, code));
    const accepted = await waitForMessage(child, 'accepted', 10_000);
    expect(accepted).toMatchObject({ event: 'accepted', count: 8 });
    await delay(250);
    child.kill('SIGTERM');

    const stopped = await waitForMessage(child, 'stopped', 12_000);
    expect(stopped).toMatchObject({ event: 'stopped', flushCount: 1 });
    await waitForExit(child, 2_000);
    return await Promise.all(submissions);
  } catch (error) {
    if (child.exitCode === null) child.kill('SIGKILL');
    throw error;
  }
}

describe('runner shutdown in a child process', () => {
  it('finishes the active real-corpus submission and cancels its seven queued peers on SIGTERM', async () => {
    const responses = await runShutdownScenario();
    expect(responses.filter(({ outcome }) => outcome === 'solved')).toHaveLength(1);
    expect(responses.filter(({ outcome }) => outcome === 'cancelled')).toHaveLength(7);
    expect(responses.find(({ outcome }) => outcome === 'solved')).toMatchObject({ statusCode: 200, passed: 600, total: 600 });
  }, 45_000);

  it('settles all real-corpus submissions when SIGTERM forces a short active-job abort', async () => {
    const responses = await runShutdownScenario(50);
    expect(responses).toHaveLength(8);
    expect(responses.filter(({ outcome }) => outcome === 'cancelled')).toHaveLength(8);
    expect(responses.every(({ statusCode }) => statusCode === 503)).toBe(true);
  }, 20_000);
});
