import { BoxRenderable, TextAttributes, TextRenderable } from "@opentui/core";
import type { CliRenderer, Renderable } from "@opentui/core";

export interface BasePanelContext {
  renderer: CliRenderer;
  root: Renderable;
  nextId: () => string;
}

export abstract class BasePanelManager {
  public box: BoxRenderable;
  protected body: BoxRenderable;
  protected title?: TextRenderable;

  constructor(
    protected readonly ctx: BasePanelContext,
    boxId: string,
    borderColor: string,
    titleContent?: string,
  ) {
    this.box = new BoxRenderable(ctx.renderer, {
      borderColor,
      borderStyle: "single",
      flexDirection: "column",
      flexShrink: 0,
      id: boxId,
      paddingBottom: 0,
      paddingLeft: 1,
      paddingRight: 1,
      paddingTop: 0,
      visible: false,
      width: "100%",
    });

    if (titleContent !== null && titleContent !== undefined && titleContent !== '') {
      this.title = new TextRenderable(ctx.renderer, {
        attributes: TextAttributes.BOLD,
        content: titleContent,
        fg: borderColor,
        height: 1,
        id: `${boxId}-title`,
        width: "100%",
      });
      this.box.add(this.title);
    }

    this.body = new BoxRenderable(ctx.renderer, {
      flexDirection: "column",
      id: `${boxId}-body`,
      width: "100%",
    });

    this.box.add(this.body);
    ctx.root.add(this.box);
  }

  show(): void {
    this.box.visible = true;
  }

  hide(): void {
    this.box.visible = false;
  }

  isVisible(): boolean {
    return this.box.visible;
  }

  protected clearBody(): void {
    for (const child of this.body.getChildren()) {
      child.destroy();
    }
  }
}
