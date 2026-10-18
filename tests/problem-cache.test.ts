import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { ProblemRepository } from '../server/problems.js';

describe('problem repository memory behavior', () => {
  it('shares one immutable pick and exposes its hidden suite lazily', () => {
    const repository = new ProblemRepository();
    const first = repository.get('color-the-triangle-red');

    expect(first.testCount).toBe(500);
    expect(repository.get('color-the-triangle-red')).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);

    const tests = first.tests;
    expect(tests).toHaveLength(500);
    expect(Object.isFrozen(tests)).toBe(true);
    expect(repository.load(first.id).tests).toBe(tests);
  });

  it('evicts large parsed suites before parsing a replacement', () => {
    const repository = new ProblemRepository();
    const largest = repository.load('color-the-triangle-red');

    expect(repository.load('color-the-triangle-red')).toBe(largest);
    repository.load('combinations');

    expect(repository.load('color-the-triangle-red')).not.toBe(largest);
  });

  it('handles hundreds of room picks under a bounded V8 heap on real corpus data', () => {
    const script = `
      import { ProblemRepository } from './server/problems.ts';
      import { RoomStore } from './server/rooms.ts';
      const repository = new ProblemRepository();
      const largest = 'color-the-triangle-red';
      const problems = repository.list();
      const selected = new Set();
      let roomIndex = 0;
      const store = new RoomStore(() => {
        if (roomIndex < 400) {
          roomIndex += 1;
          return repository.get(largest);
        }
        const index = ((roomIndex - 400) * 97 + 31) % problems.length;
        const id = problems[index]?.id;
        roomIndex += 1;
        if (!id) throw new Error('Missing corpus problem.');
        selected.add(id);
        return repository.get(id);
      }, undefined, () => 0);
      const snapshots = [];
      for (let room = 0; room < 500; room += 1) {
        const userId = 'user-' + room;
        const created = store.create({ name: userId, timeLimit: 30, difficulty: null, rounds: 1 }, userId);
        store.start(created.roomId, userId);
        snapshots.push(store.snapshot(created.roomId, userId));
      }
      const tests = repository.get(largest).tests;
      console.log(JSON.stringify({ roomCount: snapshots.length, selected: selected.size, largestTestsTotal: snapshots[0]?.rankings[0]?.testsTotal, testCount: tests.length, heapUsed: process.memoryUsage().heapUsed, rss: process.memoryUsage().rss }));
    `;
    const output = execFileSync(process.execPath, [
      '--max-old-space-size=256', '--max-semi-space-size=8', '--import', 'tsx', '--input-type=module', '-e', script,
    ], { encoding: 'utf8', timeout: 60_000 });
    const result = JSON.parse(output.trim()) as { roomCount: number; selected: number; largestTestsTotal: number; testCount: number; heapUsed: number };

    expect(result.roomCount).toBe(500);
    expect(result.selected).toBe(100);
    expect(result.largestTestsTotal).toBe(500);
    expect(result.testCount).toBe(500);
    expect(result.heapUsed).toBeLessThan(256 * 1024 * 1024);
  }, 70_000);
});
