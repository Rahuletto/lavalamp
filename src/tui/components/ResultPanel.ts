import type { CliRenderer } from "@opentui/core";

interface ResultPanelContext {
  renderer: CliRenderer;
  inputField: { focus: () => void };
  addInfoLine: (content: string, fg?: string) => void;
}

export class ResultPanelManager {
  constructor(private readonly ctx: ResultPanelContext) {}

  // eslint-disable-next-line class-methods-use-this
  isVisible(): boolean {
    return false;
  }

  show(_title: string, rows: { content: string; fg?: string; bold?: boolean }[]): void {
    for (const row of rows) {
      this.ctx.addInfoLine(row.content, row.fg);
    }
    this.ctx.inputField.focus();
  }

  hide(): void {
    this.ctx.inputField.focus();
  }
}
