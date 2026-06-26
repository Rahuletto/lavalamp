import { TextRenderable } from '@opentui/core';
import { COLORS } from '../theme';
import type { SubAgent } from '../state';
import { BasePanelManager } from './BasePanelManager';
import type { BasePanelContext } from './BasePanelManager';

export class QueuePanelManager extends BasePanelManager {
  constructor(ctx: BasePanelContext) {
    super(ctx, 'queue-box', COLORS.border);
  }

  refresh(
    steerPending: string[],
    queuePending: string[],
    visiblePrompt: (prompt: string) => string,
  ): void {
    this.clearBody();
    const steerCount = steerPending.filter((s) => s.length > 0).length;
    const queueCount = queuePending.length;
    if (steerCount === 0 && queueCount === 0) {
      this.hide();
      return;
    }
    for (const prompt of steerPending) {
      if (!prompt) {
        continue;
      }
      const display = visiblePrompt(prompt);
      const preview =
        display.length > 60 ? `${display.slice(0, 57)}...` : display;
      this.body.add(
        new TextRenderable(this.ctx.renderer, {
          content: `\u2191 ${preview}`,
          fg: COLORS.green,
          id: this.ctx.nextId(),
          width: '100%',
        }),
      );
    }
    for (let i = 0; i < queuePending.length; i++) {
      const display = visiblePrompt(queuePending[i] ?? '');
      const preview =
        display.length > 60 ? `${display.slice(0, 57)}...` : display;
      this.body.add(
        new TextRenderable(this.ctx.renderer, {
          content: `#${i + 1} ${preview}`,
          fg: COLORS.yellow,
          id: this.ctx.nextId(),
          width: '100%',
        }),
      );
    }
    this.show();
  }
}

export class SubPanelManager extends BasePanelManager {
  constructor(ctx: BasePanelContext) {
    super(ctx, 'sub-box', COLORS.pink, ' subagents');
  }

  refresh(
    subAgents: SubAgent[],
    spinnerFrames: string[],
    spinnerFrame: number,
  ): void {
    this.clearBody();
    if (subAgents.length === 0) {
      this.hide();
      return;
    }
    for (const sub of subAgents) {
      const icon =
        sub.status === 'running'
          ? spinnerFrames[spinnerFrame]
          : (sub.status === 'done'
            ? '✓'
            : '×');
      const preview =
        sub.query.length > 70 ? `${sub.query.slice(0, 67)}...` : sub.query;
      this.body.add(
        new TextRenderable(this.ctx.renderer, {
          content: `  ${icon} ${sub.id} ${sub.status}: ${preview}`,
          fg:
            sub.status === 'running'
              ? COLORS.pink
              : (sub.status === 'done'
                ? COLORS.green
                : COLORS.red),
          id: this.ctx.nextId(),
          width: '100%',
        }),
      );
    }
    this.show();
  }
}
