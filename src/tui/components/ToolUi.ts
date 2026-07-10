import {
  BoxRenderable,
  CodeRenderable,
  DiffRenderable,
  TextRenderable,
} from '@opentui/core';
import type { CliRenderer, ScrollBoxRenderable } from '@opentui/core';
import { COLORS } from '../theme';
import { codeSyntaxStyle } from '../art';
import {
  EXT_LANG_MAP,
  detectLanguage,
  generateSyntheticDiff,
  looksLikeDiff,
  stripCwd,
} from '../tools';

export interface ToolGroupEntry {
  summary: string;
  toolName: string;
  args: Record<string, unknown>;
  result: string;
  isError: boolean;
  durationMs?: number;
  contentVisible: boolean;
  contentBox: BoxRenderable;
  headerLabel: TextRenderable;
}

export interface ToolGroup {
  box: BoxRenderable;
  toolName: string;
  entries: ToolGroupEntry[];
  headerLabel: TextRenderable;
  contentBox: BoxRenderable;
}

export interface ToolUiContext {
  renderer: CliRenderer;
  cwd: string;
  nextId: () => string;
  hideLavaLamp: () => void;
  requestScroll: () => void;
  messagesScroll: ScrollBoxRenderable;
  storedDiffs: Map<string, { diff: string; filePath: string }>;
}

export class ToolUiManager {
  private toolGroup: ToolGroup | null = null;

  constructor(private readonly ctx: ToolUiContext) {}

  getActiveGroup(): ToolGroup | null {
    return this.toolGroup;
  }

  /**
   * Stream live bash output into an entry's content box. Creates a streaming
   * text renderable on first chunk, updates it on subsequent chunks, and makes
   * the content visible so the user sees output in real time.
   */
  private streamBuffers = new WeakMap<ToolGroupEntry, { text: string; renderable: TextRenderable }>();

  streamToEntry(entry: ToolGroupEntry, chunk: string, _stream: 'stdout' | 'stderr'): void {
    let buf = this.streamBuffers.get(entry);
    if (!buf) {
      const renderable = new TextRenderable(this.ctx.renderer, {
        content: '',
        fg: COLORS.dim,
        id: this.ctx.nextId(),
        width: '100%',
      });
      entry.contentBox.add(renderable);
      entry.contentBox.visible = true;
      entry.contentVisible = true;
      const cur = getTextContent(entry.headerLabel.content);
      entry.headerLabel.content = cur.replace(/\u25B8$/, '\u25BC');
      buf = { renderable, text: '' };
      this.streamBuffers.set(entry, buf);
    }
    buf.text += chunk;
    // Show last N lines to avoid unbounded growth during long commands
    const lines = buf.text.split('\n');
    const MAX_LINES = 200;
    const visible = lines.length > MAX_LINES
      ? `  ... (${lines.length - MAX_LINES} lines above)\n${lines.slice(-MAX_LINES).join('\n')}`
      : buf.text;
    buf.renderable.content = visible;
    this.ctx.requestScroll();
  }

  clearActiveGroup(): void {
    this.toolGroup = null;
  }

  finalizeToolGroup(): void {
    if (!this.toolGroup) {
      return;
    }
    const grp = this.toolGroup;
    const n = grp.entries.length;
    grp.headerLabel.content = `\u2713 ${grp.toolName} \u00D7${n} \u25B8`;
    grp.headerLabel.fg = grp.entries.some((e) => e.isError)
      ? COLORS.red
      : COLORS.green;
    this.toolGroup = null;
  }

  getOrCreateToolGroup(name: string): ToolGroup {
    if (this.toolGroup && this.toolGroup.toolName === name) {
      return this.toolGroup;
    }
    if (this.toolGroup) {
      this.finalizeToolGroup();
    }

    this.ctx.hideLavaLamp();
    const groupId = this.ctx.nextId();
    const entries: ToolGroupEntry[] = [];

    const box = new BoxRenderable(this.ctx.renderer, {
      flexDirection: 'column',
      id: groupId,
      width: '100%',
    });

    const hdr = new BoxRenderable(this.ctx.renderer, {
      flexDirection: 'row',
      focusable: true,
      id: this.ctx.nextId(),
      onMouseDown: () => {
        const content = box.getRenderable('group-content');
        if (content) {
          content.visible = !content.visible;
          const n = entries.length;
          headerLabel.content = content.visible
            ? `\u2713 ${name} \u00D7${n} \u25BC`
            : `\u2713 ${name} \u00D7${n} \u25B8`;
        }
      },
      width: '100%',
    });

    const headerLabel = new TextRenderable(this.ctx.renderer, {
      content: `\u2713 ${name} \u00D70 \u25B8`,
      fg: COLORS.dim,
      id: this.ctx.nextId(),
      width: '100%',
    });

    hdr.add(headerLabel);
    box.add(hdr);

    const contentBox = new BoxRenderable(this.ctx.renderer, {
      flexDirection: 'column',
      id: 'group-content',
      paddingLeft: 2,
      visible: false,
      width: '100%',
    });

    box.add(contentBox);
    this.ctx.messagesScroll.add(box);

    this.toolGroup = { box, contentBox, entries, headerLabel, toolName: name };
    return this.toolGroup;
  }

