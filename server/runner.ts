import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JsonValue, Problem } from './problems.js';
import { decodeJsonValue, isJsonValue, jsonValueBytes, jsonValueSize } from './problem-values.js';
import { RunnerQueue } from './runner-queue.js';
import { buildRunnerCommand, RunnerIsolationError, runnerIsolationStatus } from './sandbox.js';

export interface SubmissionResult {
  passed: number;
  total: number;
  solved: boolean;
  charCount: number;
  error: string | null;
  timeMs: number;
  firstFailure: { input: string; expected: string; actual: string } | null;
  stdout: string;
  stderr: string;
}

const MIB = 1024 * 1024;
const queue = new RunnerQueue();
export { RunnerQueueBusyError as RunnerBusyError } from './runner-queue.js';
export const shutdownRunner = (graceMs: number) => queue.shutdown(graceMs);

export { runnerIsolationStatus };

function boundedText(value: string, limit: number): string {
  // Copy the prefix so a retained preview cannot keep a large V8 backing string alive.
  return Buffer.from(value.slice(0, limit)).toString('utf8');
}

function compare(actual: JsonValue, expected: JsonValue, comparison: Problem['comparison']): boolean {
  if (typeof actual === 'number' && Number.isSafeInteger(actual) && expected !== null
      && typeof expected === 'object' && !Array.isArray(expected) && typeof expected.$bigint === 'string') {
    return BigInt(actual) === BigInt(expected.$bigint);
  }
  if (typeof expected === 'number' && Number.isSafeInteger(expected) && actual !== null
      && typeof actual === 'object' && !Array.isArray(actual) && typeof actual.$bigint === 'string') {
    return BigInt(expected) === BigInt(actual.$bigint);
  }
  if (typeof actual === 'number' && typeof expected === 'number') {
    return Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= Math.max(
      comparison?.absoluteTolerance ?? 0,
      (comparison?.relativeTolerance ?? 0) * Math.max(Math.abs(actual), Math.abs(expected)),
    );
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length !== expected.length) return false;
    return expected.every((value, index) => compare(actual[index]!, value, comparison));
  }
  if (actual !== null && expected !== null && typeof actual === 'object' && typeof expected === 'object'
      && !Array.isArray(actual) && !Array.isArray(expected)) {
    const keys = Object.keys(expected);
    return Object.keys(actual).length === keys.length && keys.every((key) =>
      Object.hasOwn(actual, key) && compare(actual[key]!, expected[key]!, comparison));
  }
  return actual === expected;
}

