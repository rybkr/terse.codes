import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import type { Problem } from '../server/problems.js';
import { decodeJsonValue, jsonValueBytes } from '../server/problem-values.js';
import { runCode } from '../server/runner.js';

function problem(tests: Problem['tests'], comparison?: Problem['comparison']): Problem {
  return {
    id: 'test', title: 'Test', difficulty: 'Easy', statement: 'Test',
    starterCode: 'def solve(value: int) -> int:\n    pass\n', entryPoint: 'solve',
    parameters: [{ name: 'value', type: 'int' }], returnType: 'int', tests, comparison,
  };
}

describe('Python submission runner', () => {
  it('runs decoded inputs from smallest to largest while preserving expected results and equal-size order', async () => {
    const large = 'a'.repeat(200);
    const medium = 'b'.repeat(100);
    const json = JSON.stringify(large);
    const compressed = { $json: deflateSync(json).toString('base64'), bytes: Buffer.byteLength(json) };
    const fixture = problem([
      { input: [compressed], expected: large },
      { input: [medium], expected: 'wrong medium' },
      { input: ['x'], expected: 'wrong first' },
      { input: ['y'], expected: 'wrong second' },
    ]);
    const result = await runCode('def solve(value):\n    print(len(value))\n    return value', fixture);
    expect(result.stdout).toBe('1\n1\n100\n200\n');
    expect(result.passed).toBe(1);
    expect(result.firstFailure).toEqual({ input: '["x"]', expected: '"wrong first"', actual: '"x"' });
    expect(fixture.tests[0]?.input[0]).toEqual(compressed);
  });

  it('runs Python and reports the first failure with bounded captured output', async () => {
    const result = await runCode('def solve(value: int) -> int:\n    return value * 2', problem([
      { input: [2], expected: 4 }, { input: [3], expected: 7 },
    ]));
    expect(result).toMatchObject({ passed: 1, total: 2, solved: false, error: 'Wrong answer.' });
    expect(result.firstFailure).toEqual({ input: '[3]', expected: '7', actual: '6' });
    const logs = await runCode('import sys\ndef solve():\n    print("x" * 6000, file=stdout)\n    print("problem", file=stderr)\n    print("module", file=sys.stderr)\n    return 1',
      problem([{ input: [], expected: 1 }]));
    expect(logs.stdout).toHaveLength(5000);
    expect(logs.stderr).toBe('problem\nmodule\n');
  });

  it('preloads standard-library and sortedcontainers imports without counting them in the score', async () => {
    const fixture = problem([{ input: [[81, 16, 25]], expected: [4, 5] }]);
    fixture.parameters = [{ name: 'values', type: 'List[int]' }];
    fixture.returnType = 'List[int]';
    fixture.entryPoint = 'Solution().solve';
    const code = `class Solution:
    def solve(self, values: List[int]) -> List[int]:
        assert ascii_lowercase.startswith('abc')
        assert fullmatch(r'\\d+', '123')
        assert datetime(2020, 1, 1) + timedelta(days=1) == datetime(2020, 1, 2)
        assert Counter(values)[81] == 1
        assert bisect([1, 2], 2) == 2
        assert deepcopy(values) == values and deepcopy(values) is not values
        assert randint(7, 7) == 7 and 0 <= random() < 1
        assert median([1, 2, 3]) == 2
        assert list(chain([1], [2])) == [1, 2]
        assert reduce(add, [1, 2]) == 3
        assert StringIO('hello').read() == 'hello'
        assert maxsize > 1000
        assert loads('{"value": 1}') == {'value': 1}
        assert pow(2, 3, 5) == 3
        assert list(SortedSet([2, 1, 2])) == [1, 2]
        assert list(SortedDict({2: 'b', 1: 'a'})) == [1, 2]
        return [isqrt(value) for value in SortedList(nsmallest(2, values))]
`;
    const result = await runCode(code, fixture);
    expect(result).toMatchObject({ solved: true, error: null, charCount: code.length });
  });

  it('creates a fresh submission namespace for each testcase', async () => {
    const result = await runCode(`calls = 0
def solve():
    global calls
    calls += 1
    return calls
`, problem([{ input: [], expected: 1 }, { input: [], expected: 1 }]));
    expect(result.solved).toBe(true);
  });

  it('keeps expected answers out of submission globals', async () => {
    const result = await runCode(`def solve():
    return all(key not in globals() for key in ("expected", "tests", "request", "__expected"))
`, problem([{ input: [], expected: true }]));
    expect(result.solved).toBe(true);
  });

  it('compares object keys, ordered arrays, and strict scalar types', async () => {
    const code = 'def solve(value):\n    return value';
    const ordered = await runCode(code, problem([
      { input: [{ b: 2, a: 1 }], expected: { a: 1, b: 2 } },
      { input: [[2, 1]], expected: [1, 2] },
      { input: [true], expected: 1 },
    ]));
    expect(ordered.passed).toBe(1);
  });

  it('applies absolute and relative floating tolerances recursively', async () => {
    const result = await runCode('def solve(value: List[float]) -> List[float]:\n    return value', problem([
      { input: [[0.0000001, 1000000.1]], expected: [0, 1000000] },
      { input: [[0.1]], expected: [0] },
    ], { absoluteTolerance: 0.000001, relativeTolerance: 0.000001 }));
    expect(result.passed).toBe(1);
  });

  it('preserves exact Python integers across the JSON safe-integer boundary', async () => {
    const result = await runCode('def solve(value: int) -> int:\n    return value + 1', problem([
      { input: [{ $bigint: '9007199254740993' }], expected: { $bigint: '9007199254740994' } },
      { input: [{ $bigint: '-9007199254740993' }], expected: { $bigint: '-9007199254740992' } },
      { input: [{ $bigint: '9007199254740991' }], expected: { $bigint: '9007199254740992' } },
      { input: [0], expected: { $bigint: '1' } },
    ]));
    expect(result.solved).toBe(true);
  });

  it('bounds infinite loops during execution and serialization', async () => {
    for (const code of [
      'def solve():\n    while True:\n        pass',
      'class Stuck(dict):\n    def items(self):\n        while True:\n            pass\ndef solve():\n    return Stuck()',
    ]) {
      const result = await runCode(code, problem([{ input: [], expected: 1 }]));
      expect(result.solved).toBe(false);
      expect(result.error).toMatch(/time limit/i);
      expect(result.timeMs).toBeLessThan(8000);
    }
  }, 20_000);

  it('reports runtime errors and rejects non-JSON and nonfinite results', async () => {
    for (const code of [
      'def solve():\n    raise ValueError("bad value")',
      'def solve():\n    return object()',
      'def solve():\n    return float("nan")',
      'def solve():\n    return float("inf")',
      'async def solve():\n    return 1',
    ]) {
      const result = await runCode(code, problem([{ input: [], expected: 1 }]));
      expect(result.solved).toBe(false);
      expect(result.error).toMatch(/runtime error/i);
    }
  });

  it('rejects oversized output and malformed Python', async () => {
    const output = await runCode('def solve():\n    return "x" * (2 * 1024 * 1024)', problem([
      { input: [], expected: '' },
    ]));
    expect(output.error).toMatch(/output limit/i);
    const compile = await runCode('def solve(:', problem([{ input: [], expected: 1 }]));
    expect(compile.error).toMatch(/compilation/i);
  });

  it('rejects forged response bursts without buffering the entire remaining input suite', async () => {
    const value = 'x'.repeat(2 * 1024 * 1024);
    const result = await runCode(`import os
def solve(value):
    os.write(1, b'{"output":"null"}\\n' * 1000)
    return None
`, problem(Array.from({ length: 40 }, () => ({ input: [value], expected: null }))));
    expect(result.solved).toBe(false);
    expect(result.error).toBe('Invalid runner output.');
    expect(result.passed).toBeLessThanOrEqual(2);
  });

  it('bounds forged worker errors before retaining submission feedback', async () => {
    const result = await runCode(`import json, os
os.write(1, (json.dumps({"error": "x" * 500000}) + "\\n").encode())
os._exit(0)
`, problem([{ input: [], expected: 1 }]));
    expect(result.solved).toBe(false);
    expect(result.error).toBe('x'.repeat(500));
    expect(result.firstFailure?.actual).toHaveLength(500);
  });

  it('scales output budgets to legitimate large testcase results', async () => {
    const expected = 'x'.repeat(2 * 1024 * 1024);
    const result = await runCode('def solve():\n    return "x" * (2 * 1024 * 1024)',
      problem(Array.from({ length: 9 }, () => ({ input: [], expected }))));
    expect(result.solved).toBe(true);
    expect(result.passed).toBe(9);
  }, 15_000);

  it('preserves multibyte Unicode across input and output stream chunks', async () => {
    const value = '😀漢é'.repeat(100_000);
    const result = await runCode('def solve(value: str) -> str:\n    return value',
      problem([{ input: [value], expected: value }]));
    expect(result.solved).toBe(true);
    expect(result.firstFailure).toBeNull();
  });

  it('judges compressed inputs and expected values without exposing packed data to solve', async () => {
    const values = Array.from({ length: 20_000 }, (_, index) => index);
    const json = JSON.stringify(values);
    const packed = { $json: deflateSync(json).toString('base64'), bytes: Buffer.byteLength(json) };
    expect(jsonValueBytes(packed)).toBe(Buffer.byteLength(json));
    expect(decodeJsonValue(packed)).toEqual(values);
    const result = await runCode('def solve(value: List[int]) -> List[int]:\n    return value',
      problem([{ input: [packed], expected: packed }]));
    expect(result.solved).toBe(true);
    expect(result.firstFailure).toBeNull();
  });

  it('rejects corrupted compressed values and decoded nonfinite numbers', async () => {
    const json = '[1,2,3]';
    const packed = { $json: deflateSync(json).toString('base64'), bytes: Buffer.byteLength(json) };
    for (const value of [
      { ...packed, bytes: packed.bytes - 1 },
      { ...packed, bytes: packed.bytes + 1 },
      { ...packed, $json: 'invalid' },
      { ...packed, bytes: 65 * 1024 * 1024 },
      { $json: deflateSync('1e400').toString('base64'), bytes: 5 },
    ]) {
      expect(() => decodeJsonValue(value)).toThrow(/compressed problem value/i);
      const result = await runCode('def solve(value):\n    return value',
        problem([{ input: [value], expected: null }]));
      expect(result.solved).toBe(false);
      expect(result.error).toMatch(/compressed problem/i);
    }
    const expected = await runCode('def solve():\n    return None',
      problem([{ input: [], expected: { ...packed, bytes: packed.bytes + 1 } }]));
    expect(expected.error).toMatch(/compressed expected/i);
  });

  it('rejects top-level returns and user-created transport tags', async () => {
    const result = await runCode('return 123\ndef solve():\n    return 123',
      problem([{ input: [], expected: 123 }], { relativeTolerance: 0.00001 }));
    expect(result.solved).toBe(false);
    expect(result.passed).toBe(0);
    expect(result.error).toMatch(/compilation/i);
    const bigint = await runCode('def solve():\n    return {"$bigint": "01"}',
      problem([{ input: [], expected: { $bigint: '1' } }]));
    expect(bigint.solved).toBe(false);
    expect(bigint.error).toMatch(/transport tags are reserved/i);
    const forgedInteger = await runCode('def solve():\n    return {"$bigint": "1"}',
      problem([{ input: [], expected: 1 }]));
    expect(forgedInteger.solved).toBe(false);
    expect(forgedInteger.error).toMatch(/transport tags are reserved/i);
  });

  it('checks in-place prefix contents, not only the returned length', async () => {
    const fixture = problem([{ input: [[1, 1, 2]], expected: [2, [1, 2]] }]);
    fixture.parameters = [{ name: 'values', type: 'List[int]' }];
    fixture.adapter = 'prefix';
    const result = await runCode('def solve(values):\n    values[:] = sorted(set(values))\n    return len(values)', fixture);
    expect(result.solved).toBe(true);
    const wrong = await runCode('def solve(values):\n    return 2', fixture);
    expect(wrong.error).toBe('Wrong answer.');
  });

  it('creates linked-list nodes and enforces original middle-node identity', async () => {
    const fixture = problem([{ input: [[1, 2, 3, 4]], expected: [3, 4] }]);
    fixture.parameters = [{ name: 'head', type: 'Optional[ListNode]' }];
    fixture.returnType = 'Optional[ListNode]';
    fixture.adapter = 'middle-list';
    const result = await runCode('def solve(head):\n    return head.next.next', fixture);
    expect(result.solved).toBe(true);
    const cloned = await runCode('def solve(head):\n    return ListNode(3, ListNode(4))', fixture);
    expect(cloned.error).toMatch(/original middle node/i);
    fixture.adapter = undefined;
    const array = await runCode('def solve(head):\n    return [3, 4]', fixture);
    expect(array.solved).toBe(false);
    expect(array.error).toMatch(/ListNode/i);
  });

  it('preserves cyclic list inputs and serializes empty node results', async () => {
    const fixture = problem([{ input: [{ values: [1, 2, 3], cycle: 1 }], expected: true }]);
    fixture.parameters = [{ name: 'head', type: 'ListNode' }];
    fixture.returnType = 'bool';
    const cyclic = await runCode('def solve(head):\n    return head.next.next.next is head.next', fixture);
    expect(cyclic.solved).toBe(true);
    fixture.tests = [{ input: [[]], expected: [] }];
    fixture.parameters = [{ name: 'head', type: 'Optional[ListNode]' }];
    fixture.returnType = 'Optional[ListNode]';
    const empty = await runCode('def solve(head):\n    return head', fixture);
    expect(empty.solved).toBe(true);
  });

  it('requires group reversal to reuse original list nodes without changing values', async () => {
    const fixture = problem([{ input: [[1, 2, 3], 2], expected: [2, 1, 3] }]);
    fixture.parameters = [{ name: 'head', type: 'ListNode' }, { name: 'k', type: 'int' }];
    fixture.returnType = 'ListNode';
    fixture.adapter = 'reuse-list';
    const result = await runCode('def solve(head, k):\n    second = head.next\n    head.next = second.next\n    second.next = head\n    return second', fixture);
    expect(result.solved).toBe(true);
    const cloned = await runCode('def solve(head, k):\n    return ListNode(2, ListNode(1, ListNode(3)))', fixture);
    expect(cloned.error).toMatch(/reuse original nodes/i);
  });

  it('adapts tree inputs and verifies mutations on the original tree', async () => {
    const fixture = problem([{ input: [[2, 1, 3]], expected: [5, 6, 3] }]);
    fixture.parameters = [{ name: 'root', type: 'TreeNode' }];
    fixture.returnType = 'TreeNode';
    fixture.adapter = 'mutated-tree';
    const result = await runCode('def solve(root):\n    root.val = 5\n    root.left.val = 6\n    return root', fixture);
    expect(result.solved).toBe(true);
    const cloned = await runCode('def solve(root):\n    return TreeNode(5, TreeNode(6), TreeNode(3))', fixture);
    expect(cloned.error).toMatch(/mutate the original tree/i);
  });

  it('constructs special-tree leaf links for the original Python interface', async () => {
    const fixture = problem([{ input: [[2, 1, 3]], expected: true }]);
    fixture.parameters = [{ name: 'root', type: 'TreeNode' }];
    fixture.returnType = 'bool';
    fixture.adapter = 'special-tree';
    const result = await runCode('def solve(root):\n    return root.left.left is root.right and root.right.right is root.left', fixture);
    expect(result.solved).toBe(true);
  });
});