  addToolGroupEntry(
    name: string,
    summary: string,
    args: Record<string, unknown>,
  ): ToolGroupEntry {
    const grp = this.getOrCreateToolGroup(name);

    const entry: ToolGroupEntry = {
      args,
      contentBox: new BoxRenderable(this.ctx.renderer, {
        flexDirection: 'column',
        id: this.ctx.nextId(),
        paddingLeft: 1,
        visible: false,
        width: '100%',
      }),
      contentVisible: false,
      headerLabel: new TextRenderable(this.ctx.renderer, {
        content: `> ${summary} \u25B8`,
        fg: COLORS.dim,
        id: this.ctx.nextId(),
        width: '100%',
      }),
      isError: false,
      result: '',
      summary,
      toolName: name,
    };

    const entryHdr = new BoxRenderable(this.ctx.renderer, {
      flexDirection: 'row',
      focusable: true,
      id: this.ctx.nextId(),
      onMouseDown: () => {
        entry.contentVisible = !entry.contentVisible;
        entry.contentBox.visible = entry.contentVisible;
        entry.headerLabel.content = entry.contentVisible
          ? `> ${summary} \u25BC`
          : `> ${summary} \u25B8`;
      },
      width: '100%',
    });

    entryHdr.add(entry.headerLabel);
    grp.contentBox.add(entryHdr);
    grp.contentBox.add(entry.contentBox);
    grp.entries.push(entry);

    grp.headerLabel.content = `\u2713 ${name} \u00D7${grp.entries.length} \u25B8`;

    return entry;
  }

  populateToolEntryContent(
    entry: ToolGroupEntry,
    toolName: string,
    args: Record<string, unknown>,
    resultStr: string,
    isError: boolean,
    durationMs?: number,
  ): void {
    const fp =
      typeof args.file_path === 'string'
        ? args.file_path
        : typeof args.path === 'string'
          ? args.path
          : '';
    const displayPath = stripCwd(fp, this.ctx.cwd);
    const dur =
      durationMs !== null && durationMs !== undefined
        ? ` (${durationMs}ms)`
        : '';

    entry.headerLabel.fg = isError ? COLORS.red : COLORS.green;
    entry.headerLabel.content = `> ${entry.summary}${dur} \u25B8`;
    if (toolName === 'edit' || toolName === 'write' || toolName === 'patch') {
      let diffStr = looksLikeDiff(resultStr) ? resultStr : '';
      if (
        !diffStr &&
        toolName === 'edit' &&
        typeof args.oldText === 'string' &&
        typeof args.newText === 'string'
      ) {
        diffStr = generateSyntheticDiff(
          displayPath,
          args.oldText,
          args.newText,
        );
      } else if (
        !diffStr &&
        toolName === 'write' &&
        typeof args.content === 'string'
      ) {
        diffStr = generateSyntheticDiff(displayPath, '', args.content);
      } else if (
        !diffStr &&
        typeof resultStr === 'string' &&
        resultStr.includes('\n')
      ) {
        diffStr = generateSyntheticDiff(displayPath, '', resultStr);
      }
      if (diffStr) {
        this.ctx.storedDiffs.set(displayPath, { diff: diffStr, filePath: fp });
      }
      entry.headerLabel.content = `\u2713 Edited${dur} \u25B8`;
      if (diffStr) {
        const ext = fp.split('.').pop() ?? '';
        const lang = EXT_LANG_MAP[ext];
        const diffLines = diffStr.split('\n').length;
        const diffComp = new DiffRenderable(this.ctx.renderer, {
          diff: diffStr,
          fg: COLORS.white,
          filetype: lang ?? undefined,
          height: diffLines,
          id: this.ctx.nextId(),
          lineNumberFg: COLORS.dim,
          showLineNumbers: true,
          syntaxStyle: codeSyntaxStyle,
          view: 'unified',
          width: '100%',
        });
        diffComp.selectable = true;
        entry.contentBox.add(diffComp);
        entry.contentBox.visible = false;
      }
    } else if (toolName === 'read') {
      if (resultStr && !isError) {
        const lang = detectLanguage(fp);
        const code = new CodeRenderable(this.ctx.renderer, {
          content: resultStr,
          filetype: lang,
          id: this.ctx.nextId(),
          selectable: true,
          syntaxStyle: codeSyntaxStyle,
          width: '100%',
        });
        entry.contentBox.add(code);
        entry.contentBox.visible = false;
      }
    } else {
      if (resultStr) {
        const resultLines = resultStr.trim().split('\n');
        const tail =
          resultLines.length > 30 ? resultLines.slice(-30) : resultLines;
        const preview = tail.length > 0 ? tail.join('\n') : '(no output)';
        const truncated =
          resultLines.length > 30
            ? `\n  ... (${resultLines.length - 30} lines above)`
            : '';
        entry.contentBox.add(
          new TextRenderable(this.ctx.renderer, {
            content: preview + truncated,
            fg: isError ? COLORS.red : COLORS.dim,
            id: this.ctx.nextId(),
            width: '100%',
          }),
        );
        entry.contentBox.visible = false;
      }
    }
    if (entry.contentBox.visible) {
      entry.contentVisible = true;
      const cur = getTextContent(entry.headerLabel.content);
      entry.headerLabel.content = cur.replace(/\u25B8$/, '\u25BC');
    } else {
      entry.contentVisible = false;
      const cur = getTextContent(entry.headerLabel.content);
      entry.headerLabel.content = cur.replace(/\u25BC$/, '\u25B8');
    }
  }
}

function getTextContent(val: unknown): string {
  if (typeof val === 'string') {
    return val;
  }
  if (
    val !== null &&
    val !== undefined &&
    typeof val === 'object' &&
    Array.isArray((val as Record<string, unknown>).chunks)
  ) {
    return ((val as Record<string, unknown>).chunks as { text?: string }[])
      .map((c) => c.text ?? '')
      .join('');
  }
  return String(val);
}
