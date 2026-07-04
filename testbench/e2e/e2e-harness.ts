import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD_MODEL } from '../../src/config/models.ts';

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(E2E_DIR, '..', '..');
const ANSI_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export interface LavalampE2EHarnessOptions {
  workspace: string;
  rows?: number;
  cols?: number;
  timeoutMs?: number;
}

export interface LavalampE2EHarness {
  start(): Promise<void>;
  waitForBoot(): Promise<void>;
  waitForText(text: string, timeoutMs?: number): Promise<void>;
  submitSlash(command: string): Promise<void>;
  typeText(text: string): Promise<void>;
  pressEnter(): Promise<void>;
  pressEscape(): Promise<void>;
  pressArrow(direction: 'up' | 'down' | 'left' | 'right'): Promise<void>;
  cleanOutput(): string;
  rawOutput(): string;
  stop(): Promise<void>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function stripAnsi(value: string): string {
  return value
    .replace(ANSI_PATTERN, '')
    .replaceAll('\r', '')
    .replaceAll('\b', '');
}

function tail(value: string, max = 6000): string {
  return value.length <= max ? value : value.slice(value.length - max);
}

function arrowBytes(direction: 'up' | 'down' | 'left' | 'right'): string {
  switch (direction) {
    case 'up':
      return '\u001B[A';
    case 'down':
      return '\u001B[B';
    case 'left':
      return '\u001B[D';
    case 'right':
      return '\u001B[C';
  }
}

export function createLavalampE2EHarness(
  options: LavalampE2EHarnessOptions,
): LavalampE2EHarness {
  const timeoutMs = options.timeoutMs ?? 30000;
  const rows = options.rows ?? 42;
  const cols = options.cols ?? 120;
  let child: ChildProcessWithoutNullStreams | null = null;
  let output = '';
  let exitCode: number | null = null;

  function append(data: Buffer): void {
    output += data.toString('utf8');
    if (output.length > 2_000_000) {
      output = output.slice(output.length - 1_000_000);
    }
  }

  function write(data: string): Promise<void> {
    return new Promise((resolveWrite, rejectWrite) => {
      const proc = child;
      if (proc === null || proc.stdin.destroyed) {
        rejectWrite(
          new Error(
            `lavalamp e2e process is not running, exitCode=${exitCode}\n${tail(stripAnsi(output))}`,
          ),
        );
        return;
      }
      proc.stdin.write(data, (error) => {
        if (error) {
          rejectWrite(error);
          return;
        }
        resolveWrite();
      });
    });
  }

  async function waitForExit(waitMs: number): Promise<boolean> {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (exitCode !== null) {
        return true;
      }
      await delay(50);
    }
    return exitCode !== null;
  }

  return {
    async start(): Promise<void> {
      if (child !== null) {
        return;
      }
      const env = {
        ...process.env,
        LAVALAMP_MODEL: BUILD_MODEL,
        TERM: process.env.TERM ?? 'xterm-256color',
      };
      const home = process.env.LAVALAMP_E2E_HOME;
      if (home !== undefined && home.length > 0) {
        env.LAVALAMP_HOME = home;
      }
      child = spawn(
        'python3',
        [
          join(E2E_DIR, 'pty-bridge.py'),
          '--rows',
          String(rows),
          '--cols',
          String(cols),
          '--',
          join(REPO_ROOT, 'bin', 'lavalamp'),
          '--workspace',
          options.workspace,
        ],
        {
          cwd: REPO_ROOT,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      child.on('close', (code) => {
        exitCode = code ?? 0;
      });
      child.on('error', (error) => {
        output += `\n${error.message}\n`;
        exitCode = 1;
      });
      await delay(10);
    },

    async waitForBoot(): Promise<void> {
      await this.waitForText('Type your message', 150000);
    },

    async waitForText(text: string, waitMs = timeoutMs): Promise<void> {
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        const clean = this.cleanOutput();
        if (clean.includes(text)) {
          return;
        }
        if (exitCode !== null) {
          throw new Error(
            `lavalamp exited with ${exitCode} while waiting for ${JSON.stringify(text)}\n${tail(clean)}`,
          );
        }
        await delay(50);
      }
      throw new Error(
        `timed out waiting for ${JSON.stringify(text)}\n${tail(this.cleanOutput())}`,
      );
    },

    async submitSlash(command: string): Promise<void> {
      await this.typeText(`${command} `);
      await this.pressEnter();
    },

    async typeText(text: string): Promise<void> {
      await write(text);
      await delay(50);
    },

    async pressEnter(): Promise<void> {
      await write('\r');
      await delay(100);
    },

    async pressEscape(): Promise<void> {
      await write('\u001B');
      await delay(100);
    },

    async pressArrow(direction: 'up' | 'down' | 'left' | 'right'): Promise<void> {
      await write(arrowBytes(direction));
      await delay(100);
    },

    cleanOutput(): string {
      return stripAnsi(output);
    },

    rawOutput(): string {
      return output;
    },

    async stop(): Promise<void> {
      const proc = child;
      if (proc === null) {
        return;
      }
      if (exitCode === null) {
        try {
          await this.pressEscape();
          await write('\u0004');
        } catch {}
      }
      if (!(await waitForExit(3000)) && exitCode === null) {
        proc.kill('SIGTERM');
      }
      if (!(await waitForExit(3000)) && exitCode === null) {
        proc.kill('SIGKILL');
      }
      child = null;
    },
  };
}
