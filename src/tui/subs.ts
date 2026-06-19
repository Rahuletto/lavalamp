import { FlueProcess, type FlueEvent } from './ipc';
import type { SubAgent } from './state';

export class SubAgentManager {
  private subs = new Map<string, SubAgent & { process: FlueProcess }>();
  private seq = 0;

  onUpdate?: (subs: SubAgent[]) => void;
  onAllComplete?: (summary: string) => void;

  constructor(
    private serverPath: string,
    private cwd: string,
    private agentName = 'build',
  ) {}

  async deploy(queries: string[]): Promise<void> {
    for (const query of queries.slice(0, 3)) {
      const id = `sub-${++this.seq}`;
      const process = new FlueProcess(this.serverPath, this.cwd, this.agentName);
      const sub: SubAgent & { process: FlueProcess } = {
        id,
        query,
        status: 'running',
        result: '',
        startTime: Date.now(),
        process,
      };
      this.subs.set(id, sub);
      this.emitUpdate();
      this.run(sub).catch((error) => this.fail(sub, error));
    }
  }

  kill(id: string): void {
    const sub = this.subs.get(id);
    if (!sub) return;
    sub.process.cancel();
    sub.status = 'killed';
    this.emitUpdate();
    this.checkComplete();
  }

  killAll(): void {
    for (const sub of this.subs.values()) this.kill(sub.id);
  }

  getActive(): SubAgent[] {
    return this.list().filter((sub) => sub.status === 'running');
  }

  list(): SubAgent[] {
    return Array.from(this.subs.values()).map(({ process, ...sub }) => sub);
  }

  isDeploying(): boolean {
    return this.getActive().length > 0;
  }

  private async run(sub: SubAgent & { process: FlueProcess }): Promise<void> {
    await sub.process.start();
    sub.pid = sub.process.pid;
    this.emitUpdate();

    const prompt = `Research the following and provide a detailed, structured summary: ${sub.query}\n\nFocus on: factual accuracy, key findings, relevant code references, and actionable insights.`;
    const timeout = setTimeout(() => {
      if (sub.status === 'running') {
        sub.status = 'timed_out';
        sub.process.cancel();
        this.emitUpdate();
        this.checkComplete();
      }
    }, 5 * 60_000);

    sub.process.prompt(prompt, {
      onEvent: (event: FlueEvent) => {
        if (event.type === 'text_delta') {
          sub.result = (sub.result ?? '') + (event.text ?? event.delta ?? '');
          this.emitUpdate();
        }
      },
      onResult: () => {
        clearTimeout(timeout);
        sub.status = 'done';
        sub.process.shutdown().catch(() => {});
        this.emitUpdate();
        this.checkComplete();
      },
      onError: (error) => {
        clearTimeout(timeout);
        this.fail(sub, error);
      },
    });
  }

  private fail(sub: SubAgent & { process: FlueProcess }, error: unknown): void {
    if (sub.status !== 'running') return;
    sub.status = 'failed';
    sub.error = error instanceof Error ? error.message : String(error);
    sub.process.shutdown().catch(() => {});
    this.emitUpdate();
    this.checkComplete();
  }

  private checkComplete(): void {
    if (this.subs.size === 0 || this.isDeploying()) return;
    const subs = this.list();
    const summary = subs.every((sub) => sub.status !== 'done')
      ? `## Research Results\n\nAll parallel research agents failed or were stopped.`
      : `## Research Results\n\n${subs.map((sub, i) => `### Query ${i + 1}: ${sub.query}\n\n${sub.result?.trim() || `(${sub.status}${sub.error ? `: ${sub.error}` : ''})`}`).join('\n\n')}`;
    this.onAllComplete?.(summary);
  }

  private emitUpdate(): void {
    this.onUpdate?.(this.list());
  }
}
