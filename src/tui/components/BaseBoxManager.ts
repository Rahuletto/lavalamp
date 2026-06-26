import { BoxRenderable, TextAttributes, TextRenderable } from '@opentui/core';
import type { CliRenderer, Renderable, StyledText } from '@opentui/core';

export interface BaseBoxContext {
  renderer: CliRenderer;
  root: Renderable;
  nextId: () => string;
}

export abstract class BaseBoxManager<T = boolean> {
  public box: BoxRenderable;
  protected title: TextRenderable;
  protected body: BoxRenderable;
  protected resolver: ((choice: T) => void) | null = null;
  protected timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    protected readonly ctx: BaseBoxContext,
    boxId: string,
    borderColor: string,
  ) {
    this.box = new BoxRenderable(ctx.renderer, {
      borderColor,
      borderStyle: 'single',
      flexDirection: 'column',
      flexShrink: 0,
      id: boxId,
      paddingBottom: 0,
      paddingLeft: 1,
      paddingRight: 1,
      paddingTop: 0,
      visible: false,
      width: '100%',
    });

    this.title = new TextRenderable(ctx.renderer, {
      attributes: TextAttributes.BOLD,
      content: '',
      fg: borderColor,
      height: 1,
      id: ctx.nextId(),
      width: '100%',
    });

    this.body = new BoxRenderable(ctx.renderer, {
      flexDirection: 'column',
      id: `${boxId}-body`,
      width: '100%',
    });

    this.box.add(this.title);
    this.box.add(this.body);
    ctx.root.add(this.box);
  }

  isVisible(): boolean {
    return this.box.visible;
  }

  protected clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  protected abstract getDefaultValue(): T;

  hide(choice: T = this.getDefaultValue()): void {
    this.box.visible = false;
    for (const child of this.body.getChildren()) {
      child.destroy();
    }
    this.title.content = '';
    this.clearTimer();
    if (this.resolver) {
      const resolve = this.resolver;
      this.resolver = null;
      resolve(choice);
    }
  }

  protected populateRows(
    rows: { content: string | StyledText; fg?: string }[],
  ): void {
    for (const child of this.body.getChildren()) {
      child.destroy();
    }
    for (const row of rows) {
      this.body.add(
        new TextRenderable(this.ctx.renderer, {
          content: row.content,
          fg: row.fg,
          id: this.ctx.nextId(),
          width: '100%',
        }),
      );
    }
  }
}
