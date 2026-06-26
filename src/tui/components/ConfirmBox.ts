import { COLORS } from "../theme";
import { BaseBoxManager } from './BaseBoxManager';
import type { BaseBoxContext } from './BaseBoxManager';

export class ConfirmBoxManager extends BaseBoxManager {
  private confirmAcceptReturn = false;
  private confirmAcceptCtrlC = true;

  constructor(ctx: BaseBoxContext) {
    super(ctx, "confirm-box", COLORS.warn);
  }

  // eslint-disable-next-line class-methods-use-this
  protected getDefaultValue(): boolean {
    return false;
  }

  getAcceptReturn(): boolean {
    return this.confirmAcceptReturn;
  }

  getAcceptCtrlC(): boolean {
    return this.confirmAcceptCtrlC;
  }

  show(
    title: string,
    rows: { content: string; fg?: string }[],
    resolve: (choice: boolean) => void,
    timeoutMs = 2000,
    acceptReturn = false,
    acceptCtrlC = true,
  ): void {
    this.title.content = ` ${title}`;
    const styledRows = rows.map((r) => ({
      content: r.content,
      fg: r.fg ?? COLORS.gray,
    }));
    this.populateRows(styledRows);

    this.box.visible = true;
    this.resolver = resolve;
    this.confirmAcceptReturn = acceptReturn;
    this.confirmAcceptCtrlC = acceptCtrlC;

    this.clearTimer();
    this.timer = setTimeout(() => {
      if (this.isVisible()) {this.hide(false);}
    }, timeoutMs);
  }
}
