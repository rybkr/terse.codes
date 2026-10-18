import { existsSync, readlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface RunnerCommand {
  command: string;
  args: string[];
  isolated: boolean;
}

export class RunnerIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerIsolationError';
  }
}

interface SandboxOptions {
  production: boolean;
  platform: NodeJS.Platform;
  pythonPath: string;
  workerPath: string;
  bubblewrapPath?: string;
}

const PRIVATE_TMP_SIZE = 64 * 1024 * 1024;

export function buildRunnerCommand(options: SandboxOptions): RunnerCommand {
  if (!options.production) {
    return {
      command: options.pythonPath,
      args: ['-I', '-X', 'utf8', options.workerPath],
      isolated: false,
    };
  }

  if (options.platform !== 'linux') {
    throw new RunnerIsolationError('Submission isolation is unavailable on this platform.');
  }

  const bubblewrap = options.bubblewrapPath ?? '/usr/bin/bwrap';
  if (!existsSync(bubblewrap)) {
    throw new RunnerIsolationError('Submission isolation is unavailable.');
  }
  const pythonPath = resolve(options.pythonPath);
  const venvPath = dirname(dirname(pythonPath));
  if (!existsSync(pythonPath) || !existsSync(venvPath) || !existsSync(options.workerPath)) {
    throw new RunnerIsolationError('Submission isolation is unavailable.');
  }

  const args = [
    '--die-with-parent', '--new-session', '--unshare-user', '--disable-userns', '--unshare-pid', '--unshare-ipc',
    '--unshare-net', '--unshare-uts', '--cap-drop', 'ALL',
    '--proc', '/proc', '--dev', '/dev', '--size', String(PRIVATE_TMP_SIZE), '--tmpfs', '/tmp', '--dir', '/etc',
  ];
  args.push('--ro-bind', '/usr', '/usr');
  if (existsSync('/bin')) args.push('--symlink', 'usr/bin', '/bin');
  if (existsSync('/lib')) args.push('--symlink', 'usr/lib', '/lib');
  if (existsSync('/lib64')) args.push('--symlink', 'usr/lib64', '/lib64');
  if (existsSync('/etc/ld.so.cache')) args.push('--ro-bind', '/etc/ld.so.cache', '/etc/ld.so.cache');
  args.push(
    '--ro-bind', venvPath, '/runner-venv',
    '--ro-bind', resolve(options.workerPath), '/runner-worker.py',
    '--chdir', '/tmp',
    '--setenv', 'PATH', '/usr/bin:/bin',
    '--setenv', 'TMPDIR', '/tmp',
    '--', '/runner-venv/bin/python3', '-I', '-X', 'utf8', '/runner-worker.py',
  );
  return { command: bubblewrap, args, isolated: true };
}

export async function verifyRunnerIsolation(): Promise<void> {
  if (process.env.NODE_ENV !== 'production') return;

  const worker = fileURLToPath(new URL('./runner-worker.py', import.meta.url));
  const pythonPath = '/app/.venv/bin/python3';
  let command: RunnerCommand;
  try {
    command = buildRunnerCommand({
      production: true,
      platform: process.platform,
      pythonPath,
      workerPath: worker,
    });
  } catch {
    throw new RunnerIsolationError('Production startup requires a working Bubblewrap sandbox.');
  }

  const separator = command.args.indexOf('--');
  if (separator === -1) throw new RunnerIsolationError('Production startup requires a working Bubblewrap sandbox.');
  const parentNetworkNamespace = readlinkSync('/proc/self/ns/net');
  const args = [
    ...command.args.slice(0, separator),
    '--setenv', 'LEETRACE_PARENT_NETNS', parentNetworkNamespace,
    '--', '/runner-venv/bin/python3', '-I', '-X', 'utf8', '/runner-worker.py',
  ];

  await new Promise<void>((resolveProbe, rejectProbe) => {
    const child = spawn(command.command, args, {
      cwd: '/tmp',
      env: { PATH: '/usr/bin:/bin', TMPDIR: '/tmp' },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      killProcessGroup(child);
      rejectProbe(new RunnerIsolationError('Production startup requires a working Bubblewrap sandbox.'));
    }, 5_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout = (stdout + chunk).slice(0, 4096); });
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(0, 4096); });
    child.on('error', () => {
      clearTimeout(timer);
      rejectProbe(new RunnerIsolationError('Production startup requires a working Bubblewrap sandbox.'));
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      if (exitCode === 0 && stdout.trim() === '{"probe":"ok"}') resolveProbe();
      else rejectProbe(new RunnerIsolationError('Production startup requires a working Bubblewrap sandbox.'));
    });
    child.stdin.on('error', () => { /* The worker may exit early if sandbox setup fails. */ });
    child.stdin.end(JSON.stringify({
      probe: true,
      parentNetNs: parentNetworkNamespace,
      inputs: [],
      parameters: [],
      entryPoint: '',
      returnType: '',
      code: '',
      memoryLimitMb: 128,
      cpuLimitSeconds: 2,
      outputLimit: 1024,
      strictResourceLimits: true,
    }));
  });
}

function killProcessGroup(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

export function runnerIsolationStatus(): 'bubblewrap' | 'development-only' | 'unavailable' {
  if (process.env.NODE_ENV !== 'production') return 'development-only';
  const worker = fileURLToPath(new URL('./runner-worker.py', import.meta.url));
  const ready = process.platform === 'linux'
    && existsSync('/usr/bin/bwrap')
    && existsSync('/app/.venv/bin/python3')
    && existsSync(worker);
  return ready ? 'bubblewrap' : 'unavailable';
}
