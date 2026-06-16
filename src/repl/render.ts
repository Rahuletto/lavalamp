import type { FlueEvent } from './ipc';

const ACCENT = '\x1b[38;2;255;94;31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';

const THINK = '\x1b[38;2;100;100;100m';

export class EventRenderer {
  private textBuffer = '';
  private pendingTool: { name: string; args: Record<string, unknown> } | null = null;
  private wasThinking = false;

  constructor(private stream?: NodeJS.WriteStream) {}

  render(event: FlueEvent): void {
    switch (event.type) {
      case 'text_delta':
        if (this.wasThinking) {
          this.stream?.write('\n');
          this.wasThinking = false;
        }
        this.stream?.write(event.text ?? event.delta ?? '');
        this.textBuffer += event.text ?? event.delta ?? '';
        break;
      case 'thinking_delta':
        if (!this.wasThinking) this.wasThinking = true;
        this.stream?.write(`${THINK}${event.delta ?? event.content ?? ''}${RESET}`);
        break;
      case 'tool_start':
        this.flushText();
        this.handleToolStart(event);
        break;
      case 'tool':
        this.flushText();
        this.handleToolEnd(event);
        break;
      case 'turn':
        this.flushText();
        this.handleTurn(event);
        break;
      case 'idle':
        this.flushText();
        break;
      case 'compaction_start':
        this.flushText();
        this.stream?.write(`${DIM}  compacting context...${RESET}\n`);
        break;
      case 'compaction':
        this.stream?.write(`${DIM}  compacted: ${event.messagesBefore} -> ${event.messagesAfter} messages${RESET}\n`);
        break;
      case 'log':
        if (event.level === 'warn' || event.level === 'error') {
          this.stream?.write(`${DIM}  [${event.level}] ${event.message}${RESET}\n`);
        }
        break;
      case 'error':
        this.stream?.write(`${RED}  error: ${event.error ?? event.message ?? 'unknown'}${RESET}\n`);
        break;
    }
  }

  private flushText(): void {
    if (this.textBuffer) {
      this.stream?.write('\n');
      this.textBuffer = '';
    }
  }

  private handleToolStart(event: FlueEvent): void {
    this.pendingTool = { name: event.toolName ?? 'unknown', args: event.args ?? {} };
    const argsSummary = this.summarizeArgs(event.args ?? {});
    this.stream?.write(`${ACCENT}  > ${event.toolName}${RESET} ${DIM}${argsSummary}${RESET}\n`);
  }

  private handleToolEnd(event: FlueEvent): void {
    const icon = event.isError ? `${RED}x` : `${GREEN}\u2713`;
    const dur = event.durationMs != null ? ` ${DIM}(${event.durationMs}ms)${RESET}` : '';
    this.stream?.write(`${icon}  ${event.toolName}${dur}${RESET}\n`);
    this.pendingTool = null;
  }

  private handleTurn(event: FlueEvent): void {
    const dur = event.durationMs != null ? `${(event.durationMs / 1000).toFixed(1)}s` : '';
    const cost = event.usage?.cost?.total != null ? `$${event.usage.cost.total.toFixed(4)}` : '';
    const tokens = event.usage?.totalTokens != null ? `${event.usage.totalTokens} tok` : '';
    const model = event.model ?? '';
    const parts = [dur, tokens, cost, model].filter(Boolean);
    if (parts.length) {
      this.stream?.write(`${DIM}  ${parts.join(' | ')}${RESET}\n`);
    }
  }

  private summarizeArgs(args: Record<string, unknown>): string {
    const entries = Object.entries(args);
    if (!entries.length) return '';

    const parts: string[] = [];
    for (const [k, v] of entries.slice(0, 3)) {
      if (typeof v === 'string') {
        parts.push(v);
      } else if (typeof v === 'number' || typeof v === 'boolean') {
        parts.push(String(v));
      }
    }
    return parts.join(' ');
  }

  flush(): void {
    this.flushText();
    this.wasThinking = false;
    if (this.pendingTool) {
      this.stream?.write(`${YELLOW}  ~ ${this.pendingTool.name} (interrupted)${RESET}\n`);
      this.pendingTool = null;
    }
  }
}
