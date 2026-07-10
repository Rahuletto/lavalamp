import { COLORS } from '../theme';
import { BaseBoxManager } from './BaseBoxManager';
import type { BaseBoxContext } from './BaseBoxManager';
import type { StyledText } from '@opentui/core';

export interface Question {
  id: string;
  question: string;
  type: 'select' | 'multiselect' | 'input';
  options?: string[];
  default?: string | string[];
}

export class QuestionBoxManager extends BaseBoxManager<Record<string, any>> {
  private questions: Question[] = [];
  private currentIndex = 0;
  private answers: Record<string, any> = {};

  // State for current question
  private cursorIndex = 0;
  private selectedIndices = new Set<number>();
  private currentInputText = '';

  constructor(ctx: BaseBoxContext) {
    super(ctx, 'question-box', COLORS.accent || COLORS.teal || '#00D7D7');
  }

  protected getDefaultValue(): Record<string, any> {
    const defaults: Record<string, any> = {};
    for (const q of this.questions) {
      defaults[q.id] = q.default ?? (q.type === 'multiselect' ? [] : '');
    }
    return defaults;
  }

  show(questions: Question[]): Promise<Record<string, any>> {
    this.questions = questions;
    this.currentIndex = 0;
    this.answers = {};
    this.box.visible = true;

    this.initQuestionState();
    this.renderCurrentQuestion();

    return new Promise<Record<string, any>>((resolve) => {
      this.resolver = resolve;
    });
  }

  private initQuestionState(): void {
    const q = this.questions[this.currentIndex];
    if (!q) return;

    this.cursorIndex = 0;
    this.selectedIndices.clear();
    this.currentInputText = '';

    const options = q.options ?? [];

    if (q.type === 'select') {
      if (typeof q.default === 'string') {
        const idx = options.indexOf(q.default);
        if (idx !== -1) {
          this.cursorIndex = idx;
        }
      }
    } else if (q.type === 'multiselect') {
      if (Array.isArray(q.default)) {
        for (const item of q.default) {
          const idx = options.indexOf(item);
          if (idx !== -1) {
            this.selectedIndices.add(idx);
          }
        }
      }
    } else if (q.type === 'input') {
      if (typeof q.default === 'string') {
        this.currentInputText = q.default;
      }
    }
  }

  private renderCurrentQuestion(): void {
    const q = this.questions[this.currentIndex];
    if (!q) {
      this.hide(this.answers);
      return;
    }

    this.title.content = ` Question ${this.currentIndex + 1} of ${this.questions.length}`;

    const rows: { content: string | StyledText; fg?: string }[] = [];
    rows.push({ content: '', fg: COLORS.dim });
    rows.push({ content: `  ${q.question}`, fg: COLORS.white });
    rows.push({ content: '', fg: COLORS.dim });

    const options = q.options ?? [];

    if (q.type === 'select') {
      options.forEach((opt, idx) => {
        const isCurrent = idx === this.cursorIndex;
        const prefix = isCurrent ? '  > ' : '    ';
        const color = isCurrent ? COLORS.green : COLORS.gray;
        rows.push({ content: `${prefix}${opt}`, fg: color });
      });
      rows.push({ content: '', fg: COLORS.dim });
      rows.push({ content: '  [↑/↓] Navigate  [Enter] Confirm selection', fg: COLORS.dim });
    } else if (q.type === 'multiselect') {
      options.forEach((opt, idx) => {
        const isCurrent = idx === this.cursorIndex;
        const isSelected = this.selectedIndices.has(idx);
        const prefix = isCurrent ? '  > ' : '    ';
        const checkbox = isSelected ? '[x]' : '[ ]';
        const color = isCurrent ? COLORS.green : COLORS.gray;
        rows.push({ content: `${prefix}${checkbox} ${opt}`, fg: color });
      });
      rows.push({ content: '', fg: COLORS.dim });
      rows.push({ content: '  [↑/↓] Navigate  [Space] Toggle  [Enter] Confirm selections', fg: COLORS.dim });
    } else if (q.type === 'input') {
      rows.push({ content: `  > ${this.currentInputText}_`, fg: COLORS.green });
      rows.push({ content: '', fg: COLORS.dim });
      rows.push({ content: '  [Type text]  [Enter] Confirm', fg: COLORS.dim });
    }

    const styledRows = rows.map((r) => ({
      content: r.content,
      fg: r.fg ?? COLORS.gray,
    }));
    this.populateRows(styledRows);
    this.ctx.renderer.requestRender();
  }

  handleKeyPress(key: any): boolean {
    const q = this.questions[this.currentIndex];
    if (!q) return false;

    if (key.name === 'escape') {
      this.hide(this.getDefaultValue());
      return true;
    }

    if (q.type === 'select' || q.type === 'multiselect') {
      const options = q.options ?? [];
      if (key.name === 'up' || key.name === 'k') {
        if (options.length > 0) {
          this.cursorIndex = (this.cursorIndex - 1 + options.length) % options.length;
        }
        this.renderCurrentQuestion();
        return true;
      }
      if (key.name === 'down' || key.name === 'j') {
        if (options.length > 0) {
          this.cursorIndex = (this.cursorIndex + 1) % options.length;
        }
        this.renderCurrentQuestion();
        return true;
      }
      if (q.type === 'multiselect' && key.name === 'space') {
        if (this.selectedIndices.has(this.cursorIndex)) {
          this.selectedIndices.delete(this.cursorIndex);
        } else {
          this.selectedIndices.add(this.cursorIndex);
        }
        this.renderCurrentQuestion();
        return true;
      }
      if (key.name === 'return') {
        if (q.type === 'select') {
          this.answers[q.id] = options[this.cursorIndex] ?? '';
        } else {
          this.answers[q.id] = Array.from(this.selectedIndices).map((idx) => options[idx] ?? '');
        }
        this.nextQuestion();
        return true;
      }
    } else if (q.type === 'input') {
      if (key.name === 'return') {
        this.answers[q.id] = this.currentInputText;
        this.nextQuestion();
        return true;
      }
      if (key.name === 'backspace') {
        this.currentInputText = this.currentInputText.slice(0, -1);
        this.renderCurrentQuestion();
        return true;
      }
      // If it's a typing character, append it
      if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
        this.currentInputText += key.sequence;
        this.renderCurrentQuestion();
        return true;
      }
    }

    return false;
  }

  private nextQuestion(): void {
    this.currentIndex++;
    if (this.currentIndex >= this.questions.length) {
      this.hide(this.answers);
    } else {
      this.initQuestionState();
      this.renderCurrentQuestion();
    }
  }
}
