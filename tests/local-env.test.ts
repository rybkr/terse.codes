import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';

const directories: string[] = [];
const viteModule = resolve('node_modules/vite/dist/node/index.js');

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function frontendFixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'terse-local-env-')));
  directories.push(directory);
  mkdirSync(join(directory, 'frontend'));
  symlinkSync(resolve('node_modules'), join(directory, 'node_modules'), 'dir');
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
  copyFileSync('frontend/vite.config.ts', join(directory, 'frontend/vite.config.ts'));
  writeFileSync(join(directory, 'frontend/index.html'), '<script type="module" src="/main.js"></script>');
  writeFileSync(join(directory, 'frontend/main.js'), `document.body.textContent = JSON.stringify({
    key: import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
    unexpected: import.meta.env.VITE_UNEXPECTED,
    private: import.meta.env.CLERK_SECRET_KEY,
  });`);
  for (const name of ['.env', '.env.production', '.env.production.local', '.env.development', '.env.development.local']) {
    writeFileSync(join(directory, name), 'VITE_UNEXPECTED=production-file-sentinel\nFRONTEND_PORT=9999\n');
  }
  return directory;
}

function runVite(directory: string, source: string, environment: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: directory,
    env: { PATH: process.env.PATH, ...environment },
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

describe('local environment isolation', () => {
  it('uses only .env.local in the development frontend configuration', () => {
    const directory = frontendFixture();
    writeFileSync(join(directory, '.env.local'), 'VITE_CLERK_PUBLISHABLE_KEY=pk_test_local_fixture\nFRONTEND_PORT=3091\nBACKEND_PORT=8091\n');
    const output = runVite(directory, `
      import { resolveConfig } from ${JSON.stringify(viteModule)};
      const config = await resolveConfig({ configFile: 'frontend/vite.config.ts' }, 'serve');
      console.log(JSON.stringify({ env: config.env, port: config.server.port, proxy: config.server.proxy['/trpc'] }));
    `);
    expect(JSON.parse(output)).toMatchObject({
      env: { VITE_CLERK_PUBLISHABLE_KEY: 'pk_test_local_fixture' },
      port: 3091,
      proxy: 'http://127.0.0.1:8091',
    });
    expect(output).not.toContain('production-file-sentinel');
  }, 15_000);

  it.each(['local', 'override', 'fly'])('builds using %s settings without dotenv fallback', (source) => {
    const directory = frontendFixture();
    if (source !== 'fly') {
      writeFileSync(join(directory, '.env.local'), 'VITE_CLERK_PUBLISHABLE_KEY=pk_test_local_fixture\nCLERK_SECRET_KEY=private-local-sentinel\n');
    }
    runVite(directory, `
      import { build } from ${JSON.stringify(viteModule)};
      await build({ configFile: 'frontend/vite.config.ts', logLevel: 'silent' });
    `, source === 'local' ? {} : { VITE_CLERK_PUBLISHABLE_KEY: 'pk_live_fly_fixture' });
    const assets = join(directory, 'frontend/dist/assets');
    const bundle = readdirSync(assets).filter((name) => name.endsWith('.js'))
      .map((name) => readFileSync(join(assets, name), 'utf8')).join('\n');
    expect(bundle).toContain(source === 'local' ? 'pk_test_local_fixture' : 'pk_live_fly_fixture');
    expect(bundle).not.toContain('production-file-sentinel');
    expect(bundle).not.toContain('private-local-sentinel');
  }, 15_000);

  it('uses only .env.local in the unit test runner', () => {
    const directory = frontendFixture();
    copyFileSync('vitest.config.ts', join(directory, 'vitest.config.ts'));
    writeFileSync(join(directory, '.env.local'), 'VITE_CLERK_PUBLISHABLE_KEY=pk_test_local_fixture\n');
    writeFileSync(join(directory, 'environment.test.ts'), `
      import { it, expect } from 'vitest';
      it('isolates local environment settings', () => {
        expect(import.meta.env.VITE_UNEXPECTED).toBeUndefined();
        expect(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY).toBe('pk_test_local_fixture');
      });
    `);
    const result = spawnSync(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run', '--root', directory, '--maxWorkers=1'], {
      cwd: directory,
      env: { PATH: process.env.PATH },
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
  }, 15_000);

  it('bootstraps and reuses local Convex configuration without reading .env', () => {
    const directory = mkdtempSync(join(tmpdir(), 'terse-convex-env-'));
    directories.push(directory);
    mkdirSync(join(directory, 'node_modules/convex/bin'), { recursive: true });
    copyFileSync('scripts/configure-local.mjs', join(directory, 'configure-local.mjs'));
    writeFileSync(join(directory, '.env'), 'NODE_ENV=production\nCONVEX_DEPLOYMENT=prod:unexpected\nTERSE_SERVER_SECRET=production-secret-sentinel\n');
    writeFileSync(join(directory, '.env.local'), 'CLERK_SECRET_KEY=sk_test_local_fixture\n');
    writeFileSync(join(directory, 'node_modules/convex/bin/main.js'), `
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      const input = args.includes('set') ? fs.readFileSync(0, 'utf8') : '';
      fs.appendFileSync('calls.ndjson', JSON.stringify({args, input}) + '\\n');
      if (args.includes('--configure')) fs.appendFileSync('.env.local', 'CONVEX_DEPLOYMENT=dev:local-fixture\\n');
    `);
    const runSetup = () => spawnSync(process.execPath, ['--env-file=.env.local', 'configure-local.mjs'], {
      cwd: directory,
      env: { PATH: process.env.PATH },
      encoding: 'utf8',
    });

    const first = runSetup();
    expect(first.status, first.stderr).toBe(0);
    const saved = parseEnv(readFileSync(join(directory, '.env.local'), 'utf8'));
    expect(saved.CONVEX_DEPLOYMENT).toBe('dev:local-fixture');
    expect(saved.TERSE_SERVER_SECRET).toHaveLength(64);
    const second = runSetup();
    expect(second.status, second.stderr).toBe(0);
    const calls: { args: string[]; input: string }[] = readFileSync(join(directory, 'calls.ndjson'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    expect(calls).toEqual([
      { args: ['dev', '--env-file', '.env.local', '--once', '--configure'], input: '' },
      { args: ['env', '--env-file', '.env.local', 'set', 'TERSE_SERVER_SECRET'], input: `${saved.TERSE_SERVER_SECRET}\n` },
      { args: ['dev', '--env-file', '.env.local', '--once'], input: '' },
      { args: ['env', '--env-file', '.env.local', 'set', 'TERSE_SERVER_SECRET'], input: `${saved.TERSE_SERVER_SECRET}\n` },
    ]);
    expect(first.stdout + second.stdout).not.toContain(saved.TERSE_SERVER_SECRET);
    expect(first.stdout + second.stdout).not.toContain('production-secret-sentinel');
  });
});
