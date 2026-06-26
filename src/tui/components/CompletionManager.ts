import { BoxRenderable, TextAttributes, TextRenderable } from '@opentui/core';
import type { CliRenderer, ScrollBoxRenderable } from '@opentui/core';
import { COLORS } from '../theme';
import { ALL_SLASH_COMMANDS, SLASH_COMMAND_DESCRIPTIONS } from '../art';
import { discoverSkills, fuzzySearch, walkFiles } from '../discover';
import { listSessions } from '../sessions';

interface CompletionContext {
  renderer: CliRenderer;
  cwd: string;
  completionBox: BoxRenderable;
  completionScroll: ScrollBoxRenderable;
  inputSeparatorTop: TextRenderable;
  inputField: {
    focus: () => void;
    plainText: string;
    setText: (text: string) => void;
    cursorOffset: number;
  };
  accent: () => string;
  nextId: () => string;
}

export class CompletionManager {
  private completing = false;
  private completionList: string[] = [];
  private completionIndex = 0;
  private completionType: 'slash' | 'at' | 'hash' | 'session' | null = null;
  private completionBaseCol = 0;
  private fileCache: string[] | null = null;
  private skillCache: string[] | null = null;

  constructor(private readonly ctx: CompletionContext) {}

  isCompleting(): boolean {
    return this.completing;
  }

  getCompletionList(): string[] {
    return this.completionList;
  }

  getCompletionIndex(): number {
    return this.completionIndex;
  }

  setCompletionIndex(idx: number): void {
    this.completionIndex = idx;
  }

  private getFiles(): string[] {
    this.fileCache ??= walkFiles(this.ctx.cwd);
    return this.fileCache;
  }

  private getSkills(): string[] {
    this.skillCache ??= discoverSkills(this.ctx.cwd);
    return this.skillCache;
  }