async function execute(code: string, problem: Problem, signal: AbortSignal): Promise<SubmissionResult> {
  const started = performance.now();
  const result: SubmissionResult = {
    passed: 0, total: problem.tests.length, solved: false,
    charCount: Array.from(code).length, error: null, timeMs: 0,
    firstFailure: null, stdout: '', stderr: '',
  };
  const worker = fileURLToPath(new URL('./runner-worker.py', import.meta.url));
  let expectedBytes = 0;
  let largestExpected = 0;
  let largestInput = 0;
  let tests: Problem['tests'];
  try {
    for (const test of problem.tests) {
      const bytes = jsonValueBytes(test.expected);
      expectedBytes += bytes;
      largestExpected = Math.max(largestExpected, bytes);
      const inputSize = jsonValueBytes(test.input);
      largestInput = Math.max(largestInput, inputSize);
    }
    const ordered = problem.tests.map((test) => ({
      test, size: jsonValueSize(test.input.map(decodeJsonValue)),
    })).sort((left, right) => left.size - right.size);
    tests = ordered.map(({ test }) => test);
  } catch {
    return { ...result, error: 'Invalid compressed problem input or metadata.', timeMs: Math.round(performance.now() - started) };
  }
  const caseOutputLimit = Math.min(32 * MIB, Math.max(MIB, largestExpected * 4 + 32_000));
  const totalOutputLimit = Math.max(32 * MIB, expectedBytes * 4 + problem.tests.length * 12_000);
  const submissionTimeoutMs = Math.min(60_000, Math.max(8_000,
    problem.tests.length * 20, Math.ceil(expectedBytes / (3 * MIB)) * 1_000));
  const memoryLimitMb = Math.min(512, Math.max(128,
    Math.ceil((largestExpected * 24 + largestInput * 24) / MIB) + 64));
  const production = process.env.NODE_ENV === 'production';
  const python = production ? '/app/.venv/bin/python3'
    : process.env.PYTHON_BIN ?? (existsSync('.venv/bin/python3') ? resolvePath('.venv/bin/python3') : 'python3');
  let command;
  try {
    command = buildRunnerCommand({
      production,
      platform: process.platform,
      pythonPath: python,
      workerPath: worker,
    });
  } catch (error) {
    if (error instanceof RunnerIsolationError) {
      return { ...result, error: error.message, timeMs: Math.round(performance.now() - started) };
    }
    throw error;
  }
  return new Promise((resolve) => {
    const child = spawn(command.command, command.args, {
      cwd: tmpdir(),
      env: command.isolated ? { PATH: '/usr/bin:/bin', TMPDIR: '/tmp' } : { PATH: process.env.PATH ?? '' },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    let pending = '';
    let pendingBytes = 0;
    let scanFrom = 0;
    let received = 0;
    let outputBytes = 0;
    let stopped = false;
    let sent = 0;
    // Forged output records must not queue every decoded input into the pipe.
    let writing = false;
    let nextRequested = false;
    const sendInput = () => {
      if (stopped) return;
      if (writing) { nextRequested = true; return; }
      const test = tests[received];
      if (!test) { child.stdin.end(); return; }
      try {
        const input = JSON.stringify(test.input.map(decodeJsonValue)) + '\n';
        sent += 1;
        writing = true;
        child.stdin.write(input, (error) => {
          writing = false;
          if (!error && nextRequested) {
            nextRequested = false;
            sendInput();
          }
        });
      } catch { stop('Invalid compressed problem input.'); }
    };
    const stop = (message: string) => {
      if (stopped) return;
      stopped = true;
      result.error ??= message;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
    };
    const abort = () => stop('Submission cancelled because the server is shutting down.');
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => stop('Submission time limit exceeded.'), submissionTimeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stopped) return;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > totalOutputLimit) {
        stop('Output limit exceeded.');
        return;
      }
      pending += chunk;
      pendingBytes += Buffer.byteLength(chunk);
      if (pendingBytes > caseOutputLimit) { stop('Output limit exceeded.'); return; }
      let end: number;
      while ((end = pending.indexOf('\n', scanFrom)) !== -1) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        pendingBytes = Buffer.byteLength(pending);
        scanFrom = 0;
        try {
          const record = JSON.parse(line) as { error?: string; output?: string; stdout?: string; stderr?: string };
          const test = tests[received];
          if (!test || received >= sent) {
            stop('Invalid runner output.');
            return;
          }
          received += 1;
          result.stdout = boundedText(result.stdout + (record.stdout ?? ''), 5000);
          result.stderr = boundedText(result.stderr + (record.stderr ?? ''), 5000);
          let expected: JsonValue;
          try {
            expected = decodeJsonValue(test.expected);
          } catch {
            stop('Invalid compressed expected result.');
            return;
          }
          if (record.error) {
            result.error ??= boundedText(record.error, 500);
            result.firstFailure ??= {
              input: boundedText(JSON.stringify(test.input.map(decodeJsonValue)), 500),
              expected: boundedText(JSON.stringify(expected), 500),
              actual: boundedText(record.error, 500),
            };
          }
          else if (typeof record.output === 'string') {
            const output: unknown = JSON.parse(record.output);
            if (!isJsonValue(output)) {
              stop('Return a finite JSON value with canonical bigint tags.');
              return;
            }
            const actual = problem.adapter === 'prefix' && typeof expected === 'number' && Array.isArray(output) ? output[0]! : output;
            if (compare(actual, expected, problem.comparison)) result.passed += 1;
            else {
              result.error ??= 'Wrong answer.';
              result.firstFailure ??= {
                input: boundedText(JSON.stringify(test.input.map(decodeJsonValue)), 500),
                expected: boundedText(JSON.stringify(expected), 500),
                actual: boundedText(record.output, 500),
              };
            }
          } else stop('Invalid runner output.');
          sendInput();
        } catch {
          stop('Invalid runner output.');
        }
      }
      scanFrom = pending.length;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > totalOutputLimit) stop('Output limit exceeded.');
    });
    child.on('error', () => {
      result.error ??= 'Could not start the submission runner.';
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (exitCode !== 0 || received !== result.total) result.error ??= 'Submission exceeded its resource limits or crashed.';
      result.solved = result.passed === result.total && result.error === null;
      result.timeMs = Math.round(performance.now() - started);
      resolve(result);
    });
    child.stdin.on('error', () => { /* The child can exit before reading all input. */ });
    child.stdin.write(JSON.stringify({
      code, parameters: problem.parameters, entryPoint: problem.entryPoint,
      returnType: problem.returnType, adapter: problem.adapter,
      memoryLimitMb, cpuLimitSeconds: Math.ceil(submissionTimeoutMs / 1000), outputLimit: caseOutputLimit,
      strictResourceLimits: production,
    }) + '\n');
    sendInput();
  });
}

export function runCode(code: string, problem: Problem): Promise<SubmissionResult> {
  return queue.run((signal) => execute(code, problem, signal));
}
