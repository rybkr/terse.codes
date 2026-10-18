import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ProblemRepository, problemSchema, type Problem } from '../server/problems.js';
import { runCode } from '../server/runner.js';
import { decodeJsonValue, jsonValueBytes } from '../server/problem-values.js';

const directory = resolve('problems');
const corpusSchema = problemSchema.omit({ tests: true }).strict().extend({
  tests: z.array(z.object({ input: z.array(z.unknown()), expected: z.unknown() }).strict()).min(1),
});

function load(id: string): Problem {
  const data: unknown = JSON.parse(readFileSync(resolve(directory, `${id}.json`), 'utf8'));
  return { ...problemSchema.strict().parse(data), id };
}

describe('repaired problem data', () => {
  it('retains repaired testcases and original Python signatures with valid starter bodies', () => {
    const files = readdirSync(directory).sort();
    expect(files).toHaveLength(1884);
    let testCount = 0;
    const repository = new ProblemRepository(directory);
    const signatures: Pick<Problem, 'id' | 'starterCode' | 'entryPoint' | 'parameters' | 'returnType'>[] = [];
    for (const file of files) {
      expect(file).toMatch(/^[a-z0-9-]+\.json$/);
      const contents = readFileSync(resolve(directory, file), 'utf8');
      const data: unknown = JSON.parse(contents);
      expect(contents.includes(',"tests":['), file).toBe(true);
      const problem = corpusSchema.parse(data);
      const metadata = repository.get(file.slice(0, -5));
      expect(metadata.testCount, file).toBe(problem.tests.length);
      expect(metadata.comparison, file).toEqual(problem.comparison);
      for (const test of problem.tests) {
        if (test.input.length !== problem.parameters.length || !('expected' in test)) {
          throw new Error(`Invalid testcase in ${file}`);
        }
      }
      testCount += problem.tests.length;
      signatures.push({ id: file.slice(0, -5), starterCode: problem.starterCode, entryPoint: problem.entryPoint, parameters: problem.parameters, returnType: problem.returnType });
      expect(problem.statement).not.toContain('## TypeScript interface');
      expect(problem.statement, file).not.toMatch(/<img\b|!\[[^\n]*\]\(/i);
      expect(problem.statement, file).not.toMatch(/\b(?:image|figure|picture|diagram)\s+(?:above|below)\b|\b(?:above|below)\s+(?:image|figure|picture|diagram)\b/i);
      for (const snippet of problem.statement.matchAll(/^```[^\n]*\n([\s\S]*?)^```[ \t]*$/gm)) {
        expect(snippet[1], file).not.toMatch(/^\s*Explanation\s*:/im);
      }
    }
    expect(testCount).toBe(1_119_360);
    execFileSync('python3', ['-c', `import ast, json, sys
for problem in json.load(sys.stdin):
    compile(problem['starterCode'], problem['id'], 'exec')
    tree = ast.parse(problem['starterCode'])
    method = next(node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef))
    parameters = [{'name': arg.arg, 'type': ast.unparse(arg.annotation)} for arg in method.args.args if arg.arg != 'self']
    assert parameters == problem['parameters'], problem['id']
    assert ast.unparse(method.returns) == problem['returnType'], problem['id']
    assert problem['entryPoint'] == 'Solution().' + method.name, problem['id']
`], { input: JSON.stringify(signatures), encoding: 'utf8' });
  }, 30_000);

  it('preserves repaired mutation contracts', () => {
    const deduplicate = load('remove-duplicates-from-sorted-array');
    const sample = deduplicate.tests[0];
    const input = z.array(z.number()).parse(decodeJsonValue(sample?.input[0] ?? null));
    const unique = [...new Set(input)];
    expect(decodeJsonValue(sample?.expected ?? null)).toEqual([unique.length, unique]);
    expect(deduplicate.returnType).toBe('int');
    expect(deduplicate.adapter).toBe('prefix');

    expect(load('height-of-special-binary-tree').adapter).toBe('special-tree');
  });

  it('checks Remove Element mutations across its complete testcase suite', async () => {
    const problem = load('remove-element');
    const countOnly = await runCode(`class Solution:
    def removeElement(self, nums, val):
        return sum(value != val for value in nums)
`, problem);
    expect(countOnly).toMatchObject({ solved: false, error: 'Wrong answer.' });

    const reordered = await runCode(`class Solution:
    def removeElement(self, nums, val):
        nums[:] = sorted(value for value in nums if value != val)
        return len(nums)
`, problem);
    expect(reordered).toMatchObject({ solved: false, error: 'Wrong answer.' });

    const correct = await runCode(`class Solution:
    def removeElement(self, nums, val):
        k = 0
        for value in nums:
            if value != val:
                nums[k] = value
                k += 1
        return k
`, problem);
    expect(correct).toMatchObject({ passed: problem.tests.length, solved: true, error: null });
  }, 30_000);

  it('stores exact Python integer products and repaired floating point tolerances', () => {
    const problem = load('product-of-array-except-self');
    expect(problem.returnType).toBe('List[int]');
    const sample = problem.tests[0];
    const values = z.array(z.number().int()).parse(decodeJsonValue(sample?.input[0] ?? null));
    const exact = values.map((_, index) => ({
      $bigint: values.reduce((product, value, other) => other === index ? product : product * BigInt(value), 1n).toString(),
    }));
    expect(decodeJsonValue(sample?.expected ?? null)).toEqual(exact);
    expect(exact.some((value) => BigInt(value.$bigint) > BigInt(Number.MAX_SAFE_INTEGER) || BigInt(value.$bigint) < BigInt(Number.MIN_SAFE_INTEGER))).toBe(true);
    expect(load('powx-n').comparison).toEqual({ absoluteTolerance: 0.000001, relativeTolerance: 0 });
  });

  it('runs Python submissions against repaired mutation, tree, and large integer cases', async () => {
    const solutions = [
      ['remove-duplicates-from-sorted-array', `class Solution:
    def removeDuplicates(self, nums):
        prefix = sorted(set(nums))
        nums[:len(prefix)] = prefix
        return len(prefix)
`],
      ['product-of-array-except-self', `class Solution:
    def productExceptSelf(self, nums):
        result = [1] * len(nums)
        prefix = suffix = 1
        for index in range(len(nums)):
            result[index] *= prefix
            prefix *= nums[index]
        for index in range(len(nums) - 1, -1, -1):
            result[index] *= suffix
            suffix *= nums[index]
        return result
`],
      ['height-of-special-binary-tree', `class Solution:
    def heightOfTree(self, root):
        if root is None:
            return -1
        if root.left and root.left.right is root:
            return 0
        return 1 + max(self.heightOfTree(root.left), self.heightOfTree(root.right))
`],
    ] as const;
    for (const [id, code] of solutions) {
      const problem = load(id);
      const result = await runCode(code, { ...problem, tests: problem.tests.slice(0, 3) });
      expect(result, id).toMatchObject({ passed: 3, total: 3, error: null });
    }
  }, 30_000);

  it('requires the canonical restored path rather than a permutation or reversal', async () => {
    const original = load('restore-the-array-from-adjacent-pairs');
    const sample = original.tests[0];
    if (!sample) throw new Error('Missing restored-path testcase');
    const expected = z.array(z.number()).parse(decodeJsonValue(sample.expected));
    const problem = { ...original, tests: [sample] };
    expect(original.comparison).toBeUndefined();
    const correct = await runCode(`class Solution:\n    def restoreArray(self, adjacentPairs):\n        return ${JSON.stringify(expected)}\n`, problem);
    expect(correct).toMatchObject({ passed: 1, solved: true });
    const reversed = await runCode(`class Solution:\n    def restoreArray(self, adjacentPairs):\n        return ${JSON.stringify([...expected].reverse())}\n`, problem);
    expect(reversed).toMatchObject({ passed: 0, solved: false });
    const shuffled = await runCode(`class Solution:\n    def restoreArray(self, adjacentPairs):\n        return ${JSON.stringify([...expected].sort((left, right) => left - right))}\n`, problem);
    expect(shuffled).toMatchObject({ passed: 0, solved: false });
  });

  it('losslessly stores large repaired outputs as compressed JSON values', () => {
    const problem = load('combinations');
    const sample = [...problem.tests].sort((left, right) => jsonValueBytes(right.expected) - jsonValueBytes(left.expected))[0];
    if (!sample) throw new Error('Missing combinations testcase');
    const tag = z.object({ $json: z.string(), bytes: z.number().int().positive() }).parse(sample.expected);
    const raw = inflateSync(Buffer.from(tag.$json, 'base64'));
    expect(raw.byteLength).toBe(tag.bytes);
    const original: unknown = JSON.parse(raw.toString('utf8'));
    const combinations = z.array(z.array(z.number().int())).parse(decodeJsonValue(sample.expected));
    expect(combinations).toEqual(original);
    const [n, k] = z.tuple([z.number().int(), z.number().int()]).parse(sample.input.map(decodeJsonValue));
    let count = 1;
    for (let index = 1; index <= k; index++) count = count * (n - index + 1) / index;
    expect(combinations).toHaveLength(Math.round(count));
    for (const combination of combinations) {
      if (combination.length !== k || combination.some((value, index) => value < 1 || value > n || (index > 0 && value <= combination[index - 1]!))) {
        throw new Error('Invalid compressed combination');
      }
    }
  });
});
