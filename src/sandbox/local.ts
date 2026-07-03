import { spawn } from 'node:child_process';
import {
  mkdirSync,
  rmSync,
  existsSync,
  statSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import { requestPermission } from '../permissions/middleware';

function findShell(): string {
  const { platform } = process;

  const envShell = process.env.SHELL;
  if (envShell !== undefined && existsSync(envShell)) {
    return envShell;
  }

  const candidates =
    platform === 'win32'
      ? ['cmd.exe', 'powershell.exe']
      : ['/bin/zsh', '/bin/bash', '/bin/sh'];

  for (const sh of candidates) {
    if (existsSync(sh)) {
      return sh;
    }
  }

  return platform === 'win32' ? 'cmd.exe' : '/bin/sh';
}

const detectedShell = findShell();

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const KILL_GRACE_MS = 2000;

interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

 async function execCommand(
  command: string,
  options: ExecOptions = {},
): Promise<ShellResult> {
  return new Promise((resolve) => {
    const cwd = options.cwd ?? process.cwd();
    const env = { ...process.env, ...options.env};

    const isWin = process.platform === 'win32';
    const shellCmd = isWin ? 'cmd.exe' : detectedShell;
    const shellArgs = isWin ? ['/c', command] : ['-c', command];

    const proc = spawn(shellCmd, shellArgs, {
      cwd,
      detached: !isWin,
      env,
      signal: options.signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killed = false;

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let totalBytes = 0;

    proc.stdout.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_OUTPUT_BYTES) {
        if (!killed) {
          killed = true;
          proc.kill('SIGTERM');
          setTimeout(() => {
            try {
              proc.kill('SIGKILL');
            } catch {}
          }, KILL_GRACE_MS);
        }
        return;
      }
      chunks.push(chunk);
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      errChunks.push(chunk);
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killed = true;
        proc.kill('SIGTERM');
        setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {}
        }, KILL_GRACE_MS);
      }, options.timeoutMs);
    }

    proc.on('close', (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      stdout = Buffer.concat(chunks).toString('utf8');
      stderr = Buffer.concat(errChunks).toString('utf8');
      resolve({ exitCode: code ?? 1, stderr, stdout, timedOut });
    });

    proc.on('error', () => {
      if (timer) {
        clearTimeout(timer);
      }
      stdout = Buffer.concat(chunks).toString('utf8');
      stderr = Buffer.concat(errChunks).toString('utf8');
      resolve({ exitCode: 1, stderr, stdout, timedOut });
    });
  });
}

/**
 * Wrap exec with permission gating for `bash` tool.
 * Read-only sed commands are auto-allowed by the rules.
 */
async function gatedExec(
  command: string,
  options: ExecOptions = {},
  workspaceRoot: string,
): Promise<ShellResult> {
  const response = await requestPermission('bash', { command }, workspaceRoot);
  if (response.decision === 'deny') {
    return {
      exitCode: 1,
      stderr: 'Permission denied',
      stdout: '',
      timedOut: false,
    };
  }
  return execCommand(command, options);
}

/**
 * Wrap writeFile with permission gating for `write`/`edit` tools.
 */
async function gatedWriteFile(
  path: string,
  content: string | Uint8Array,
  workspaceRoot: string,
  cwd: string,
): Promise<void> {
  const response = await requestPermission(
    'write',
    { file_path: path },
    workspaceRoot,
  );
  if (response.decision === 'deny') {
    throw new Error('Permission denied for write');
  }
  const resolved = resolve(cwd, path);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, content);
}

export function local(_options: { env?: Record<string, string> } = {}) {
  return {
    createSessionEnv: async () => {
      const cwd = process.cwd();
      return {
        cwd,
        exec:  async (command: string, opts: ExecOptions = {}) =>
          gatedExec(command, opts, cwd),
        async exists(path: string): Promise<boolean> {
          return existsSync(resolve(cwd, path));
        },
        async mkdir(path: string, options?: { recursive?: boolean }) {
          mkdirSync(resolve(cwd, path), { recursive: options !== undefined ? options.recursive : undefined });
        },
        async readFile(path: string): Promise<string> {
          return readFileSync(resolve(cwd, path), 'utf8');
        },
        async readFileBuffer(path: string): Promise<Uint8Array> {
          return new Uint8Array(readFileSync(resolve(cwd, path)));
        },
        async readdir(path: string): Promise<string[]> {
          return readdirSync(resolve(cwd, path));
        },
        resolvePath(p: string): string {
          return resolve(cwd, p);
        },
        async rm(
          path: string,
          options?: { recursive?: boolean; force?: boolean },
        ) {
          rmSync(resolve(cwd, path), {
            force: options !== undefined ? options.force : undefined,
            recursive: options !== undefined ? options.recursive : undefined,
          });
        },
        async stat(path: string) {
          const s = statSync(resolve(cwd, path));
          return {
            isDirectory: s.isDirectory(),
            isFile: s.isFile(),
            mtime: s.mtime,
            size: s.size,
          };
        },
        async writeFile(
          path: string,
          content: string | Uint8Array,
        ): Promise<void> {
          return gatedWriteFile(path, content, cwd, cwd);
        },
      };
    },
  };
}
