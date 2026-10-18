import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { buildRunnerCommand, RunnerIsolationError } from '../server/sandbox.js';

const workerPath = fileURLToPath(new URL('../server/runner-worker.py', import.meta.url));

describe('submission sandbox policy', () => {
  it('builds an isolated Linux command with a private filesystem and no network', () => {
    const command = buildRunnerCommand({
      production: true,
      platform: 'linux',
      pythonPath: process.execPath,
      workerPath,
      bubblewrapPath: process.execPath,
    });
    expect(command.isolated).toBe(true);
    expect(command.command).toBe(process.execPath);
    expect(command.args).toContain('--unshare-net');
    expect(command.args).toContain('--unshare-pid');
    expect(command.args).toContain('--disable-userns');
    expect(command.args).toContain('--cap-drop');
    expect(command.args).not.toContain('--no-new-privs');
    expect(command.args).toContain('--tmpfs');
    expect(command.args).toContain(String(64 * 1024 * 1024));
    expect(command.args).toContain('/runner-worker.py');
    expect(command.args).not.toContain('/proc/host');
    expect(command.args.filter((argument) => argument === '--bind')).toHaveLength(0);
  });

  it('fails closed when production isolation is unsupported or unavailable', () => {
    expect(() => buildRunnerCommand({
      production: true,
      platform: 'darwin',
      pythonPath: process.execPath,
      workerPath,
      bubblewrapPath: process.execPath,
    })).toThrow(RunnerIsolationError);
    expect(() => buildRunnerCommand({
      production: true,
      platform: 'linux',
      pythonPath: process.execPath,
      workerPath,
      bubblewrapPath: '/missing/bwrap',
    })).toThrow(/isolation is unavailable/i);
  });

  it('keeps local development on the current direct worker path', () => {
    const command = buildRunnerCommand({
      production: false,
      platform: 'darwin',
      pythonPath: 'python3',
      workerPath,
    });
    expect(command.isolated).toBe(false);
    expect(command.command).toBe('python3');
    expect(command.args).toEqual(['-I', '-X', 'utf8', workerPath]);
  });
});
