import {
  BoxRenderable,
  MarkdownRenderable,
  TextAttributes,
  TextRenderable,
} from '@opentui/core';
import type { CliRenderer, ScrollBoxRenderable } from '@opentui/core';
import { syntaxStyle } from '../art';
import { COLORS } from '../theme';

interface MessageRenderContext {
  renderer: CliRenderer;
  messagesScroll: ScrollBoxRenderable;
  nextId: () => string;
  hideLavaLamp: () => void;
}

export class MessageRenderer {
  private userMessageCount = 0;

  constructor(private readonly ctx: MessageRenderContext) {}

  resetUserCount(): void {
    this.userMessageCount = 0;
  }

  addUser(content: string): void {
    this.ctx.hideLavaLamp();
    this.userMessageCount++;
    if (this.userMessageCount > 1) {
      this.addUserSeparator();
    }

    for (const [index, line] of content.split('\n').entries()) {
      const row = new BoxRenderable(this.ctx.renderer, {
        flexDirection: 'row',
        id: this.ctx.nextId(),
        width: '100%',
      });
      row.add(
        new TextRenderable(this.ctx.renderer, {
          attributes: index === 0 ? TextAttributes.BOLD : TextAttributes.NONE,
          content: '┃ ',
          fg: COLORS.blue,
          id: this.ctx.nextId(),
        }),
      );
      row.add(
        new TextRenderable(this.ctx.renderer, {
          content: `  ${line}`,
          fg: COLORS.blue,
          id: this.ctx.nextId(),
          selectable: true,
          width: '100%',
        }),
      );
      this.ctx.messagesScroll.add(row);
    }
  }

  addAssistantMarkdown(content: string): MarkdownRenderable {
    this.ctx.hideLavaLamp();
    const md = new MarkdownRenderable(this.ctx.renderer, {
      conceal: true,
      content,
      id: this.ctx.nextId(),
      syntaxStyle,
      width: '100%',
    });
    md.selectable = true;
    this.ctx.messagesScroll.add(md);
    return md;
  }

  addInfo(content: string, color?: string): TextRenderable {
    this.ctx.hideLavaLamp();
    const line = new TextRenderable(this.ctx.renderer, {
      content,
      fg: color ?? COLORS.dim,
      id: this.ctx.nextId(),
      width: '100%',
    });
    this.ctx.messagesScroll.add(line);
    return line;
  }

  createThinkingBlock(): BoxRenderable {
    const box = new BoxRenderable(this.ctx.renderer, {
      flexDirection: 'column',
      id: this.ctx.nextId(),
      width: '100%',
    });
    const hdr = new BoxRenderable(this.ctx.renderer, {
      flexDirection: 'row',
      focusable: true,
      id: this.ctx.nextId(),
      onMouseDown: () => {
        toggleThinkingBlock(box);
      },
      width: '100%',
    });
    hdr.add(createThinkingHeader(this.ctx.renderer, this.ctx.nextId));
    box.add(hdr);
    box.add(
      new TextRenderable(this.ctx.renderer, {
        content: '',
        fg: COLORS.dim,
        id: 'thinking-content',
        visible: true,
        width: '100%',
      }),
    );
    return box;
  }

  finalizeThinkingBlock(block: BoxRenderable, text: string): boolean {
    if (isInternalThinkingDump(text) || !text) {
      this.ctx.messagesScroll.remove(block.id);
      block.destroy();
      return false;
    }
    const contentEl = block.getRenderable('thinking-content');
    if (contentEl && contentEl instanceof TextRenderable) {
      contentEl.content = text;
      contentEl.visible = false;
    }
    setThinkingHeader(block, 'Reasoning... ▸', COLORS.link);
    return true;
  }

  private addUserSeparator(): void {
    this.ctx.messagesScroll.add(
      new TextRenderable(this.ctx.renderer, {
        content: '',
        height: 1,
        id: this.ctx.nextId(),
        width: '100%',
      }),
    );
    this.ctx.messagesScroll.add(
      new TextRenderable(this.ctx.renderer, {
        content: '─'.repeat(60),
        fg: COLORS.dim,
        id: this.ctx.nextId(),
        width: '100%',
      }),
    );
  }
}

function createThinkingHeader(
  renderer: CliRenderer,
  nextId: () => string,
): TextRenderable {
  return new TextRenderable(renderer, {
    content: 'Reasoning... ▸',
    fg: COLORS.link,
    id: nextId(),
  });
}

function toggleThinkingBlock(block: BoxRenderable): void {
  const content = block.getRenderable('thinking-content');
  if (!content) {
    return;
  }
  content.visible = !content.visible;
  setThinkingHeader(
    block,
    content.visible ? 'Reasoning... ▼' : 'Reasoning... ▸',
    COLORS.link,
  );
}

function setThinkingHeader(
  block: BoxRenderable,
  content: string,
  fg: string,
): void {
  const hdr = block
    .getChildren()
    .find((child) => child instanceof BoxRenderable);
  // oxlint-disable-next-line oxc/no-optional-chaining
  const label = hdr
    ?.getChildren()
    .find((child) => child instanceof TextRenderable);
  if (label && label instanceof TextRenderable) {
    label.content = content;
    label.fg = fg;
  }
}

function isInternalThinkingDump(text: string): boolean {
  return (
    /\[flue:|FlueError|throwIfError|normalizeLogAttributes|OperationFailedError|operation_failed|CallOverrides|persisted-image/.test(
      text,
    ) || /^\}\s*\d+\s*\|/m.test(text)
  );
}