  trigger(): void {
    const before = this.ctx.inputField.plainText;
    const slashIdx = before.lastIndexOf('/');
    if (slashIdx !== -1) {
      const afterSlash = before.slice(slashIdx + 1);
      if (
        (slashIdx === 0 || before[slashIdx - 1] === ' ') &&
        !afterSlash.includes(' ')
      ) {
        this.completionType = 'slash';
        this.completionBaseCol = slashIdx;
        this.completionList = fuzzySearch(
          afterSlash.toLowerCase(),
          ALL_SLASH_COMMANDS,
        ).map((r) => r.item);
        this.completionIndex = 0;
        if (this.completionList.length > 0) {
          this.completing = true;
          this.render();
        } else {
          this.hide();
        }
        return;
      }
    }
    const sessionMatch = /(?:\$\{|\$)([^\s}]*)$/.exec(before);
    if (sessionMatch) {
      this.completionType = 'session';
      this.completionBaseCol = before.lastIndexOf('$');
      const sessions = listSessions();
      const query = (sessionMatch[1] ?? '').replace(/^{/, '').toLowerCase();
      const matchedSessions = sessions.filter(
        (s) =>
          s.id.toLowerCase().includes(query) ||
          s.name.toLowerCase().includes(query),
      );
      this.completionList = matchedSessions.map((s) => s.id);
      this.completionIndex = 0;
      if (this.completionList.length > 0) {
        this.completing = true;
        this.render();
      } else {
        this.hide();
      }
      return;
    }
    const atMatch = /@([^\s]*)$/.exec(before);
    if (atMatch) {
      this.completionType = 'at';
      this.completionBaseCol = before.lastIndexOf('@');
      this.completionList = fuzzySearch(
        (atMatch[1] ?? '').toLowerCase(),
        this.getFiles(),
      ).map((r) => r.item);
      this.completionIndex = 0;
      if (this.completionList.length > 0) {
        this.completing = true;
        this.render();
      } else {
        this.hide();
      }
      return;
    }
    const hashMatch = /(?:^|\s)#([^\s]*)$/.exec(before);
    if (hashMatch) {
      this.completionType = 'hash';
      this.completionBaseCol = before.lastIndexOf('#');
      this.completionList = fuzzySearch(
        (hashMatch[1] ?? '').toLowerCase(),
        this.getSkills(),
      ).map((r) => r.item);
      this.completionIndex = 0;
      if (this.completionList.length > 0) {
        this.completing = true;
        this.render();
      } else {
        this.hide();
      }
      return;
    }
    if (this.completing) {
      this.hide();
    }
  }

  render(): void {
    for (const child of this.ctx.completionScroll.getChildren()) {
      child.destroy();
    }
    const spacer = new BoxRenderable(this.ctx.renderer, {
      height: 1,
      id: this.ctx.nextId(),
      width: '100%',
    });
    this.ctx.completionScroll.add(spacer);
    for (let i = 0; i < this.completionList.length; i++) {
      const sel = i === this.completionIndex;
      const row = new BoxRenderable(this.ctx.renderer, {
        backgroundColor: sel ? `${this.ctx.accent()}20` : undefined,
        flexDirection: 'row',
        height: 1,
        id: this.ctx.nextId(),
        width: '100%',
      });
      let displayText = ` ${this.completionList[i]}`;
      let typeText = '';
      if (this.completionType === 'session') {
        const sess = listSessions().find(
          (s) => s.id === this.completionList[i],
        );
        if (sess) {
          displayText = ` ${sess.name}`;
          typeText = sess.id;
        }
      }
      row.add(
        new TextRenderable(this.ctx.renderer, {
          attributes: sel ? TextAttributes.BOLD : TextAttributes.NONE,
          content: displayText,
          fg: sel ? this.ctx.accent() : COLORS.gray,
          flexGrow: 1,
          id: this.ctx.nextId(),
          overflow: 'hidden',
        }),
      );
      if (
        this.completionType === 'slash' ||
        this.completionType === 'session'
      ) {
        row.add(
          new TextRenderable(this.ctx.renderer, {
            content:
              this.completionType === 'slash'
                ? (SLASH_COMMAND_DESCRIPTIONS[this.completionList[i] ?? ''] ??
                  '')
                : this.completionType === 'session'
                  ? typeText
                  : 'tool',
            fg: COLORS.dim,
            id: this.ctx.nextId(),
            overflow: 'hidden',
            width: 26,
          }),
        );
      }
      this.ctx.completionScroll.add(row);
    }
    this.ctx.completionScroll.scrollTo(this.completionIndex);
    this.ctx.completionBox.visible = true;
    this.ctx.inputSeparatorTop.visible = false;
  }

  hide(): void {
    this.completing = false;
    this.ctx.completionBox.visible = false;
    this.ctx.inputSeparatorTop.visible = true;
    for (const child of this.ctx.completionScroll.getChildren()) {
      child.destroy();
    }
  }

  accept(): void {
    const selected = this.completionList[this.completionIndex];
    if (selected === null || selected === undefined) {
      this.hide();
      return;
    }
    const before = this.ctx.inputField.plainText;
    if (this.completionType === 'slash') {
      this.ctx.inputField.setText(`${selected} `);
    } else if (this.completionType === 'session') {
      const prefix = before.slice(0, this.completionBaseCol);
      this.ctx.inputField.setText(`${prefix}$${selected} `);
    } else {
      const triggerIdx = this.completionBaseCol;
      const prefix = before.slice(0, triggerIdx);
      const prefixChar = this.completionType === 'hash' ? '#' : '@';
      this.ctx.inputField.setText(`${prefix + prefixChar + selected} `);
    }
    this.ctx.inputField.cursorOffset = this.ctx.inputField.plainText.length;
    this.hide();
  }

  clearCache(): void {
    this.fileCache = null;
    this.skillCache = null;
  }

  getSkillsCached(): string[] {
    return this.getSkills();
  }
}
