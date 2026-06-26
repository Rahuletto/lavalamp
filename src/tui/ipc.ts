import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { randomUUID } from 'node:crypto';

export interface FlueEvent {
  type: string;
  text?: string;
  delta?: string;
  content?: string;
  toolName?: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
  durationMs?: number;
  model?: string;
  provider?: string;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { input: number; output: number; total: number };
  };
  turnId?: string;
  purpose?: string;
  stopReason?: string;
  message?: string;
  level?: string;
  messagesBefore?: number;
  messagesAfter?: number;
  [key: string]: unknown;
}

export interface FlueResult {
  text: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { input: number; output: number; total: number };
  };
  model: { provider: string; id: string };
}

export interface PromptCallbacks {
  onStarted?: () => void;
  onEvent?: (event: FlueEvent) => void;
  onResult?: (result: FlueResult) => void;
  onError?: (error: Error) => void;
}

export interface PermissionRequestMsg {
  type: 'permission_request';
  requestId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export type PermissionDecision = 'allow' | 'deny';

export type OnPermissionRequest = (request: PermissionRequestMsg) => void;

export class FlueProcess {
  private child: ChildProcess | null = null;
  private ready = false;
  private pending = new Map<string, PromptCallbacks>();
  private shutdownRequested = false;
  onPermissionRequest?: OnPermissionRequest;

  constructor(
    private serverPath: string,
    private cwd: string,
    private agentName: string = 'build',
  ) {}

  setAgentName(name: string) {
    this.agentName = name;
  }

  get isProcessing(): boolean {
    return this.pending.size > 0;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  sendPermissionResponse(
    requestId: string,
    decision: PermissionDecision,
    alwaysAllow?: boolean,
  ): void {
    if (!this.child) {
      return;
    }
    this.child.send({
      alwaysAllow: alwaysAllow ?? false,
      decision,
      requestId,
      type: 'permission_response',
    });
  }

  async start(): Promise<void> {
    const instanceId = `inst_${randomUUID().slice(0, 8)}`;

    this.child = spawn(process.execPath, [this.serverPath], {
      cwd: this.cwd,
      env: {
        ...process.env,
        FLUE_CLI_ID: instanceId,
        FLUE_CLI_NAME: this.agentName,
        FLUE_CLI_TARGET: 'agent',
        FLUE_INTERNAL_CLI_IPC: '1',
        FLUE_MODE: 'local',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    this.child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      const lines = text.trimEnd().split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        if (/\d+;rgb:/.test(trimmed)) {
          continue;
        }
        if (trimmed.startsWith('ghostty')) {
          continue;
        }
        if (/^\d+;\d+[A-Z]/.test(trimmed)) {
          continue;
        }
        process.stderr.write(`  ${trimmed}\n`);
      }
    });

    this.child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      const lines = text.trimEnd().split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        if (/\d+;rgb:/.test(trimmed)) {
          continue;
        }
        if (trimmed.startsWith('ghostty')) {
          continue;
        }
        if (/^\d+;\d+[A-Z]/.test(trimmed)) {
          continue;
        }
        process.stderr.write(`  ${trimmed}\n`);
      }
    });

    this.child.on('exit', (code) => {
      if (!this.ready) {
        this.rejectAll(new Error(`Server exited before ready (code ${code})`));
      }
    });

    await this.waitForReady(instanceId);
  }

  private waitForReady(instanceId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        this.child?.kill('SIGTERM');
        reject(new Error('Server did not become ready within 60s'));
      }, 60_000);

      const onMessage = (raw: Record<string, unknown>) => {
        if (raw.type === 'error') {
          cleanup();
          reject(new Error(String(raw.error)));
          return;
        }
        if (
          raw.type === 'ready' &&
          raw.target === 'agent' &&
          raw.name === this.agentName &&
          raw.instanceId === instanceId
        ) {
          cleanup();
          this.ready = true;
          resolve();
        }
      };

      const onExit = (code: number | null) => {
        cleanup();
        reject(new Error(`Server exited before ready (code ${code})`));
      };

      const cleanup = () => {
        clearTimeout(timeout);
        this.child?.off('message', onMessage);
        this.child?.off('exit', onExit);
      };

      this.child?.on('message', onMessage);
      this.child?.once('exit', onExit);
    });
  }

  prompt(
    message: string,
    callbacks: PromptCallbacks = {},
    sessionId?: string,
  ): string {
    if (!this.child || !this.ready) {
      throw new Error('Server not started');
    }

    const requestId = `req_${randomUUID()}`;
    this.pending.set(requestId, callbacks);

    this.child.send({
      message,
      requestId,
      sessionId,
      type: 'prompt',
    });

    this.child.on('message', (raw: Record<string, unknown>) => {
      // Handle permission requests from the server
      if (raw.type === 'permission_request') {
        this.onPermissionRequest?.(raw as unknown as PermissionRequestMsg);
        return;
      }

      if (raw.requestId !== requestId) {
        return;
      }

      if (raw.type === 'started') {
        callbacks.onStarted?.();
        return;
      }

      if (raw.type === 'event') {
        callbacks.onEvent?.(raw.event as FlueEvent);
        return;
      }

      if (raw.type === 'result') {
        this.pending.delete(requestId);
        callbacks.onResult?.(raw.result as FlueResult);
        return;
      }

      if (raw.type === 'error') {
        this.pending.delete(requestId);
        const err = raw.error as { message?: string; details?: string };
        callbacks.onError?.(
          new Error(err.message ?? err.details ?? 'Unknown error'),
        );
        return;
      }
    });

    return requestId;
  }

  cancel(): void {
    this.rejectAll(new Error('Cancelled'));
    if (this.child) {
      this.child.kill('SIGTERM');
      this.child = null;
      this.ready = false;
    }
  }

  async restart(): Promise<void> {
    this.cancel();
    await this.start();
  }

  async shutdown(): Promise<void> {
    if (this.shutdownRequested) {
      return;
    }
    this.shutdownRequested = true;

    this.rejectAll(new Error('Shutting down'));
    this.child?.kill('SIGTERM');

    await new Promise<void>((resolve) => {
      if (!this.child) {
        return resolve();
      }
      const timeout = setTimeout(() => {
        this.child?.kill('SIGKILL');
        resolve();
      }, 5000);
      this.child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    this.child = null;
    this.ready = false;
  }

  private rejectAll(error: Error) {
    for (const [id, cbs] of this.pending) {
      cbs.onError?.(error);
      this.pending.delete(id);
    }
  }
}
