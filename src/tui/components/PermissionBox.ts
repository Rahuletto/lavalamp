import { COLORS } from '../theme';
import type { PermissionRequestMsg } from '../ipc';
import { styleBashCommand } from './Utils';
import { stripCwd } from '../tools';
import { BaseBoxManager } from './BaseBoxManager';
import type { BaseBoxContext } from './BaseBoxManager';
import type { StyledText } from '@opentui/core';

interface PermissionBoxContext extends BaseBoxContext {
  cwd: string;
}

export class PermissionBoxManager extends BaseBoxManager<
  'allow' | 'deny' | 'always'
> {
  constructor(private readonly permissionCtx: PermissionBoxContext) {
    super(permissionCtx, 'permission-box', COLORS.yellow);
  }

  // eslint-disable-next-line class-methods-use-this
  protected getDefaultValue(): 'allow' | 'deny' | 'always' {
    return 'deny';
  }

  async show(
    request: PermissionRequestMsg,
  ): Promise<'allow' | 'deny' | 'always'> {
    this.title.content = ' Permission Required';

    const rows: { content: string | StyledText; fg?: string }[] = [
      { content: `  Tool: ${request.toolName}`, fg: COLORS.white },
    ];

    if (
      request.toolName === 'bash' &&
      typeof request.args.command === 'string'
    ) {
      rows.push(
        { content: '  Command:', fg: COLORS.white },
        {
          content: styleBashCommand(request.args.command),
          fg: COLORS.white,
        },
      );
    } else if (
      (request.toolName === 'write' ||
        request.toolName === 'edit' ||
        request.toolName === 'patch') &&
      typeof request.args.file_path === 'string'
    ) {
      rows.push({
        content: `  File: ${stripCwd(request.args.file_path, this.permissionCtx.cwd)}`,
        fg: COLORS.green,
      });
    } else {
      const keys = Object.keys(request.args);
      if (keys.length > 0) {
        rows.push({ content: '  Args:', fg: COLORS.gray });
        for (const [k, v] of Object.entries(request.args)) {
          const valStr =
            typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
          const truncatedVal =
            valStr.length > 100 ? `${valStr.slice(0, 97)}...` : valStr;
          rows.push({ content: `    ${k}: ${truncatedVal}`, fg: COLORS.gray });
        }
      }
    }

    rows.push(
      {
        content: '    [y] Allow    [n] Deny    [a] Always Allow Exact',
        fg: COLORS.warn,
      },
      { content: '', fg: COLORS.dim },
      {
        content: '    Escape to deny · Auto-deny in 30s',
        fg: COLORS.dim,
      },
    );

    const styledRows = rows.map((r) => ({
      content: r.content,
      fg: r.fg ?? COLORS.gray,
    }));
    this.populateRows(styledRows);

    this.box.visible = true;

    this.clearTimer();
    this.timer = setTimeout(() => {
      if (this.isVisible()) {
        this.hide('deny');
      }
    }, 30_000);

    return new Promise<'allow' | 'deny' | 'always'>((resolve) => {
      this.resolver = resolve;
    });
  }
}
