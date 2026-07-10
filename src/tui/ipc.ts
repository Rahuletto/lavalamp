import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
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

export interface QuestionRequestMsg {
  type: 'question_request';
  requestId: string;
  questions: any[];
}

export type PermissionDecision = 'allow' | 'deny';

export type OnPermissionRequest = (request: PermissionRequestMsg) => void;
export type OnQuestionRequest = (request: QuestionRequestMsg) => void;

export interface BashStreamChunk {
  type: 'bash_stream';
  chunk: string;
  stream: 'stdout' | 'stderr';
}

export type OnBashStream = (chunk: string, stream: 'stdout' | 'stderr') => void;

export interface PromptImage {
  type: 'image';
  data: string;
  mimeType: string;
}

export class FlueProcess {
  private child: ChildProcess | null = null;
  private ready = false;
  private readonly pending = new Map<string, PromptCallbacks>();
  private shutdownRequested = false;
  onPermissionRequest?: OnPermissionRequest;
  onQuestionRequest?: OnQuestionRequest;
  onBashStream?: OnBashStream;

  private readonly handleChildMessage = (raw: Record<string, unknown>) => {
    if (raw.type === 'bash_stream') {
      if (this.onBashStream != null) {
        const chunk = typeof raw.chunk === 'string' ? raw.chunk : '';
        const stream =
          raw.stream === 'stderr' ? 'stderr' : 'stdout';
        this.onBashStream(chunk, stream);
      }
      return;
    }

    if (raw.type === 'permission_request') {
      if (this.onPermissionRequest != null) {
        this.onPermissionRequest(raw as unknown as PermissionRequestMsg);
      }
      return;
    }

    if (raw.type === 'question_request') {
      if (this.onQuestionRequest != null) {
        this.onQuestionRequest(raw as unknown as QuestionRequestMsg);
      }
      return;
    }

    const requestId =
      typeof raw.requestId === 'string' ? raw.requestId : undefined;
    if (requestId === undefined) {
      return;
    }

    const callbacks = this.pending.get(requestId);
    if (callbacks === undefined) {
      return;
    }

    if (raw.type === 'started') {
      if (callbacks.onStarted != null) {
        callbacks.onStarted();
      }
      return;
    }

    if (raw.type === 'event') {
      if (callbacks.onEvent != null) {
        callbacks.onEvent(raw.event as FlueEvent);
      }
      return;
    }

    if (raw.type === 'result') {
      this.pending.delete(requestId);
      if (callbacks.onResult != null) {
        callbacks.onResult(raw.result as FlueResult);
      }
      return;
    }

    if (raw.type === 'error') {
      this.pending.delete(requestId);
      const err =
        raw.error !== null &&
        raw.error !== undefined &&
        typeof raw.error === 'object'
          ? (raw.error as { message?: string; details?: string })
          : {};
      if (callbacks.onError != null) {
        callbacks.onError(
          new Error(
            err.message ?? err.details ?? String(raw.error ?? 'Unknown error'),
          ),
        );
      }
    }
  };

  constructor(
    private readonly serverPath: string,
    private readonly cwd: string,
    private agentName = 'build',
  ) {}

  setAgentName(name: string) {
    this.agentName = name;
  }

  get isProcessing(): boolean {
    return this.pending.size > 0;
  }

  get pid(): number | undefined {
    return this.child !== null ? this.child.pid : undefined;
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

  sendQuestionResponse(
    requestId: string,
    answers: Record<string, any>,
  ): void {
    if (!this.child) {
      return;
    }
    this.child.send({
      answers,
      requestId,
      type: 'question_response',
    });
  }

  async start(): Promise<void> {
    const instanceId = `inst_${randomUUID().slice(0, 8)}`;
    this.shutdownRequested = false;

    this.child = spawn(process.execPath, [this.serverPath], {
      cwd: this.cwd,
      env: {
        ...process.env,
        FLUE_CLI_ID: instanceId,
        FLUE_CLI_NAME: this.agentName,
        FLUE_CLI_TARGET: 'agent',
        FLUE_INTERNAL_CLI_IPC: '1',
        FLUE_MODE: 'local',
        LAVALAMP_SERVER_PATH: this.serverPath,
        LAVALAMP_WORKSPACE: this.cwd,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    if (this.child.stdout !== null) {
      this.child.stdout.on('data', (data: Buffer) => {
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
          if (trimmed.startsWith('{') || trimmed.startsWith('}')) {
            continue;
          }
          if (/^\w+:/.test(trimmed) || trimmed.startsWith('[')) {
            continue;
          }
        }
      });
    }

    if (this.child.stderr !== null) {
      this.child.stderr.on('data', (data: Buffer) => {
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
          if (trimmed.startsWith('{') || trimmed.startsWith('}')) {
            continue;
          }
          if (/^\w+:/.test(trimmed) || trimmed.startsWith('[')) {
            continue;
          }
        }
      });
    }

    this.child.on('exit', (code) => {
      const wasReady = this.ready;
      this.ready = false;
      if (!wasReady) {
        this.rejectAll(new Error(`Server exited before ready (code ${code})`));
        return;
      }
      if (!this.shutdownRequested) {
        this.rejectAll(new Error(`Server exited unexpectedly (code ${code})`));
      }
    });
    this.child.on('message', this.handleChildMessage);

    await this.waitForReady(instanceId);
  }

  private async waitForReady(instanceId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        if (this.child !== null) {
          this.child.kill('SIGTERM');
        }
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
        if (this.child !== null) {
          this.child.off('message', onMessage);
          this.child.off('exit', onExit);
        }
      };

      if (this.child !== null) {
        this.child.on('message', onMessage);
        this.child.once('exit', onExit);
      }
    });
  }

  prompt(
    message: string,
    callbacks: PromptCallbacks = {},
    sessionId?: string,
    images?: PromptImage[],
  ): string {
    if (!this.child || !this.ready) {
      throw new Error('Server not started');
    }

    const requestId = `req_${randomUUID()}`;
    this.pending.set(requestId, callbacks);

    try {
      this.child.send({
        images: images ?? undefined,
        message,
        requestId,
        sessionId,
        type: 'prompt',
      });
    } catch (error) {
      this.pending.delete(requestId);
      throw error;
    }

    return requestId;
  }

  cancel(): void {
    this.rejectAll(new Error('Cancelled'));
    if (this.child) {
      this.child.off('message', this.handleChildMessage);
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
    if (this.child !== null) {
      this.child.off('message', this.handleChildMessage);
      this.child.kill('SIGTERM');
    }

    await new Promise<void>((resolve) => {
      if (this.child === null) {
        return resolve();
      }
      const timeout = setTimeout(() => {
        if (this.child !== null) {
          this.child.kill('SIGKILL');
        }
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
      if (cbs.onError != null) {
        cbs.onError(error);
      }
      this.pending.delete(id);
    }
  }
}
