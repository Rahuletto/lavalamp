import { TextAttributes, TextRenderable } from '@opentui/core';
import type {
  CliRenderer,
  ScrollBoxRenderable,
  BoxRenderable,
} from '@opentui/core';
import { COLORS } from '../theme';

interface ResultPanelContext {
  renderer: CliRenderer;
  nextId: () => string;
  resultBox: BoxRenderable;
  resultTitle: TextRenderable;
  resultScroll: ScrollBoxRenderable;
  messagesScroll: ScrollBoxRenderable;
  inputField: { focus: () => void };
}

export class ResultPanelManager {
  constructor(private readonly ctx: ResultPanelContext) {}

  isVisible(): boolean {
    return this.ctx.resultBox.visible;
  }

  show(
    title: string,
    rows: { content: string; fg?: string; bold?: boolean }[],
  ): void {
    for (const child of this.ctx.resultScroll.getChildren()) {
      child.destroy();
    }
    this.ctx.resultTitle.content = ` ${title}`;
    this.ctx.resultTitle.fg = COLORS.white;
    for (const row of rows) {
      this.ctx.resultScroll.add(
        new TextRenderable(this.ctx.renderer, {
          attributes: row.bold ? TextAttributes.BOLD : TextAttributes.NONE,
          content: row.content,
          fg: row.fg ?? COLORS.gray,
          id: this.ctx.nextId(),
          width: '100%',
        }),
      );
    }
    this.ctx.resultBox.visible = true;
    this.ctx.messagesScroll.flexGrow = 0;
    this.ctx.resultScroll.scrollTo(0);
  }

  hide(): void {
    this.ctx.resultBox.visible = false;
    this.ctx.messagesScroll.flexGrow = 1;
    for (const child of this.ctx.resultScroll.getChildren()) {
      child.destroy();
    }
    this.ctx.inputField.focus();
  }
}
