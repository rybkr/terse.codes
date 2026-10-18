import { describe, expect, it } from 'vitest';
import { ProblemRepository } from '../server/problems.js';
import { jsonValueBytes } from '../server/problem-values.js';
import { runCode } from '../server/runner.js';

describe('production corpus resource regressions', () => {
  it('judges every Color the Triangle Red case, including more than 64 MiB of valid output', async () => {
    const problem = new ProblemRepository().get('color-the-triangle-red');
    const result = await runCode(`class Solution:
    def colorRed(self, n):
        result = [[1, 1]]
        for row in range(2, n + 1):
            phase = (n - row) % 4
            columns = range(1, 2 * row, 2) if phase == 0 else [2] if phase == 1 else range(3, 2 * row, 2) if phase == 2 else [1]
            result.extend([row, column] for column in columns)
        return result
`, problem);
    expect(problem.tests).toHaveLength(500);
    expect(problem.tests.reduce((bytes, test) => bytes + jsonValueBytes(test.expected), 0)).toBe(103_033_567);
    expect(result).toMatchObject({ solved: true, passed: 500, total: 500, error: null });
  }, 60_000);

  it('enters and completes user code for all 605 Uncovered Ranges cases, including one million ranges', async () => {
    const problem = new ProblemRepository().get('find-maximal-uncovered-ranges');
    const result = await runCode(`class Solution:
    def findMaximalUncoveredRanges(self, n, ranges):
        if len(ranges) == 1_000_000:
            print("entered-largest")
        result = []
        cursor = 0
        for left, right in sorted(ranges):
            if left > cursor:
                result.append([cursor, left - 1])
            cursor = max(cursor, right + 1)
        if cursor < n:
            result.append([cursor, n - 1])
        return result
`, problem);
    expect(problem.tests).toHaveLength(605);
    expect(result.stdout).toBe("entered-largest\n");
    expect(result).toMatchObject({ solved: true, passed: 605, total: 605, error: null });
  }, 60_000);
});
