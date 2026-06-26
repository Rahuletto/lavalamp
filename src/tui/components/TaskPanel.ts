import { TextRenderable } from "@opentui/core";
import { COLORS } from "../theme";
import type { Task } from "../state";
import { BasePanelManager } from './BasePanelManager';
import type { BasePanelContext } from './BasePanelManager';

export class TaskPanelManager extends BasePanelManager {
  constructor(ctx: BasePanelContext) {
    super(ctx, "task-box", COLORS.accent, " tasks");
  }

  refresh(tasks: Task[]): void {
    this.clearBody();
    if (tasks.length === 0) {
      this.hide();
      return;
    }
    const icon: Record<string, string> = {
      completed: "[x]",
      in_progress: "[>]",
      pending: "[ ]",
      skipped: "[-]",
    };
    for (const task of tasks) {
      const ico = icon[task.status] ?? "[?]";
      let color: string = COLORS.white;
      if (task.status === "completed") {
        color = COLORS.dim;
      } else if (task.status === "in_progress") {
        color = COLORS.accent;
      } else if (task.status === "skipped") {
        color = COLORS.dim;
      }
      this.body.add(
        new TextRenderable(this.ctx.renderer, {
          content: `  ${ico} #${task.id} ${task.title}`,
          fg: color,
          id: this.ctx.nextId(),
          width: "100%",
        }),
      );
    }
    this.show();
  }
}
