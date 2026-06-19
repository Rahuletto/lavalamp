export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  timestamp: number;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
  durationMs?: number;
}

export interface Task {
  id: number;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'skipped';
}

export interface SubAgent {
  id: string;
  query: string;
  status: 'running' | 'done' | 'failed' | 'timed_out' | 'killed';
  result?: string;
  error?: string;
  startTime: number;
  pid?: number;
}

export interface AppState {
  messages: Message[];
  input: string;
  cursorCol: number;
  processing: boolean;
  planMode: boolean;
  steerPending: string[];
  queuePending: string[];
  commandHistory: string[];
  historyIndex: number;
  lastCtrlC: number;
  lastEscape: number;
  currentThinking: string;
  currentText: string;
  currentTool: ToolCall | null;
  cwd: string;
  model?: string;
  tasks: Task[];
  subAgents: SubAgent[];
}

export function createInitialState(cwd: string, model?: string): AppState {
  return {
    messages: [],
    input: '',
    cursorCol: 0,
    processing: false,
    planMode: false,
    steerPending: [],
    queuePending: [],
    commandHistory: [],
    historyIndex: -1,
    lastCtrlC: 0,
    lastEscape: 0,
    currentThinking: '',
    currentText: '',
    currentTool: null,
    cwd,
    model,
    tasks: [],
    subAgents: [],
  };
}
