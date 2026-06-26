import type { AppState, Message, SubAgent, Task, ToolCall } from "../state";
import { createInitialState } from "../state";

export class AppStateStore {
  private readonly state: AppState;
  private readonly listeners = new Set<() => void>();

  constructor(cwd: string, model?: string) {
    this.state = createInitialState(cwd, model);
  }

  getState(): AppState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  // --- Getters & Setters / Mutators ---

  get planMode(): boolean {
    return this.state.planMode;
  }

  setPlanMode(value: boolean): void {
    this.state.planMode = value;
    this.notify();
  }

  get model(): string | undefined {
    return this.state.model;
  }

  setModel(value: string | undefined): void {
    this.state.model = value;
    this.notify();
  }

  get processing(): boolean {
    return this.state.processing;
  }

  setProcessing(value: boolean): void {
    this.state.processing = value;
    this.notify();
  }

  get messages(): Message[] {
    return this.state.messages;
  }

  setMessages(value: Message[]): void {
    this.state.messages = value;
    this.notify();
  }

  pushMessage(msg: Message): void {
    this.state.messages.push(msg);
    this.notify();
  }

  get tasks(): Task[] {
    return this.state.tasks;
  }

  setTasks(value: Task[]): void {
    this.state.tasks = value;
    this.notify();
  }

  get subAgents(): SubAgent[] {
    return this.state.subAgents;
  }

  setSubAgents(value: SubAgent[]): void {
    this.state.subAgents = value;
    this.notify();
  }

  get input(): string {
    return this.state.input;
  }

  setInput(value: string): void {
    this.state.input = value;
    this.notify();
  }

  get cursorCol(): number {
    return this.state.cursorCol;
  }

  setCursorCol(value: number): void {
    this.state.cursorCol = value;
    this.notify();
  }

  get steerPending(): string[] {
    return this.state.steerPending;
  }

  setSteerPending(value: string[]): void {
    this.state.steerPending = value;
    this.notify();
  }

  get queuePending(): string[] {
    return this.state.queuePending;
  }

  setQueuePending(value: string[]): void {
    this.state.queuePending = value;
    this.notify();
  }

  get commandHistory(): string[] {
    return this.state.commandHistory;
  }

  setCommandHistory(value: string[]): void {
    this.state.commandHistory = value;
    this.notify();
  }

  get historyIndex(): number {
    return this.state.historyIndex;
  }

  setHistoryIndex(value: number): void {
    this.state.historyIndex = value;
    this.notify();
  }

  get lastCtrlC(): number {
    return this.state.lastCtrlC;
  }

  setLastCtrlC(value: number): void {
    this.state.lastCtrlC = value;
    this.notify();
  }

  get lastEscape(): number {
    return this.state.lastEscape;
  }

  setLastEscape(value: number): void {
    this.state.lastEscape = value;
    this.notify();
  }

  get currentThinking(): string {
    return this.state.currentThinking;
  }

  setCurrentThinking(value: string): void {
    this.state.currentThinking = value;
    this.notify();
  }

  get currentText(): string {
    return this.state.currentText;
  }

  setCurrentText(value: string): void {
    this.state.currentText = value;
    this.notify();
  }

  get currentTool(): ToolCall | null {
    return this.state.currentTool;
  }

  setCurrentTool(value: ToolCall | null): void {
    this.state.currentTool = value;
    this.notify();
  }

  get cwd(): string {
    return this.state.cwd;
  }
}
