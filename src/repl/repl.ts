import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { FlueProcess, type FlueResult, type FlueEvent } from './ipc';
import { EventRenderer } from './render';

const ACCENT = '\x1b[38;2;255;94;31m';
const PLAN_ACCENT = '\x1b[38;2;45;212;191m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const GRAY = '\x1b[90m';
const CYAN = '\x1b[36m';

const PROMPT_VIS = 2;

const ALL_SLASH_COMMANDS = ['/help', '/clear', '/compact', '/sessions', '/memory', '/model', '/workspace', '/skills', '/mcp', '/tools', '/plan', '/copy', '/undo', '/quit'];

interface Key {
  name: string;
  shift?: boolean;
  ctrl?: boolean;
  meta?: boolean;
}

export interface ReplOptions {
  serverPath: string;
  cwd: string;
  agentName?: string;
  model?: string;
}

export class Repl {
  private flue: FlueProcess;
  private renderer: EventRenderer;
  private rl: readline.Interface | null = null;
  private shutdownRequested = false;

  private lines: string[] = [''];
  private cursorRow = 0;
  private cursorCol = 0;
  private inputLinesCount = 1;
  private lastMenuLines = 0;
  private postResponse = false;
  private responseHeight = 0;

  private steerPending: string[] = [];
  private queuePending: string[] = [];
  private processing = false;

  private sessionLog: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  private commandHistory: string[] = [];
  private historyIndex = -1;

  private lastCtrlC = 0;
  private lastEscape = 0;

  private planMode = false;

  private completing = false;
  private completions: string[] = [];
  private completionIndex = 0;
  private completionType: 'slash' | 'at' | 'hash' | null = null;
  private completionBaseCol = 0;
  private completionScroll = 0;

  private fileCache: string[] | null = null;

  private skillCache: string[] | null = null;
  private skillOrigins = new Map<string, string>();

  constructor(private options: ReplOptions) {
    this.flue = new FlueProcess(options.serverPath, this.options.cwd, this.options.agentName ?? 'build');
    this.renderer = new EventRenderer(process.stdout);
  }

  private get accent(): string {
    return this.planMode ? PLAN_ACCENT : ACCENT;
  }

  private get prompt(): string {
    return `${this.accent}>${RESET} `;
  }

  private get promptN(): string {
    return `${this.accent}. ${RESET} `;
  }

  async start(): Promise<void> {
    await this.flue.start();
    this.startInput();
  }

  private startInput(): void {
    if (!process.stdin.isTTY) {
      this.startSimpleInput();
      return;
    }

    process.stdin.setRawMode(true);
    process.stdin.resume();

    let buf = Buffer.alloc(0);

    process.stdin.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length > 0) {
        const result = this.parseBuffer(buf);
        if (result) {
          buf = buf.subarray(result.consumed);
          this.handleKey(result.key);
        } else {
          break;
        }
      }
    });

    process.stdin.on('end', () => this.handleExit());
    this.initialDraw();
  }

  private parseBuffer(buf: Buffer): { key: Key; consumed: number } | null {
    const first = buf[0];

    if (first === 0x1b) {
      if (buf.length < 2) return null;
      const second = buf[1];

      if (second === 0x5b) {
        const str = buf.toString('utf8');

        const csiMatch = str.match(/^\x1b\[(\d+)(?:;(\d+))?u/);
        if (csiMatch) {
          const codepoint = parseInt(csiMatch[1], 10);
          const mod = csiMatch[2] ? parseInt(csiMatch[2], 10) : 1;
          const m = mod - 1;
          return {
            key: { name: codepoint === 13 ? 'return' : codepoint === 9 ? 'tab' : String.fromCharCode(codepoint), shift: !!(m & 1), ctrl: !!(m & 4), meta: !!(m & 2) },
            consumed: Buffer.byteLength(csiMatch[0], 'utf8'),
          };
        }

        const modMatch = str.match(/^\x1b\[27;(\d+);(\d+)~/);
        if (modMatch) {
          const mod = parseInt(modMatch[1], 10);
          const codepoint = parseInt(modMatch[2], 10);
          const m = mod - 1;
          return {
            key: { name: codepoint === 13 ? 'return' : String.fromCharCode(codepoint), shift: !!(m & 1), ctrl: !!(m & 4), meta: !!(m & 2) },
            consumed: Buffer.byteLength(modMatch[0], 'utf8'),
          };
        }

        if (buf.length >= 3) {
          const ch = buf[2];
          if (ch === 0x41) return { key: { name: 'up' }, consumed: 3 };
          if (ch === 0x42) return { key: { name: 'down' }, consumed: 3 };
          if (ch === 0x43) return { key: { name: 'right' }, consumed: 3 };
          if (ch === 0x44) return { key: { name: 'left' }, consumed: 3 };
          if (ch === 0x48) return { key: { name: 'home' }, consumed: 3 };
          if (ch === 0x46) return { key: { name: 'end' }, consumed: 3 };
          if (ch === 0x5a) return { key: { name: 'tab', shift: true }, consumed: 3 };

          if (ch === 0x7e) {
            if (buf.length >= 4) {
              const code = buf[3];
              if (code === 0x33) return { key: { name: 'delete' }, consumed: 4 };
              if (code === 0x32) return { key: { name: 'insert' }, consumed: 4 };
            }
          }
        }
        return null;
      }

      if (second === 0x4f) {
        if (buf.length >= 3) {
          const ch = buf[2];
          if (ch === 0x41) return { key: { name: 'up' }, consumed: 3 };
          if (ch === 0x42) return { key: { name: 'down' }, consumed: 3 };
          if (ch === 0x43) return { key: { name: 'right' }, consumed: 3 };
          if (ch === 0x44) return { key: { name: 'left' }, consumed: 3 };
          if (ch === 0x48) return { key: { name: 'home' }, consumed: 3 };
          if (ch === 0x46) return { key: { name: 'end' }, consumed: 3 };
        }
        return null;
      }

      if (second === 0x7f) {
        return { key: { name: 'backspace', meta: true }, consumed: 2 };
      }

      if (second >= 0x20 && second < 0x7f) {
        return { key: { name: String.fromCharCode(second), meta: true }, consumed: 2 };
      }

      if (second >= 0x80) {
        const str = buf.toString('utf8');
        const charLen = this.utf8CharLen(second);
        if (charLen > 0 && buf.length >= 1 + charLen) {
          const ch = buf.toString('utf8', 1, 1 + charLen);
          return { key: { name: ch, meta: true }, consumed: 1 + charLen };
        }
        return null;
      }

      return { key: { name: 'escape' }, consumed: 1 };
    }

    if (first === 0x01) return { key: { name: 'a', ctrl: true }, consumed: 1 };
    if (first === 0x05) return { key: { name: 'e', ctrl: true }, consumed: 1 };
    if (first === 0x03) return { key: { name: 'c', ctrl: true }, consumed: 1 };
    if (first === 0x04) return { key: { name: 'd', ctrl: true }, consumed: 1 };
    if (first === 0x0b) return { key: { name: 'k', ctrl: true }, consumed: 1 };
    if (first === 0x15) return { key: { name: 'u', ctrl: true }, consumed: 1 };
    if (first === 0x17) return { key: { name: 'backspace', ctrl: true }, consumed: 1 };
    if (first === 0x0a) return { key: { name: 'j', ctrl: true }, consumed: 1 };
    if (first === 0x0d) return { key: { name: 'return' }, consumed: 1 };
    if (first === 0x09) return { key: { name: 'tab' }, consumed: 1 };
    if (first === 0x7f) return { key: { name: 'backspace' }, consumed: 1 };
    if (first === 0x08) return { key: { name: 'backspace' }, consumed: 1 };

    if (first >= 0x80) {
      const charLen = this.utf8CharLen(first);
      if (charLen > 0 && buf.length >= charLen) {
        const ch = buf.toString('utf8', 0, charLen);
        return { key: { name: ch }, consumed: charLen };
      }
      return null;
    }

    if (first >= 0x20 && first < 0x7f) {
      return { key: { name: String.fromCharCode(first) }, consumed: 1 };
    }

    return { key: { name: '?' }, consumed: 1 };
  }

  private utf8CharLen(firstByte: number): number {
    if (firstByte < 0x80) return 1;
    if ((firstByte & 0xe0) === 0xc0) return 2;
    if ((firstByte & 0xf0) === 0xe0) return 3;
    if ((firstByte & 0xf8) === 0xf0) return 4;
    return 0;
  }

  private handleKey(key: Key): void {
    if (this.completing) {
      this.handleCompletionKey(key);
      return;
    }

    if (key.ctrl && key.name === 'c') {
      const now = Date.now();
      if (this.processing) {
        this.handleInterrupt();
      } else if (now - this.lastCtrlC < 1000) {
        this.handleExit();
      } else {
        this.lastCtrlC = now;
        this.redraw();
        process.stderr.write(`\n${GRAY}  press Ctrl+C again to exit${RESET}`);
      }
      return;
    }

    if (key.ctrl && key.name === 'd') {
      if (this.lines.length === 1 && this.lines[0] === '') {
        this.handleExit();
        return;
      }
      this.deleteForward();
      return;
    }

    if (key.name === 'escape') {
      if (this.processing) {
        this.handleInterrupt();
      } else {
        const now = Date.now();
        if (now - this.lastEscape < 500) {
          this.lines = [''];
          this.cursorRow = 0;
          this.cursorCol = 0;
          this.historyIndex = -1;
          this.completing = false;
          this.redraw();
        }
        this.lastEscape = now;
      }
      return;
    }

    if (key.ctrl && key.name === 'j') { this.newline(); return; }

    if (key.name === 'return' && !key.shift) {
      if (this.processing) { this.handleSteer(); } else { this.handleSubmit(); }
      return;
    }

    if (key.name === 'return' && key.shift) { this.newline(); return; }

    if (key.name === 'tab' && key.shift) {
      this.togglePlanMode();
      return;
    }

    if (key.name === 'tab' && !key.ctrl && !key.meta) {
      if (this.processing) {
        this.handleQueue();
      } else {
        this.triggerCompletion();
      }
      return;
    }

    if (key.name === 'backspace') {
      if (key.ctrl || key.meta) {
        this.wordDeleteBack();
      } else {
        this.backspace();
      }
      return;
    }
    if (key.name === 'up' && !key.meta) { this.moveUp(); return; }
    if (key.name === 'down' && !key.meta) { this.moveDown(); return; }
    if (key.name === 'left') { this.moveLeft(); return; }
    if (key.name === 'right') { this.moveRight(); return; }
    if (key.name === 'home' || (key.ctrl && key.name === 'a')) { this.cursorCol = 0; this.redraw(); return; }
    if (key.name === 'end' || (key.ctrl && key.name === 'e')) { this.cursorCol = this.lines[this.cursorRow].length; this.redraw(); return; }
    if (key.ctrl && key.name === 'u') { this.lines[this.cursorRow] = ''; this.cursorCol = 0; this.redraw(); return; }
    if (key.ctrl && key.name === 'k') { this.lines[this.cursorRow] = this.lines[this.cursorRow].slice(0, this.cursorCol); this.redraw(); return; }
    if (key.name === 'escape' || key.meta) { return; }

    if (!key.ctrl && !key.meta && !key.shift && key.name.length === 1) {
      this.insertChar(key.name);
      return;
    }
  }

  private triggerCompletion(): void {
    const line = this.lines[this.cursorRow];
    const before = line.slice(0, this.cursorCol);

    const slashIdx = before.lastIndexOf('/');
    if (slashIdx >= 0) {
      const afterSlash = before.slice(slashIdx + 1);
      if (slashIdx === 0 || before[slashIdx - 1] === ' ') {
        if (!afterSlash.includes(' ')) {
          const query = afterSlash.toLowerCase();
          this.completionType = 'slash';
          this.completionBaseCol = slashIdx;
          this.completions = this.fuzzySearch(query, ALL_SLASH_COMMANDS);
          this.completionIndex = 0;
          this.completing = true;
          this.drawCompletions();
          return;
        }
      }
    }

    const atMatch = before.match(/@([^\s]*)$/);
    if (atMatch) {
      const query = atMatch[1].toLowerCase();
      this.completionType = 'at';
      this.completionBaseCol = before.lastIndexOf('@');
      const files = this.getFiles();
      this.completions = this.fuzzySearch(query, files);
      this.completionIndex = 0;
      this.completing = true;
      this.drawCompletions();
      return;
    }

    const hashMatch = before.match(/#([^\s]*)$/);
    if (hashMatch) {
      const query = hashMatch[1].toLowerCase();
      this.completionType = 'hash';
      this.completionBaseCol = before.lastIndexOf('#');
      const skills = this.getSkills();
      this.completions = this.fuzzySearch(query, skills);
      if (this.completions.length === 0 && skills.length === 0) {
        process.stderr.write(`\n  ${DIM}no skills installed — add SKILL.md to .agents/skills/<name>/${RESET}\n`);
        this.redraw();
        return;
      }
      this.completionIndex = 0;
      this.completing = true;
      this.drawCompletions();
      return;
    }

    if (this.completing) {
      this.completing = false;
      this.redraw();
    }
  }

  private updateCompletionFilter(): void {
    const line = this.lines[this.cursorRow];
    const before = line.slice(0, this.cursorCol);

    if (this.completionType === 'slash') {
      const afterSlash = before.slice(this.completionBaseCol + 1);
      const query = afterSlash.toLowerCase();
      this.completions = this.fuzzySearch(query, ALL_SLASH_COMMANDS);
      this.completionIndex = 0;
      if (this.completions.length === 0) {
        this.completing = false;
        this.redraw();
      } else {
        this.drawCompletions();
      }
    } else if (this.completionType === 'at') {
      const afterAt = before.slice(this.completionBaseCol + 1);
      const query = afterAt.toLowerCase();
      this.completions = this.fuzzySearch(query, this.getFiles());
      this.completionIndex = 0;
      if (this.completions.length === 0) {
        this.completing = false;
        this.redraw();
      } else {
        this.drawCompletions();
      }
    } else if (this.completionType === 'hash') {
      const afterHash = before.slice(this.completionBaseCol + 1);
      const query = afterHash.toLowerCase();
      this.completions = this.fuzzySearch(query, this.getSkills());
      this.completionIndex = 0;
      if (this.completions.length === 0) {
        this.completing = false;
        this.redraw();
      } else {
        this.drawCompletions();
      }
    }
  }

  private fuzzySearch(query: string, candidates: string[]): string[] {
    if (!query) return candidates;

    const scored: Array<{ item: string; score: number; indices: number[] }> = [];

    for (const item of candidates) {
      const result = this.fuzzyMatch(query, item.toLowerCase());
      if (result) {
        scored.push({ item, score: result.score, indices: result.indices });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.map(s => s.item);
  }

  private fuzzyMatch(query: string, target: string): { score: number; indices: number[] } | null {
    const indices: number[] = [];
    let qi = 0;
    let score = 0;
    let lastMatchIdx = -1;

    for (let ti = 0; ti < target.length && qi < query.length; ti++) {
      if (target[ti] === query[qi]) {
        indices.push(ti);

        if (lastMatchIdx === ti - 1) {
          score += 10;
        }

        if (ti === 0 || '/-_ '.includes(target[ti - 1])) {
          score += 20;
        }

        if (ti === qi) {
          score += 5;
        }

        if (ti > 0 && target[ti - 1] === '.') {
          score += 15;
        }

        lastMatchIdx = ti;
        qi++;
      }
    }

    if (qi < query.length) return null;

    score += Math.max(0, 30 - target.length);

    return { score, indices };
  }

  private getFiles(): string[] {
    this.fileCache = this.walkFiles(this.options.cwd);
    return this.fileCache;
  }

  private getSkills(): string[] {
    if (this.skillCache) return this.skillCache;
    this.skillCache = this.discoverSkills();
    return this.skillCache;
  }

  private discoverSkills(): string[] {
    const skills: string[] = [];
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    const scanDirs = [
      { dir: path.join(this.options.cwd, '.agents', 'skills'), origin: 'local' },
      { dir: path.join(this.options.cwd, '..', '.agents', 'skills'), origin: 'local' },
      { dir: home ? path.join(home, '.agents', 'skills') : '', origin: 'global' },
    ];
    for (const { dir, origin } of scanDirs) {
      if (!dir) continue;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const skillMd = path.join(dir, entry.name, 'SKILL.md');
            if (fs.existsSync(skillMd)) {
              this.skillOrigins.set(entry.name, origin);
              skills.push(entry.name);
            }
          }
        }
      } catch {}
    }
    return [...new Set(skills)].sort();
  }

  private walkFiles(dir: string): string[] {
    const results: string[] = [];
    const skipDirs = new Set(['node_modules', '.git', 'dist', '.next', '__pycache__', '.cache', '.turbo', 'coverage']);
    const gitignorePatterns = this.loadGitignore(dir);

    const walk = (d: string, rel: string, depth: number) => {
      if (depth > 6) return;
      try {
        const entries = fs.readdirSync(d, { withFileTypes: true });
        for (const entry of entries) {
          if (skipDirs.has(entry.name)) continue;
          if (gitignorePatterns.some(p => this.matchGitignore(entry.name, p))) continue;
          const full = path.join(d, entry.name);
          const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            walk(full, entryRel, depth + 1);
          } else if (entry.name.match(/\.(ts|tsx|js|jsx|json|md|py|go|rs|css|html|yaml|yml|toml|sh|sql|vue|svelte|rb|java|c|cpp|h)$/)) {
            results.push(entryRel);
          }
        }
      } catch {}
    };

    walk(dir, '', 0);
    return results.sort();
  }

  private loadGitignore(dir: string): string[] {
    try {
      const content = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
      return content.split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'));
    } catch {
      return [];
    }
  }

  private matchGitignore(name: string, pattern: string): boolean {
    const p = pattern.replace(/\/$/, '');
    if (p.startsWith('!')) return false;
    if (p.includes('*')) {
      const regex = new RegExp('^' + p.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
      return regex.test(name);
    }
    return name === p || name.startsWith(p + '/');
  }

  private drawCompletions(): void {
    const visible = this.completions.slice(0, 12);
    if (visible.length === 0) {
      this.completing = false;
      this.redraw();
      return;
    }

    const totalPrev = this.inputLinesCount + this.lastMenuLines;

    process.stderr.write(`\x1b[${totalPrev}A`);
    for (let i = 0; i < totalPrev; i++) {
      process.stderr.write('\x1b[2K');
      if (i < totalPrev - 1) process.stderr.write('\n');
    }

    for (let i = 0; i < this.lines.length; i++) {
      const prefix = i === 0 ? this.prompt : this.promptN;
      process.stderr.write(`${prefix}${this.colorizeAtMentions(this.lines[i])}`);
      if (i < this.lines.length - 1) process.stderr.write('\n');
    }

    for (let i = 0; i < visible.length; i++) {
      const selected = i === this.completionIndex;
      const marker = selected ? `${this.accent}\u25b6` : `${DIM}\u25cb`;
      const origin = this.completionType === 'hash' ? this.skillOrigins.get(visible[i]) : undefined;
      const tag = origin ? `${DIM} (${origin})${RESET}` : '';
      const label = selected
        ? `${this.accent}${BOLD}${visible[i]}${RESET}${tag}`
        : `${DIM}${visible[i]}${RESET}${tag}`;
      process.stderr.write(`\n  ${marker} ${label}${RESET}`);
    }
    process.stderr.write(`\n\n  ${DIM}Tab/Arrow to cycle  Enter to select  Esc to cancel${RESET}`);

    this.inputLinesCount = this.lines.length;
    this.lastMenuLines = visible.length + 2;

    const rowsUp = this.lastMenuLines + (this.lines.length - 1 - this.cursorRow);
    const targetCol = PROMPT_VIS + this.cursorCol;

    process.stderr.write(`\x1b[${rowsUp}A`);
    process.stderr.write(`\r\x1b[${targetCol}C`);
  }

  private handleCompletionKey(key: Key): void {
    if (key.name === 'escape' || key.meta) {
      this.completing = false;
      this.redraw();
      return;
    }

    if (key.name === 'tab' || key.name === 'down') {
      this.completionIndex = (this.completionIndex + 1) % this.completions.length;
      this.drawCompletions();
      return;
    }

    if (key.name === 'up') {
      this.completionIndex = (this.completionIndex - 1 + this.completions.length) % this.completions.length;
      this.drawCompletions();
      return;
    }

    if (key.name === 'return') {
      this.acceptCompletion();
      return;
    }

    if (key.name === 'backspace' || key.name === 'delete') {
      this.completing = false;
      this.redraw();
      this.handleKey(key);
      return;
    }

    if (!key.ctrl && !key.meta && !key.shift && key.name.length === 1) {
      const line = this.lines[this.cursorRow];
      this.lines[this.cursorRow] = line.slice(0, this.cursorCol) + key.name + line.slice(this.cursorCol);
      this.cursorCol++;
      this.triggerCompletion();
      return;
    }

    this.completing = false;
    this.redraw();
    this.handleKey(key);
  }

  private acceptCompletion(): void {
    const selected = this.completions[this.completionIndex];
    this.completing = false;

    const line = this.lines[this.cursorRow];
    const before = line.slice(0, this.cursorCol);
    const after = line.slice(this.cursorCol);

    let newBefore: string;
    if (this.completionType === 'slash') {
      newBefore = selected + ' ';
    } else if (this.completionType === 'hash') {
      newBefore = before.slice(0, this.completionBaseCol) + '#' + selected + ' ';
    } else {
      newBefore = before.slice(0, this.completionBaseCol) + '@' + selected + ' ';
    }

    this.lines[this.cursorRow] = newBefore + after;
    this.cursorCol = newBefore.length;
    this.redraw();
  }

  private insertChar(ch: string): void {
    const line = this.lines[this.cursorRow];
    this.lines[this.cursorRow] = line.slice(0, this.cursorCol) + ch + line.slice(this.cursorCol);
    this.cursorCol++;
    this.historyIndex = -1;

    if (ch === '/' || ch === '@' || ch === '#') {
      this.triggerCompletion();
      return;
    }

    if (this.completing) {
      this.updateCompletionFilter();
      return;
    }

    this.redraw();
  }

  private newline(): void {
    const line = this.lines[this.cursorRow];
    const before = line.slice(0, this.cursorCol);
    const after = line.slice(this.cursorCol);
    this.lines[this.cursorRow] = before;
    this.lines.splice(this.cursorRow + 1, 0, after);
    this.cursorRow++;
    this.cursorCol = 0;
    this.redraw();
  }

  private backspace(): void {
    if (this.historyIndex !== -1) {
      this.historyIndex = -1;
    }
    if (this.cursorCol > 0) {
      const line = this.lines[this.cursorRow];
      this.lines[this.cursorRow] = line.slice(0, this.cursorCol - 1) + line.slice(this.cursorCol);
      this.cursorCol--;
    } else if (this.cursorRow > 0) {
      const prevLen = this.lines[this.cursorRow - 1].length;
      this.lines[this.cursorRow - 1] += this.lines[this.cursorRow];
      this.lines.splice(this.cursorRow, 1);
      this.cursorRow--;
      this.cursorCol = prevLen;
    }
    this.redraw();
  }

  private wordDeleteBack(): void {
    const line = this.lines[this.cursorRow];
    if (this.cursorCol === 0 && this.cursorRow > 0) {
      const prevLen = this.lines[this.cursorRow - 1].length;
      this.lines[this.cursorRow - 1] += this.lines[this.cursorRow];
      this.lines.splice(this.cursorRow, 1);
      this.cursorRow--;
      this.cursorCol = prevLen;
      this.redraw();
      return;
    }

    const before = line.slice(0, this.cursorCol);
    const trimmed = before.replace(/\s+$/, '');
    const match = trimmed.match(/^(.*?)(\S+)\s*$/);
    if (match) {
      this.lines[this.cursorRow] = match[1] + line.slice(this.cursorCol);
      this.cursorCol = match[1].length;
    }
    this.redraw();
  }

  private deleteForward(): void {
    const line = this.lines[this.cursorRow];
    if (this.cursorCol < line.length) {
      this.lines[this.cursorRow] = line.slice(0, this.cursorCol) + line.slice(this.cursorCol + 1);
    } else if (this.cursorRow < this.lines.length - 1) {
      this.lines[this.cursorRow] += this.lines[this.cursorRow + 1];
      this.lines.splice(this.cursorRow + 1, 1);
    }
    this.redraw();
  }

  private moveUp(): void {
    if (this.lines.length === 1 && this.lines[0] === '' && this.commandHistory.length > 0) {
      if (this.historyIndex < this.commandHistory.length - 1) {
        this.historyIndex++;
        const cmd = this.commandHistory[this.commandHistory.length - 1 - this.historyIndex];
        this.lines = [cmd];
        this.cursorRow = 0;
        this.cursorCol = cmd.length;
        this.redraw();
      }
      return;
    }
    if (this.cursorRow > 0) {
      this.cursorRow--;
      this.cursorCol = Math.min(this.cursorCol, this.lines[this.cursorRow].length);
      this.redraw();
    }
  }

  private moveDown(): void {
    if (this.historyIndex > 0) {
      this.historyIndex--;
      if (this.historyIndex === 0) {
        this.lines = [''];
        this.cursorCol = 0;
      } else {
        const cmd = this.commandHistory[this.commandHistory.length - 1 - this.historyIndex];
        this.lines = [cmd];
        this.cursorCol = cmd.length;
      }
      this.cursorRow = 0;
      this.redraw();
      return;
    }
    if (this.historyIndex === 0) {
      this.historyIndex = -1;
      this.lines = [''];
      this.cursorRow = 0;
      this.cursorCol = 0;
      this.redraw();
      return;
    }
    if (this.cursorRow < this.lines.length - 1) {
      this.cursorRow++;
      this.cursorCol = Math.min(this.cursorCol, this.lines[this.cursorRow].length);
      this.redraw();
    }
  }

  private moveLeft(): void {
    if (this.cursorCol > 0) {
      this.cursorCol--;
    } else if (this.cursorRow > 0) {
      this.cursorRow--;
      this.cursorCol = this.lines[this.cursorRow].length;
    }
    this.redraw();
  }

  private moveRight(): void {
    if (this.cursorCol < this.lines[this.cursorRow].length) {
      this.cursorCol++;
    } else if (this.cursorRow < this.lines.length - 1) {
      this.cursorRow++;
      this.cursorCol = 0;
    }
    this.redraw();
  }

  private printPrompt(): void {
    process.stderr.write(`${this.prompt}`);
  }

  private initialDraw(): void {
    const planTag = this.planMode ? ` ${DIM}[PLAN]${RESET}` : '';
    const shortCwd = this.shortenPath(this.options.cwd);
    process.stderr.write(`  ${this.accent}${BOLD}lavalamp${RESET}${planTag} ${DIM}${shortCwd}${RESET}\n`);
    process.stderr.write(`${this.prompt}`);
    this.inputLinesCount = 1;
  }

  private redraw(): void {
    if (this.postResponse) {
      this.postResponse = false;
      this.lastMenuLines = 0;

      const linesToClear = this.responseHeight + 1;
      process.stderr.write(`\x1b[${linesToClear}A`);
      for (let i = 0; i < linesToClear; i++) {
        process.stderr.write('\x1b[2K');
        if (i < linesToClear - 1) process.stderr.write('\n');
      }

      for (let i = 0; i < this.lines.length; i++) {
        const prefix = i === 0 ? this.prompt : this.promptN;
        process.stderr.write(`${prefix}${this.colorizeAtMentions(this.lines[i])}`);
        if (i < this.lines.length - 1) process.stderr.write('\n');
      }

      this.inputLinesCount = this.lines.length;

      const rowsUp = this.lines.length - 1 - this.cursorRow;
      const targetCol = PROMPT_VIS + this.cursorCol;

      if (rowsUp > 0) process.stderr.write(`\x1b[${rowsUp}A`);
      process.stderr.write(`\r\x1b[${targetCol}C`);
      return;
    }

    const totalPrev = this.inputLinesCount + this.lastMenuLines;

    process.stderr.write(`\x1b[${totalPrev}A`);
    for (let i = 0; i < totalPrev; i++) {
      process.stderr.write('\x1b[2K');
      if (i < totalPrev - 1) process.stderr.write('\n');
    }

    for (let i = 0; i < this.lines.length; i++) {
      const prefix = i === 0 ? this.prompt : this.promptN;
      process.stderr.write(`${prefix}${this.colorizeAtMentions(this.lines[i])}`);
      if (i < this.lines.length - 1) process.stderr.write('\n');
    }

    this.inputLinesCount = this.lines.length;
    this.lastMenuLines = 0;

    const rowsUp = this.lines.length - 1 - this.cursorRow;
    const targetCol = PROMPT_VIS + this.cursorCol;

    if (rowsUp > 0) process.stderr.write(`\x1b[${rowsUp}A`);
    process.stderr.write(`\r\x1b[${targetCol}C`);
  }

  private colorizeAtMentions(text: string): string {
    return text
      .replace(/(@[\w./\\-]+\.\w+)/g, `${this.accent}$1${RESET}`)
      .replace(/(#[\w][\w-]*)/g, `${this.accent}$1${RESET}`);
  }

  private handleSubmit(): void {
    const raw = this.lines.join('\n').trim();
    if (!raw) {
      this.lines = [''];
      this.cursorRow = 0;
      this.cursorCol = 0;
      this.postResponse = false;
      this.redraw();
      return;
    }

    if (raw.startsWith('/')) {
      this.handleSlashCommand(raw);
      this.lines = [''];
      this.cursorRow = 0;
      this.cursorCol = 0;
      this.redraw();
      return;
    }

    const skillMatch = raw.match(/^#([\w-]+)(?:\s+(.+))?$/);
    if (skillMatch) {
      const skillName = skillMatch[1];
      const userPrompt = skillMatch[2] ?? '';
      const prompt = userPrompt
        ? `Activate the skill "${skillName}" and then: ${userPrompt}`
        : `Activate the skill "${skillName}" and tell me what it does.`;
      this.lines = [''];
      this.cursorRow = 0;
      this.cursorCol = 0;
      process.stderr.write('\n');
      this.sendPrompt(prompt);
      return;
    }

    if (raw.startsWith('!')) {
      const cmd = raw.slice(1).trim();
      if (!cmd) {
        this.lines = [''];
        this.cursorRow = 0;
        this.cursorCol = 0;
        this.redraw();
        return;
      }
      this.lines = [''];
      this.cursorRow = 0;
      this.cursorCol = 0;
      process.stderr.write('\n');
      this.runShellCommand(cmd);
      return;
    }

    this.lines = [''];
    this.cursorRow = 0;
    this.cursorCol = 0;
    process.stderr.write('\n');
    const prompt = this.planMode ? `<<PLAN_MODE>> ${raw}` : raw;
    this.sendPrompt(prompt);
  }

  private handleSlashCommand(raw: string): void {
    const parts = raw.split(/\s+/);
    const cmd = parts[0].toLowerCase();

    switch (cmd) {
      case '/help':
        process.stderr.write(`
  ${BOLD}Commands:${RESET}
  ${GREEN}/help${RESET}       Show this help
  ${GREEN}/clear${RESET}      Clear screen
  ${GREEN}/compact${RESET}    Compact conversation context
  ${GREEN}/sessions${RESET}   List recent sessions
  ${GREEN}/memory${RESET}     Show project memory
  ${GREEN}/model${RESET}      Show or change model
  ${GREEN}/workspace${RESET}  Show workspace info
  ${GREEN}/skills${RESET}     List available skills
  ${GREEN}/mcp${RESET}        List connected MCP servers
  ${GREEN}/tools${RESET}      List all registered tools
  ${GREEN}/plan${RESET}       Toggle plan mode (read-only research)
  ${GREEN}/copy${RESET}       Copy session transcript to clipboard
  ${GREEN}/undo${RESET}       Undo last file change
  ${GREEN}/quit${RESET}       Exit lavalamp

  ${BOLD}Prefixes:${RESET}
  ${GREEN}/command${RESET}    Slash commands
  ${GREEN}@file${RESET}       Mention a file
  ${GREEN}#skill${RESET}      Activate a skill
  ${GREEN}!cmd${RESET}        Run shell command in sandbox

  ${BOLD}Keys:${RESET}
  ${GRAY}Tab${RESET}         Autocomplete /commands and @files
  ${GRAY}Shift+Tab${RESET}   Toggle plan mode / build mode
  ${GRAY}Enter${RESET}       Steer (after tool call) or Submit
  ${GRAY}Shift+Enter${RESET} Newline
  ${GRAY}Ctrl+C${RESET}      Interrupt / exit (double-press)
  ${GRAY}Escape x2${RESET}   Interrupt current message
\n`);
        break;
      case '/clear':
        process.stderr.write('\x1b[H\x1b[2J');
        this.inputLinesCount = 0;
        this.initialDraw();
        break;
      case '/compact':
        this.sendPrompt('Compact the conversation context. Summarize earlier messages to free up token space.');
        return;
      case '/sessions':
        this.sendPrompt('List all recent sessions.');
        return;
      case '/memory':
        this.sendPrompt('Read and display the project memory file.');
        return;
      case '/model':
        process.stderr.write(`  model: ${DIM}${this.options.model ?? 'default'}${RESET}\n`);
        break;
      case '/workspace':
        process.stderr.write(`  workspace: ${DIM}${this.options.cwd}${RESET}\n`);
        break;
      case '/skills': {
        const skills = this.getSkills();
        if (skills.length === 0) {
          process.stderr.write(`  ${DIM}no skills found in workspace${RESET}\n`);
          process.stderr.write(`  ${DIM}install skills to .agents/skills/<name>/SKILL.md${RESET}\n`);
          process.stderr.write(`  ${DIM}or use: npx skills add <org>/<repo>@<skill> -g${RESET}\n`);
        } else {
          process.stderr.write(`  ${BOLD}skills:${RESET}\n`);
          for (const s of skills) {
            process.stderr.write(`  ${this.accent}#${s}${RESET}\n`);
          }
        }
        break;
      }
      case '/mcp':
        this.sendPrompt('List all connected MCP servers and their available tools. Show server name and tool count.');
        return;
      case '/tools':
        this.sendPrompt('List ALL registered tools available to you — both built-in framework tools (read, write, edit, bash, grep, glob, task) and any custom tools. For each tool, show its name and a one-line description of what it does.');
        return;
      case '/plan':
        this.togglePlanMode();
        return;
      case '/copy': {
        const md = this.sessionToMarkdown();
        this.copyToClipboard(md);
        process.stderr.write(`\n${GREEN}  session copied to clipboard${RESET}\n\n`);
        break;
      }
      case '/undo':
        this.sendPrompt('Undo the last file change. Use the undo tool to restore the most recent modification.');
        return;
      case '/quit':
        this.handleExit();
        break;
      default:
        process.stderr.write(`  ${YELLOW}unknown command: ${cmd}${RESET}\n`);
    }
  }

  private sessionToMarkdown(): string {
    const lines: string[] = [];
    lines.push(`# lavalamp session`);
    lines.push(`date: ${new Date().toISOString()}`);
    lines.push(`workspace: ${this.options.cwd}`);
    lines.push(`model: ${this.options.model ?? 'default'}`);
    lines.push('');

    for (const entry of this.sessionLog) {
      if (entry.role === 'user') {
        lines.push(`## User`);
        lines.push(entry.content);
        lines.push('');
      } else {
        lines.push(`## Assistant`);
        lines.push(entry.content);
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  private copyToClipboard(text: string): void {
    const { execSync } = require('child_process');
    try {
      if (process.platform === 'darwin') {
        execSync('pbcopy', { input: text });
      } else if (process.platform === 'linux') {
        execSync('xclip -selection clipboard', { input: text });
      } else {
        execSync('clip', { input: text });
      }
    } catch {
      const fp = path.join(this.options.cwd, 'session-export.md');
      fs.writeFileSync(fp, text);
      process.stderr.write(`  ${DIM}clipboard unavailable, saved to ${fp}${RESET}\n`);
    }
  }

  private shortenPath(p: string): string {
    const home = process.env.HOME ?? '';
    if (home && p.startsWith(home)) return '~' + p.slice(home.length);
    return p;
  }

  private togglePlanMode(): void {
    this.planMode = !this.planMode;
    if (this.planMode) {
      process.stderr.write(`\n  ${PLAN_ACCENT}${BOLD}plan mode enabled${RESET}\n`);
      process.stderr.write(`  ${DIM}Agent can only read, search, research, and plan${RESET}\n`);
      process.stderr.write(`  ${DIM}No file edits, no shell commands, no mutations${RESET}\n`);
      process.stderr.write(`  ${DIM}Use create_task to build implementation steps${RESET}\n`);
      process.stderr.write(`  ${DIM}Press Shift+Tab or type /plan to exit${RESET}\n\n`);
    } else {
      process.stderr.write(`\n  ${ACCENT}${BOLD}build mode enabled${RESET}\n`);
      process.stderr.write(`  ${DIM}Agent can read, write, edit, and run commands${RESET}\n\n`);
    }
    this.redraw();
  }

  private handleSteer(): void {
    const prompt = this.lines.join('\n').trim();
    if (!prompt) return;

    this.lines = [''];
    this.cursorRow = 0;
    this.cursorCol = 0;
    process.stderr.write('\n');
    this.steerPending.push(prompt);
    process.stderr.write(`${GRAY}  (steer queued)${RESET}\n`);
    this.redraw();
  }

  private handleQueue(): void {
    const prompt = this.lines.join('\n').trim();
    if (!prompt) return;

    this.lines = [''];
    this.cursorRow = 0;
    this.cursorCol = 0;
    process.stderr.write('\n');
    this.queuePending.push(prompt);
    process.stderr.write(`${YELLOW}  (queued #${this.queuePending.length})${RESET}\n`);
    this.redraw();
  }

  private handleInterrupt(): void {
    this.renderer.flush();
    this.flue.cancel();
    this.processing = false;
    this.steerPending = [];
    this.historyIndex = -1;
    this.lines = [''];
    this.cursorRow = 0;
    this.cursorCol = 0;
    this.responseHeight = 1;
    process.stderr.write(`\n${YELLOW}  interrupted${RESET}\n\n`);
    this.postResponse = true;
    this.redraw();
  }

  private handleExit(): void {
    if (this.shutdownRequested) return;
    this.shutdownRequested = true;

    this.renderer.flush();
    process.stderr.write(`\n${DIM}  bye${RESET}\n`);

    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();

    this.flue.shutdown().then(() => process.exit(0));
  }

  private runShellCommand(cmd: string): void {
    const isWin = process.platform === 'win32';
    const shell = isWin ? 'cmd.exe' : (process.env.SHELL ?? '/bin/sh');
    const args = isWin ? ['/c', cmd] : ['-c', cmd];

    const proc = spawn(shell, args, {
      cwd: this.options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      let lines = 0;
      if (stdout) { process.stderr.write(stdout); lines += (stdout.match(/\n/g) ?? []).length; }
      if (stderr) { process.stderr.write(stderr); lines += (stderr.match(/\n/g) ?? []).length; }
      if (code !== 0 && code !== null) {
        process.stderr.write(`${GRAY}  exit ${code}${RESET}\n`);
        lines++;
      }
      this.responseHeight = lines + 1;
      process.stderr.write('\n');
      this.postResponse = true;
      this.redraw();
    });

    proc.on('error', (err) => {
      process.stderr.write(`${RED}  error: ${err.message}${RESET}\n\n`);
      this.redraw();
    });
  }

  private sendPrompt(prompt: string): void {
    this.processing = true;
    this.historyIndex = -1;
    this.commandHistory.push(prompt);
    this.renderer = new EventRenderer(process.stdout);
    this.sessionLog.push({ role: 'user', content: prompt });
    process.stderr.write(`${DIM}  processing... (Enter: steer, Tab: queue)${RESET}\n`);

    let responseText = '';
    let responseLineCount = 0;

    this.flue.prompt(prompt, {
      onEvent: (event) => {
        this.renderer.render(event);
        if (event.type === 'text_delta') {
          const delta = event.text ?? event.delta ?? '';
          responseLineCount += (delta.match(/\n/g) ?? []).length;
          responseText += delta;
        }
        if (event.type === 'tool_start' || event.type === 'tool') {
          responseLineCount += 1;
        }
      },
      onResult: (result) => {
        this.renderer.flush();
        this.processing = false;
        if (responseText) {
          this.sessionLog.push({ role: 'assistant', content: responseText });
          responseLineCount += 1;
        }
        this.printUsage(result);
        this.responseHeight = responseLineCount + 2;
        this.drainPending();
      },
      onError: (err) => {
        this.renderer.flush();
        this.processing = false;
        this.responseHeight = 2;
        process.stderr.write(`\n${GRAY}  error: ${err.message}${RESET}\n\n`);
        this.drainPending();
      },
    });
  }

  private drainPending(): void {
    if (this.steerPending.length > 0) {
      const next = this.steerPending.shift()!;
      process.stderr.write(`${GRAY}  (steer)${RESET}\n`);
      this.sendPrompt(next);
      return;
    }
    if (this.queuePending.length > 0) {
      const next = this.queuePending.shift()!;
      process.stderr.write(`${YELLOW}  (queued)${RESET}\n`);
      this.sendPrompt(next);
      return;
    }
    this.postResponse = true;
    process.stderr.write('\n');
    this.printPrompt();
  }

  private printUsage(result: FlueResult): void {
    if (!result?.usage) return;
    const u = result.usage;
    const m = result.model ? `${result.model.provider}/${result.model.id}` : '';
    process.stderr.write(`${DIM}  ${u.totalTokens} tok | $${u.cost.total.toFixed(4)} | ${m}${RESET}\n\n`);
  }

  private startSimpleInput(): void {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    rl.on('line', (line) => {
      const p = line.trim();
      if (!p) return;
      if (this.processing) {
        this.queuePending.push(p);
        process.stderr.write(`${YELLOW}  (queued #${this.queuePending.length})${RESET}\n`);
        return;
      }
      const prompt = this.planMode ? `<<PLAN_MODE>> ${p}` : p;
      this.sendPrompt(prompt);
    });
    rl.on('close', () => this.handleExit());
  }
}

export async function startRepl(options: ReplOptions): Promise<void> {
  const repl = new Repl(options);
  await repl.start();
}
