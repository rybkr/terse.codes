import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getHeapStatistics } from 'node:v8';

const started = performance.now();

const importCompiled = (name) => import(pathToFileURL(resolve('dist/server', `${name}.js`)).href);
const [problemsModule, roomsModule, runnerModule, sandboxModule] = await Promise.all([
  importCompiled('problems'), importCompiled('rooms'), importCompiled('runner'), importCompiled('sandbox'),
]);
const { ProblemRepository } = problemsModule;
const { RoomStore } = roomsModule;
const { runCode, RunnerBusyError, shutdownRunner } = runnerModule;
const { verifyRunnerIsolation } = sandboxModule;

const largestId = 'color-the-triangle-red';
const uncoveredId = 'find-maximal-uncovered-ranges';
const summaryId = 'summary-ranges';
const submissions = [
  {
    id: largestId,
    code: `class Solution:
    def colorRed(self, n):
        result = [[1, 1]]
        for row in range(2, n + 1):
            phase = (n - row) % 4
            columns = range(1, 2 * row, 2) if phase == 0 else [2] if phase == 1 else range(3, 2 * row, 2) if phase == 2 else [1]
            result.extend([row, column] for column in columns)
        return result
`,
  },
  {
    id: uncoveredId,
    code: `class Solution:
    def findMaximalUncoveredRanges(self, n, ranges):
        result = []
        cursor = 0
        for left, right in sorted(ranges):
            if left > cursor:
                result.append([cursor, left - 1])
            cursor = max(cursor, right + 1)
        if cursor < n:
            result.append([cursor, n - 1])
        return result
`,
  },
  {
    id: summaryId,
    code: `class Solution:
    def summaryRanges(self, nums):
        result = []
        if not nums:
            return result
        start = previous = nums[0]
        for value in nums[1:]:
            if value != previous + 1:
                result.append(str(start) if start == previous else f"{start}->{previous}")
                start = value
            previous = value
        result.append(str(start) if start == previous else f"{start}->{previous}")
        return result
`,
  },
];

function readCgroupMetric(name) {
  try {
    const value = readFileSync(`/sys/fs/cgroup/memory.${name}`, 'utf8').trim();
    return /^\d+$/.test(value) ? Number(value) : undefined;
  } catch {
    return undefined;
  }
}

function memoryReport() {
  return {
    heapUsed: process.memoryUsage().heapUsed,
    rss: process.memoryUsage().rss,
    maxRssKiB: process.resourceUsage().maxRSS,
    cgroupCurrent: readCgroupMetric('current'),
    cgroupPeak: readCgroupMetric('peak'),
  };
}

const repository = new ProblemRepository();
let store;
let rooms = [];
let report;
let failure;

try {
  await verifyRunnerIsolation();
  const problemIds = repository.list().map(({ id }) => id);
  const distinctIds = [];
  const seenIds = new Set([largestId, uncoveredId, summaryId]);
  for (let index = 0; distinctIds.length < 92; index += 1) {
    const id = problemIds[(index * 97 + 31) % problemIds.length];
    if (id && !seenIds.has(id)) {
      seenIds.add(id);
      distinctIds.push(id);
    }
  }

  let pickCount = 0;
  const finalIds = [largestId, uncoveredId, ...Array(6).fill(summaryId)];
  store = new RoomStore(() => {
    if (pickCount < 400) {
      pickCount += 1;
      return repository.get(largestId);
    }
    if (pickCount < 492) {
      const id = distinctIds[pickCount - 400];
      pickCount += 1;
      if (!id) throw new Error('Missing seeded problem.');
      return repository.get(id);
    }
    const id = finalIds[pickCount - 492];
    pickCount += 1;
    if (!id) throw new Error('Missing judge problem.');
    return repository.get(id);
  }, runCode, () => 0);

  for (let index = 0; index < 500; index += 1) {
    const userId = `runtime-user-${index}`;
    const room = store.create({ name: userId, timeLimit: 600, difficulty: null, rounds: 1 }, userId);
    store.start(room.roomId, userId);
    const snapshot = store.snapshot(room.roomId, userId);
    rooms.push({ ...room, userId, problemId: snapshot.problem?.id, testsTotal: snapshot.rankings[0]?.testsTotal });
  }

  const activeRooms = rooms.slice(-8);
  const active = activeRooms.map((room, index) => {
    const submission = submissions.find(({ id }) => id === room.problemId);
    if (!submission) throw new Error('Missing inline solution for selected stress problem.');
    return store.submit(room.roomId, room.userId, submission.code).then((result) => ({
      problemId: room.problemId,
      passed: result.passed,
      total: result.total,
      solved: result.solved,
      error: result.error,
      index,
    }));
  });

  let ninthJobRejectedBusy = false;
  try {
    await runCode(submissions[0].code, repository.get(largestId));
  } catch (error) {
    ninthJobRejectedBusy = error instanceof RunnerBusyError;
  }
  let batchTimer;
  const timeout = new Promise((_, reject) => {
    batchTimer = setTimeout(() => reject(new Error('Runtime validation exceeded 180 seconds.')), 180_000);
  });
  let outcomes;
  try {
    outcomes = await Promise.race([Promise.all(active), timeout]);
  } finally {
    clearTimeout(batchTimer);
  }

  if (!outcomes.every((result) => result.solved && result.passed === result.total)) {
    throw Object.assign(new Error('At least one full-suite room submission failed.'), { outcomes });
  }
  report = {
    status: 'passed',
    runtime: { node: process.version, platform: process.platform, arch: process.arch, heapLimit: getHeapStatistics().heap_size_limit },
    elapsedMs: Math.round(performance.now() - started),
    roomCount: rooms.length,
    distinctSeededProblems: distinctIds.length,
    finalProblemIds: activeRooms.map(({ problemId }) => problemId),
    expectedTestCounts: activeRooms.map(({ testsTotal }) => testsTotal),
    outcomes,
    ninthJobRejectedBusy,
    memory: memoryReport(),
  };
  if (!ninthJobRejectedBusy) throw new Error('The ninth queued job was not rejected as busy.');
} catch (error) {
  failure = error;
} finally {
  if (store) {
    for (const room of rooms) {
      try {
        store.leave(room.roomId, room.userId);
      } catch {
        // Expired rooms may already have been removed.
      }
    }
  }
  await shutdownRunner(0);
}

if (failure) {
  const outcomes = typeof failure === 'object' && failure !== null && 'outcomes' in failure ? failure.outcomes : undefined;
  console.error(JSON.stringify({ status: 'failed', error: failure instanceof Error ? failure.message : 'Runtime validation failed.', outcomes, memory: memoryReport() }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(report, null, 2));
}
