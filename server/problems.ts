import { closeSync, openSync, readSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { isJsonValue } from './problem-values.js';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
const jsonValue = z.custom<JsonValue>(isJsonValue, 'Expected a finite JSON value.');
export const difficultySchema = z.enum(['Easy', 'Medium', 'Hard']);
export type Difficulty = z.infer<typeof difficultySchema>;
export const problemSchema = z.object({
  title: z.string().min(1),
  difficulty: difficultySchema,
  statement: z.string().min(1),
  starterCode: z.string().min(1),
  entryPoint: z.string().min(1),
  parameters: z.array(z.object({ name: z.string().regex(/^[A-Za-z_$][\w$]*$/), type: z.string().min(1) })),
  returnType: z.string().min(1),
  adapter: z.enum(['prefix', 'middle-list', 'reuse-list', 'mutated-tree', 'special-tree']).optional(),
  tests: z.array(z.object({ input: z.array(jsonValue), expected: jsonValue })).min(1),
  comparison: z.object({ absoluteTolerance: z.number().nonnegative().optional(), relativeTolerance: z.number().nonnegative().optional() }).optional(),
});
export type Problem = z.infer<typeof problemSchema> & { id: string; testCount?: number };
type ProblemMetadata = Omit<Problem, 'tests' | 'id' | 'testCount'> & { testCount: number };

interface CachedProblem {
  problem: Problem;
  estimatedBytes: number;
}

const MIB = 1024 * 1024;
const MAX_CACHE_BYTES = 128 * MIB;
const MAX_SINGLE_CACHE_BYTES = 160 * MIB;
const ESTIMATED_HEAP_BYTES_PER_FILE_BYTE = 4;

function freezeRecursively(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeRecursively(child);
}

function testArray(text: string, start: number): { count: number; end: number } {
  let count = 0;
  let index = start + 1;
  while (index < text.length) {
    while (/\s/.test(text[index] ?? '')) index += 1;
    if (text[index] === ']') return { count, end: index + 1 };

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (; index < text.length; index += 1) {
      const character = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
      } else if (character === '"') inString = true;
      else if (character === '{' || character === '[') depth += 1;
      else if (character === '}' || character === ']') {
        if (depth === 0) break;
        depth -= 1;
      } else if (character === ',' && depth === 0) break;
    }
    count += 1;
    if (text[index] === ',') index += 1;
  }
  throw new Error('Invalid problem test suite.');
}

function readMetadata(path: string): ProblemMetadata {
  const text = readFileSync(path, 'utf8');
  // Skip the generated test array without parsing its values, retaining metadata on either side.
  const testsMarker = text.indexOf(',"tests":[');
  if (testsMarker < 0) throw new Error('Problem test suite is missing or has an unsupported format.');
  const testsArray = testsMarker + 9;
  const { count, end } = testArray(text, testsArray);
  const metadata = problemSchema.omit({ tests: true }).parse(JSON.parse(`${text.slice(0, testsMarker)},"tests":[]${text.slice(end)}`));
  return { ...metadata, testCount: count };
}

export class ProblemRepository {
  private summaries: { id: string; title: string; difficulty: Difficulty }[] | undefined;
  private picked = new Map<string, Problem>();
  private parsed = new Map<string, CachedProblem>();
  private parsedBytes = 0;

  constructor(private directory = resolve('problems')) {}

  list() {
    this.summaries ??= readdirSync(this.directory).filter((file) => file.endsWith('.json')).sort().map((file) => {
      const path = resolve(this.directory, file);
      const descriptor = openSync(path, 'r');
      const buffer = Buffer.alloc(2048);
      let header: string;
      try {
        header = buffer.subarray(0, readSync(descriptor, buffer)).toString('utf8');
      } finally {
        closeSync(descriptor);
      }
      // Generated headers avoid materializing every hidden test suite just to list problems.
      const match = /^\{\s*"title"\s*:\s*("(?:[^"\\]|\\.)*")\s*,\s*"difficulty"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(header);
      const raw: unknown = match
        ? JSON.parse(`{"title":${match[1]},"difficulty":${match[2]}}`)
        : JSON.parse(readFileSync(path, 'utf8'));
      const metadata = problemSchema.pick({ title: true, difficulty: true }).parse(raw);
      return { ...metadata, id: file.slice(0, -5) };
    });
    return this.summaries;
  }

  pick(difficulty: Difficulty | null, previousId?: string): Problem {
    const matching = this.list().filter((problem) => !difficulty || problem.difficulty === difficulty);
    const different = matching.filter((problem) => problem.id !== previousId);
    const candidates = different.length ? different : matching;
    const problem = candidates[Math.floor(Math.random() * candidates.length)];
    if (!problem) throw new Error('No problems available for this difficulty.');
    return this.get(problem.id);
  }

  get(id: string): Problem {
    const existing = this.picked.get(id);
    if (existing) return existing;
    if (!this.list().some((summary) => summary.id === id)) throw new Error('Problem not found.');
    const metadata = readMetadata(resolve(this.directory, `${id}.json`));
    freezeRecursively(metadata);
    const loadTests = () => this.load(id).tests;
    const picked: Problem = {
      ...metadata,
      id,
      get tests() {
        return loadTests();
      },
    };
    Object.freeze(picked);
    this.picked.set(id, picked);
    return picked;
  }

  load(id: string): Problem {
    const summary = this.list().find((problem) => problem.id === id);
    if (!summary) throw new Error('Problem not found.');

    const cached = this.parsed.get(id);
    if (cached) {
      this.parsed.delete(id);
      this.parsed.set(id, cached);
      return cached.problem;
    }

    const path = resolve(this.directory, `${id}.json`);
    const estimatedBytes = statSync(path).size * ESTIMATED_HEAP_BYTES_PER_FILE_BYTE;
    if (estimatedBytes <= MAX_SINGLE_CACHE_BYTES) this.makeCacheRoom(estimatedBytes);
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const problem = { ...problemSchema.parse(raw), id };
    freezeRecursively(problem);
    this.cache(id, problem, estimatedBytes);
    return problem;
  }

  private cache(id: string, problem: Problem, estimatedBytes: number): void {
    if (estimatedBytes > MAX_SINGLE_CACHE_BYTES) return;
    this.parsed.set(id, { problem, estimatedBytes });
    this.parsedBytes += estimatedBytes;
  }

  private makeCacheRoom(estimatedBytes: number): void {
    while (this.parsed.size > 0 && this.parsedBytes + estimatedBytes > MAX_CACHE_BYTES) {
      const oldest = this.parsed.entries().next().value as [string, CachedProblem] | undefined;
      if (!oldest) break;
      this.parsed.delete(oldest[0]);
      this.parsedBytes -= oldest[1].estimatedBytes;
    }
  }
}

export function publicProblem(problem: Problem) {
  return {
    id: problem.id,
    title: problem.title,
    difficulty: problem.difficulty,
    statement: problem.statement.replace(/^\s*(?:[-*]\s*)?(?:Note|Follow-up):\s*This (?:question|problem) is the same as\s+\d+\s*:.*$/gim, '').trim(),
    starterCode: problem.starterCode,
  };
}
