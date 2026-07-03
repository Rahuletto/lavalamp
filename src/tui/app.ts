import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  TextareaRenderable,
  ScrollBoxRenderable,
  MarkdownRenderable,
  TextAttributes,
  defaultTextareaKeyBindings,
} from '@opentui/core';
import type { KeyEvent, CliRenderer } from '@opentui/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FlueProcess } from './ipc';
import type { FlueEvent, FlueResult, PermissionRequestMsg } from './ipc';
import { SubAgentManager } from './subs';
import { COLORS } from './theme';
import type { Message } from './state';
import { AppStateStore } from './storage/Store';
import { handleKeyPress } from './events/Keybindings';
import { ConfirmBoxManager } from './components/ConfirmBox';
import { PermissionBoxManager } from './components/PermissionBox';
import { ResultPanelManager } from './components/ResultPanel';
import { CompletionManager } from './components/CompletionManager';
import { QueuePanelManager, SubPanelManager } from './components/QueueSubPanel';
import { TaskPanelManager } from './components/TaskPanel';
import { MessageRenderer } from './components/Messages';
import { ToolUiManager } from './components/ToolUi';
import {
  LAVA_LAMP_FRAMES,
  syntaxStyle,
} from './art';
import { discoverSkills } from './discover';
import {
  nameSession,
  saveSession,
  listSessions,
  loadSession,
} from './sessions';
import {
  stripCwd,
  summarizeToolArgs,
  extractResultText,
  extractFilePaths,
} from './tools';
import {
  isAllowAll,
  loadAutorun,
  setAllowAll,
  setAutorun,
} from '../permissions/autorun';
import { getDefaultRules, loadRules } from '../permissions/rules';
import { BackupEngine } from '../storage/backups';
import { steerPrompt } from '../storage/steering';
import { pasteImageFromClipboard } from '../storage/clipboard';
import { describeImageWithSpectacle } from '../storage/spectacle';
import { openCodeViewer, openDiffViewer } from './viewers';
import {
  configPath,
  resolveConfig,
  updateConfig,
} from '../config/user-config';
import {
  BUILD_MODEL,
  getModelEntry,
  listModels,
} from '../config/models';

export interface TuiOptions {
  serverPath: string;
  cwd: string;
  agentName?: string;
  model?: string;
  resumeSession?: boolean;
  resumeSessionId?: string;
}

function shortenPath(p: string): string {
  const home = process.env.HOME ?? '';
  if (home && p.startsWith(home)) {return `~${  p.slice(home.length)}`;}
  return p;
}


function visiblePrompt(prompt: string): string {
  return prompt.replace(/^<<(?:PLAN|BUILD)_MODE>>\s*/, '');
}

function isAuthError(err: Error): boolean {
  return /\b401\b/.test(err.message);
}



function hexToAnsi(hex: string): string {
  const value = hex.replace('#', '');
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `\u001B[38;2;${r};${g};${b}m`;
}

function formatAge(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) {return 'just now';}
  if (min < 60) {return `${min}m ago`;}
  const hr = Math.floor(min / 60);
  if (hr < 24) {return `${hr}h ago`;}
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

function formatCost(value: number): string {
  return `$${value.toFixed(4)}`;
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {return `${(value / 1_000_000).toFixed(2)}m`;}
  if (value >= 1000) {return `${(value / 1000).toFixed(1)}k`;}
  return String(value);
}

export async function startTui(options: TuiOptions): Promise<void> {
  const store = new AppStateStore(options.cwd, options.model);
  const state = store.getState();
  const backupEngine = new BackupEngine(options.cwd);
  const backupHistory: string[] = [];
  let turnBackupCreated = false;
  const attachedImages: { tag: string; path: string }[] = [];
  let imageCounter = 0;

  function accent(): string {
    return state.planMode ? COLORS.planAccent : COLORS.accent;
  }

  const {cwd} = options;
  let idCounter = 0;
  function nextId(): string {
    return `el-${++idCounter}`;
  }
  let destroyed = false;
  let root = {
    // stub to avoid error if accessed before renderer is initialized, though root will be reassigned
    add() {},
    remove() {},
  } as { add: (...args: unknown[]) => void; remove: (...args: unknown[]) => void };
  const boxCtx = {
    nextId,
    get renderer() {
      return renderer;
    },
    get root() {
      return renderer.root;
    },
  };

  const flue = new FlueProcess(
    options.serverPath,
    options.cwd,
    options.agentName ?? 'build',
  );
  loadAutorun(cwd);
  const permissionRules = loadRules(cwd);
  const subManager = new SubAgentManager(
    options.serverPath,
    options.cwd,
    options.agentName ?? 'build',
  );
  let currentSessionId = `session_${Date.now()}`;

  const renderer: CliRenderer = await createCliRenderer({
    exitOnCtrlC: false,
    exitSignals: [
      'SIGTERM',
      'SIGQUIT',
      'SIGABRT',
      'SIGHUP',
      'SIGBREAK',
      'SIGPIPE',
      'SIGBUS',
    ],
    onDestroy: () => {
      saveSessionSnapshot();
      destroyed = true;
      if (spinnerTimer) {
        clearInterval(spinnerTimer);
        spinnerTimer = null;
      }
      clearInterval(lavaLampTimer);
      subManager.killAll();
      flue.shutdown().catch(() => {});
    },
    screenMode: 'alternate-screen',
    useMouse: true,
  });

  ({ root } = renderer);

  const confirmBoxMgr = new ConfirmBoxManager(boxCtx);
  const permissionBoxMgr = new PermissionBoxManager({
    cwd: options.cwd,
    nextId: boxCtx.nextId,
    get renderer() { return boxCtx.renderer; },
    get root() { return boxCtx.root; },
  });

  // Wire permission request handling from the server child process
  flue.onPermissionRequest = (request: PermissionRequestMsg) => {
    (async () => {
      const choice = await permissionBoxMgr.show(request);
      if (choice === 'always') {
        setAutorun(cwd, request.toolName, 'allow');
        flue.sendPermissionResponse(request.requestId, 'allow', true);
        updateStatus();
      } else {
        flue.sendPermissionResponse(
          request.requestId,
          choice === 'allow' ? 'allow' : 'deny',
        );
      }
    })().catch(() => {});
  };
  root.flexDirection = 'column';
  root.width = '100%';
  root.height = '100%';

  let scrollPending = false;
  let userHasScrolledUp = false;
  let lastScrollTop = 0;

  function requestScroll() {
    if (destroyed) {return;}
    if (userHasScrolledUp) {return;}
    if (scrollPending) {return;}
    scrollPending = true;
    queueMicrotask(() => {
      if (!destroyed) {messagesScroll.scrollBy(1000);}
      scrollPending = false;
    });
  }

  const header = new BoxRenderable(renderer, {
    flexDirection: 'row',
    height: 2,
    id: 'header',
    padding: { left: 1, right: 1 },
    paddingBottom: 1,
    width: '100%',
  });
  const headerTitle = new TextRenderable(renderer, {
    attributes: TextAttributes.BOLD,
    content: 'lavalamp',
    fg: COLORS.accent,
    id: 'header-title',
    selectable: false,
  });
  header.add(headerTitle);
  root.add(header);

  const messagesScroll = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    id: 'messages',
    padding: { left: 1, right: 1 },
    scrollY: true,
    stickyScroll: false,
    width: '100%',
  });
  root.add(messagesScroll);

  messagesScroll.on('scroll', () => {
    const currentScrollTop = messagesScroll.scrollTop;
    if (currentScrollTop < lastScrollTop) {
      userHasScrolledUp = true;
    } else {
      const {scrollHeight} = messagesScroll;
      const atBottom = scrollHeight - currentScrollTop < 50;
      if (atBottom) {userHasScrolledUp = false;}
    }
    lastScrollTop = currentScrollTop;
  });

  const completionBox = new BoxRenderable(renderer, {
    border: true,
    borderColor: COLORS.border,
    borderStyle: 'single',
    flexDirection: 'column',
    flexShrink: 0,
    id: 'completion-box',
    maxHeight: 10,
    paddingLeft: 1,
    paddingRight: 1,
    visible: false,
    width: '100%',
  });
  const completionScroll = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    id: 'completion-scroll',
    maxHeight: 10,
    scrollY: true,
    width: '100%',
  });
  completionBox.add(completionScroll);
  root.add(completionBox);

  const lavaLampBox = new BoxRenderable(renderer, {
    alignItems: 'center',
    flexDirection: 'column',
    flexGrow: 1,
    id: 'lava-lamp-box',
    justifyContent: 'center',
    visible: true,
    width: '100%',
  });
  const lavaLampText = new TextRenderable(renderer, {
    content: LAVA_LAMP_FRAMES[0].join('\n'),
    fg: COLORS.accent,
    id: 'lava-lamp-text',
    selectable: false,
  });
  lavaLampBox.add(lavaLampText);
  messagesScroll.add(lavaLampBox);

  let lavaLampFrame = 0;
  const lavaLampTimer = setInterval(() => {
    if (destroyed) {return;}
    lavaLampFrame = (lavaLampFrame + 1) % LAVA_LAMP_FRAMES.length;
    lavaLampText.content = LAVA_LAMP_FRAMES[lavaLampFrame].join('\n');
  }, 600);

  const taskStatusBar = new BoxRenderable(renderer, {
    flexDirection: 'row',
    height: 1,
    id: 'task-status-bar',
    padding: { left: 1 },
    visible: false,
    width: '100%',
  });
  const taskStatusText = new TextRenderable(renderer, {
    content: '',
    fg: COLORS.green,
    id: 'task-status-text',
  });
  taskStatusBar.add(taskStatusText);
  root.add(taskStatusBar);

  const SPINNER_FRAMES = [
    '▓░░░░░',
    '▒▓░░░░',
    '░▒▓░░░',
    '░░▒▓░░',
    '░░░▒▓░',
    '░░░░▒▓',
    '░░░░░▒',
  ];
  let spinnerFrame = 0;
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;

  function startSpinner() {
    if (spinnerTimer) {clearInterval(spinnerTimer);}
    spinnerFrame = 0;
    updateStatus();
    spinnerTimer = setInterval(() => {
      spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
      updateStatus();
      renderer.requestRender();
    }, 80);
  }

  function stopSpinner() {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
    updateStatus();
  }

  const resultTitle = new TextRenderable(renderer, {
    attributes: TextAttributes.BOLD,
    content: '',
    fg: COLORS.white,
    height: 1,
    id: nextId(),
    width: '100%',
  });
  const resultScroll = new ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    id: 'result-scroll',
    maxHeight: 18,
    scrollY: true,
    width: '100%',
  });
  const resultBox = new BoxRenderable(renderer, {
    flexDirection: 'column',
    flexShrink: 0,
    id: 'result-box',
    maxHeight: 20,
    visible: false,
    width: '100%',
  });
  resultBox.add(resultTitle);
  resultBox.add(resultScroll);
  root.add(resultBox);

  const resultPanelMgr = new ResultPanelManager({
    inputField: { focus: () => inputField.focus() },
    messagesScroll,
    nextId,
    renderer,
    resultBox,
    resultScroll,
    resultTitle,
  });

  function showResultPanel(
    title: string,
    rows: { content: string; fg?: string; bold?: boolean }[],
  ) {
    resultPanelMgr.show(title, rows);
  }

  function hideResultPanel() {
    resultPanelMgr.hide();
  }

  // Let confirmBoxMgr and permissionBoxMgr reuse confirmBox/permissionBox from root
  const confirmBox = confirmBoxMgr.box;
  const permissionBox = permissionBoxMgr.box;

  function showConfirm(
    title: string,
    rows: { content: string; fg?: string }[],
    resolve: (choice: boolean) => void,
    timeoutMs = 2000,
    acceptReturn = false,
    acceptCtrlC = true,
  ) {
    confirmBoxMgr.show(
      title,
      rows,
      resolve,
      timeoutMs,
      acceptReturn,
      acceptCtrlC,
    );
  }

  function hideConfirm(choice: boolean) {
    confirmBoxMgr.hide(choice);
  }

  // ── SpecApprovalBox ────────────────────────────────────────────────
  const specApprovalBox = new BoxRenderable(renderer, {
    borderColor: COLORS.planAccent,
    borderStyle: 'single',
    flexDirection: 'column',
    flexShrink: 0,
    id: 'spec-approval-box',
    padding: { bottom: 0, left: 1, right: 1, top: 0 },
    visible: false,
    width: '100%',
  });
  const specApprovalTitle = new TextRenderable(renderer, {
    attributes: TextAttributes.BOLD,
    content: ' Approve Plan?',
    fg: COLORS.planAccent,
    height: 1,
    id: 'spec-approval-title',
    width: '100%',
  });
  const specApprovalBody = new BoxRenderable(renderer, {
    flexDirection: 'column',
    id: 'spec-approval-body',
    width: '100%',
  });
  specApprovalBox.add(specApprovalTitle);
  specApprovalBox.add(specApprovalBody);
  root.add(specApprovalBox);

  let specApprovalResolve: ((choice: boolean) => void) | null = null;

  function showSpecApprovalBox(resolve: (choice: boolean) => void) {
    for (const child of specApprovalBody.getChildren()) {child.destroy();}
    specApprovalBody.add(
      new TextRenderable(renderer, {
        content:
          '  Press [y] to Approve & switch to Build Mode, or [n] to continue planning.',
        fg: COLORS.gray,
        id: nextId(),
        width: '100%',
      }),
    );
    specApprovalBox.visible = true;
    specApprovalResolve = resolve;
    requestScroll();
    renderer.requestRender();
  }

  function hideSpecApprovalBox(choice: boolean) {
    specApprovalBox.visible = false;
    for (const child of specApprovalBody.getChildren()) {child.destroy();}
    if (specApprovalResolve) {
      const resolve = specApprovalResolve;
      specApprovalResolve = null;
      resolve(choice);
    }
    requestScroll();
    renderer.requestRender();
  }

  const queuePanelMgr = new QueuePanelManager(boxCtx);
  const subPanelMgr = new SubPanelManager(boxCtx);
  const subBox = subPanelMgr.box;

  function withModeTag(prompt: string, overridePlanMode?: boolean): string {
    const planMode = overridePlanMode ?? state.planMode;
    if (
      prompt.startsWith('<<PLAN_MODE>>') ||
      prompt.startsWith('<<BUILD_MODE>>')
    )
      {return prompt;}
    return `${planMode ? '<<PLAN_MODE>>' : '<<BUILD_MODE>>'} ${prompt}`;
  }

  function refreshQueuePanel() {
    queuePanelMgr.refresh(
      state.steerPending,
      state.queuePending,
      visiblePrompt,
    );
  }

  function refreshSubPanel() {
    subPanelMgr.refresh(state.subAgents, SPINNER_FRAMES, spinnerFrame);
  }

  subManager.onUpdate = (subs) => {
    state.subAgents = subs;
    refreshSubPanel();
    updateStatus();
  };

  subManager.onAllComplete = (summary) => {
    refreshSubPanel();
    const followUp = `The parallel research has completed. Here are the findings:\n\n${summary}\n\nPlease analyze these results and continue with your task.`;
    if (state.processing) {state.queuePending.push(withModeTag(followUp));}
    refreshQueuePanel();
  };

  const taskPanelMgr = new TaskPanelManager(boxCtx);
  const taskBox = taskPanelMgr.box;

  function refreshTaskPanel() {
    taskPanelMgr.refresh(state.tasks);
  }

  function handleTaskToolStart(args: Record<string, unknown>) {
    const action = typeof args.action === 'string' ? args.action : '';
    const id = typeof args.id === 'number' ? args.id : 0;
    const title = typeof args.title === 'string' ? args.title : '';

    if (action === 'create' && title) {
      const newId =
        state.tasks.length > 0
          ? Math.max(...state.tasks.map((task) => task.id)) + 1
          : 1;
      state.tasks.push({ id: newId, status: 'pending', title });
    } else if (action === 'complete') {
      const task = state.tasks.find((tk) => tk.id === id);
      if (task) {task.status = 'completed';}
    } else if (action === 'skip') {
      const task = state.tasks.find((tk) => tk.id === id);
      if (task) {task.status = 'skipped';}
    } else if (action === 'edit') {
      const task = state.tasks.find((tk) => tk.id === id);
      if (task && title) {task.title = title;}
    } else if (action === 'delete') {
      state.tasks = state.tasks.filter((tk) => tk.id !== id);
    } else if (action === 'start' || action === 'in_progress') {
      const task = state.tasks.find((tk) => tk.id === id);
      if (task) {task.status = 'in_progress';}
    }
    refreshTaskPanel();
  }

  const MAX_INPUT_HEIGHT = 6;
  const inputSeparatorTop = new TextRenderable(renderer, {
    content: '─'.repeat(500),
    fg: COLORS.border,
    height: 1,
    id: 'input-separator-top',
    selectable: false,
    width: '100%',
  });

  const inputRow = new BoxRenderable(renderer, {
    flexDirection: 'row',
    height: 1,
    id: 'input-row',
    paddingBottom: 0,
    paddingLeft: 1,
    paddingRight: 1,
    paddingTop: 0,
    width: '100%',
  });

  const inputPrefixBox = new BoxRenderable(renderer, {
    flexDirection: 'column',
    height: 1,
    id: 'input-prefix',
    width: 2,
  });

  function createPrefixLine(): TextRenderable {
    return new TextRenderable(renderer, {
      attributes: TextAttributes.BOLD,
      content: '┃',
      fg: accent(),
      height: 1,
      id: nextId(),
      selectable: false,
      width: 2,
    });
  }

  inputPrefixBox.add(createPrefixLine());

  const inputField = new TextareaRenderable(renderer, {
    cursorColor: COLORS.accent,
    flexGrow: 1,
    height: 1,
    id: 'input',
    keyBindings: [
      ...defaultTextareaKeyBindings.filter(
        (b) =>
          b.name !== 'return' && b.name !== 'kpenter' && b.name !== 'linefeed',
      ),
      { action: 'submit', name: 'return' },
      { action: 'newline', name: 'return', shift: true },
    ],
    onContentChange: () => {
      const text = inputField.plainText;
      const lines = text.split('\n');
      const termWidth = renderer.terminalWidth ?? 80;
      const availWidth = Math.max(20, termWidth - 5);

      let visualLines = 0;
      for (const line of lines) {
        visualLines += Math.max(1, Math.ceil(line.length / availWidth));
      }
      visualLines = Math.max(1, visualLines);
      const targetHeight = Math.min(visualLines, MAX_INPUT_HEIGHT);

      const prefixCount = inputPrefixBox.getChildren().length;
      if (targetHeight > prefixCount) {
        for (let i = prefixCount; i < targetHeight; i++) {
          inputPrefixBox.add(createPrefixLine());
        }
      } else if (targetHeight < prefixCount) {
        const kids = inputPrefixBox.getChildren();
        while (kids.length > targetHeight) {
          const last = kids.pop();
          if (last) {last.destroy();}
        }
      }

      if (inputRow.height !== targetHeight) {
        inputRow.height = targetHeight;
        inputField.height = targetHeight;
        inputPrefixBox.height = targetHeight;
      }
    },
    onSubmit: () => {},
    placeholder: 'Type your message...',
    textColor: COLORS.white,
    wrapMode: 'word',
  });
  inputRow.add(inputPrefixBox);
  inputRow.add(inputField);
  root.add(confirmBoxMgr.box);
  root.add(permissionBoxMgr.box);
  root.add(inputSeparatorTop);
  root.add(inputRow);

  const completion = new CompletionManager({
    accent: (): string => accent(),
    completionBox,
    completionScroll,
    cwd,
    inputField,
    inputSeparatorTop,
    nextId,
    renderer,
  });

  const inputSeparatorBottom = new TextRenderable(renderer, {
    content: '─'.repeat(500),
    fg: COLORS.border,
    height: 1,
    id: 'input-separator-bottom',
    selectable: false,
    width: '100%',
  });
  root.add(inputSeparatorBottom);

  const statusBar = new BoxRenderable(renderer, {
    flexDirection: 'row',
    height: 1,
    id: 'status-bar',
    padding: { left: 1, right: 1 },
    width: '100%',
  });
  const statusSpinner = new TextRenderable(renderer, {
    content: '',
    fg: COLORS.accent,
    id: 'status-spinner',
    selectable: false,
  });
  const statusText = new TextRenderable(renderer, {
    content: '',
    fg: COLORS.gray,
    flexGrow: 1,
    id: 'status-text',
    selectable: false,
  });
  const statusMode = new TextRenderable(renderer, {
    content: '',
    fg: COLORS.planAccent,
    id: 'status-mode',
    selectable: false,
  });
  const statusPath = new TextRenderable(renderer, {
    content: '',
    fg: COLORS.gray,
    id: 'status-path',
    selectable: false,
  });
  statusBar.add(statusSpinner);
  statusBar.add(statusMode);
  statusBar.add(statusText);
  statusBar.add(statusPath);
  root.add(statusBar);

  const viewerOverlay = new BoxRenderable(renderer, {
    flexDirection: 'column',
    height: '100%',
    id: 'viewer-overlay',
    visible: false,
    width: '100%',
  });

  const mainTuiChildren = [
    header,
    messagesScroll,
    completionBox,
    taskStatusBar,
    resultBox,
    confirmBox,
    permissionBox,
    specApprovalBox,
    queuePanelMgr.box,
    taskBox,
    subBox,
    inputSeparatorTop,
    inputRow,
    inputSeparatorBottom,
    statusBar,
  ];

  function hideMainTui() {
    for (const child of mainTuiChildren) {
      root.remove(child);
    }
    if (viewerOverlay.getParent() === null) {root.add(viewerOverlay);}
    viewerOverlay.visible = true;
  }

  function showMainTui() {
    viewerOverlay.visible = false;
    root.remove(viewerOverlay);
    for (const child of mainTuiChildren) {
      root.add(child);
    }
  }

  const planStatusLine = new TextRenderable(renderer, {
    content: '',
    fg: COLORS.planAccent,
    id: 'plan-status',
    visible: false,
  });
  messagesScroll.add(planStatusLine);


  function updateHeader() {
    headerTitle.content = state.planMode ? 'lavalamp [PLAN]' : 'lavalamp';
    headerTitle.fg = accent();
    statusPath.content = shortenPath(cwd);
  }

  function updatePromptChar() {
    inputField.cursorColor = accent();
    for (const child of inputPrefixBox.getChildren()) {
      if (child instanceof TextRenderable) {
        child.fg = accent();
      }
    }
  }


  function updateStatus() {
    refreshSubPanel();
    const subCount = state.subAgents.filter(
      (sub) => sub.status === 'running',
    ).length;
    const sudo = isAllowAll() ? ' | ░▒▓ SUDO ▓▒░' : '';

    if (state.planMode) {
      statusMode.content = 'PLAN ';
      statusMode.fg = COLORS.planAccent;
      statusMode.visible = true;
    } else {
      statusMode.content = '';
      statusMode.visible = false;
    }

    if (state.processing) {
      statusSpinner.content = `${SPINNER_FRAMES[spinnerFrame]} `;
      statusSpinner.fg = accent();
      statusSpinner.visible = true;
      statusText.content = '';
    } else if (state.queuePending.length > 0) {
      statusSpinner.content = '';
      statusSpinner.visible = false;
      statusText.content = `queued: ${state.queuePending.length} messages${subCount ? ` | ${subCount} subagents running` : ''}${sudo}`;
      statusText.fg = COLORS.yellow;
    } else {
      const isSubsRunning = subCount > 0;
      if (isSubsRunning) {
        statusSpinner.content = `${SPINNER_FRAMES[spinnerFrame]} `;
        statusSpinner.fg = accent();
        statusSpinner.visible = true;
        statusText.content = `${subCount} subagents running${sudo}`;
      } else {
        statusSpinner.content = '';
        statusSpinner.visible = false;
        statusText.content = sudo ? sudo.replace(' | ', '') : '';
      }
      statusText.fg = sudo ? COLORS.pink : COLORS.gray;
    }
  }

  function applyModeVisuals() {
    updatePromptChar();
    updateHeader();
    updateStatus();
    inputField.focus();
    renderer.requestRender();
  }

  async function setPlanMode(enabled: boolean) {
    const targetAgent = enabled ? 'plan' : 'build';
    state.planMode = enabled;
    applyModeVisuals();
    flue.setAgentName(targetAgent);
    try {
      await flue.restart();
    } catch (error) {
      addInfoLine(
        `  Error restarting agent: ${(error as Error).message}`,
        COLORS.red,
      );
    }
  }

  function hideLavaLamp() {
    if (lavaLampBox.visible) {lavaLampBox.visible = false;}
  }

  function summarizeToolArgsShort(
    name: string,
    args: Record<string, unknown>,
  ): string {
    switch (name) {
      case 'bash': {
        const cmd =
          typeof args.command === 'string'
            ? args.command
            : (typeof args.cmd === 'string'
              ? args.cmd
              : '');
        return cmd.length > 50 ? `${cmd.slice(0, 47)  }...` : cmd;
      }
      case 'read':
      case 'write':
      case 'edit': {
        const fp =
          typeof args.file_path === 'string'
            ? args.file_path
            : (typeof args.path === 'string'
              ? args.path
              : '');
        return stripCwd(fp, cwd);
      }
      case 'fetch_url':
      case 'web_search': {
        const url =
          typeof args.url === 'string'
            ? args.url
            : (typeof args.query === 'string'
              ? args.query
              : '');
        return url.length > 50 ? `${url.slice(0, 47)  }...` : url;
      }
      case 'ripgrep':
      case 'grep':
      case 'codebase_search': {
        const q =
          typeof args.pattern === 'string'
            ? args.pattern
            : (typeof args.query === 'string'
              ? args.query
              : '');
        return q.length > 50 ? `${q.slice(0, 47)  }...` : q;
      }
      default: {
        const entries = Object.entries(args);
        if (entries.length === 0) {return '';}
        const parts: string[] = [];
        for (const [, v] of entries.slice(0, 2)) {
          if (typeof v === 'string')
            {parts.push(v.length > 30 ? `${v.slice(0, 27)  }...` : v);}
          else if (typeof v === 'number' || typeof v === 'boolean')
            {parts.push(String(v));}
        }
        return parts.join(' ');
      }
    }
  }

  const storedDiffs = new Map<string, { diff: string; filePath: string }>();

  const messageRenderer = new MessageRenderer({
    hideLavaLamp,
    messagesScroll,
    nextId,
    renderer,
  });

  const toolUiCtx = {
    cwd,
    hideLavaLamp,
    messagesScroll,
    nextId,
    renderer,
    requestScroll,
    storedDiffs,
  };
  const toolUiMgr = new ToolUiManager(toolUiCtx);

  function updateTaskStatus(name: string, args: Record<string, unknown>) {
    const summary = summarizeToolArgsShort(name, args);
    taskStatusText.content = `  ${name} ${summary}`;
    taskStatusText.fg = COLORS.green;
    taskStatusBar.visible = true;
  }

  function clearTaskStatus() {
    taskStatusBar.visible = false;
    taskStatusText.content = '';
  }

  let _userMessageCount = 0;

  function addUserLine(content: string) {
    messageRenderer.addUser(content);
  }

  function addAssistantMarkdown(content: string) {
    messageRenderer.addAssistantMarkdown(content);
  }

  function addInfoLine(content: string, color?: string) {
    messageRenderer.addInfo(content, color);
  }

  function populateToolEntryContent(
    entry: { content?: string; label?: string },
    toolName: string,
    args: Record<string, unknown>,
    resultStr: string,
    isError: boolean,
    durationMs?: number,
  ) {
    toolUiMgr.populateToolEntryContent(
      entry,
      toolName,
      args,
      resultStr,
      isError,
      durationMs,
    );
  }

  function closeViewer(offKey: () => void) {
    offKey();
    for (const child of viewerOverlay.getChildren()) {
      child.destroy();
    }
    showMainTui();
    inputField.focus();
  }

  interface ToolGroupEntry {
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

  function finalizeToolGroup() {
    toolUiMgr.finalizeToolGroup();
  }

  function getOrCreateToolGroup(name: string) {
    return toolUiMgr.getOrCreateToolGroup(name);
  }

  function addToolGroupEntry(
    name: string,
    summary: string,
    args: Record<string, unknown>,
  ): ToolGroupEntry {
    return toolUiMgr.addToolGroupEntry(name, summary, args);
  }

  let currentThinkingBlock: BoxRenderable | null = null;

  function createThinkingBlock(): BoxRenderable {
    return messageRenderer.createThinkingBlock();
  }

  function finalizeThinkingBlock() {
    if (currentThinkingBlock) {
      const kept = messageRenderer.finalizeThinkingBlock(
        currentThinkingBlock,
        currentThinkingText,
      );
      if (!kept) {
        currentThinkingBlock = null;
      }
    }
    currentThinkingText = '';
    streamingThinking = false;
  }

  let currentAssistantMd: MarkdownRenderable | null = null;

  function finalizeAssistantStream() {
    if (currentAssistantMd) {
      currentAssistantMd.streaming = false;
      currentAssistantMd = null;
    }
  }

  let currentThinkingText = '';
  let streamingThinking = false;
  let streamedAnyText = false;
  let _lastToolBlockId: string | null = null;
  const pendingToolEntries = new Map<string, number>();
  let currentAssistantText = '';
  let accThinking = '';
  let accToolCalls: {
    id: string;
    name: string;
    args: Record<string, unknown>;
    result?: unknown;
    isError?: boolean;
    durationMs?: number;
  }[] = [];
  let accCurrentTool: {
    id: string;
    name: string;
    args: Record<string, unknown>;
  } | null = null;

  function handleEvent(event: FlueEvent) {
    switch (event.type) {
      case 'text_delta': {
        const delta = event.text ?? event.delta ?? '';

        if (streamingThinking && currentThinkingBlock) {
          finalizeThinkingBlock();
        }

        if (!currentAssistantMd) {
          hideLavaLamp();
          currentAssistantMd = new MarkdownRenderable(renderer, {
            conceal: true,
            content: '',
            id: nextId(),
            streaming: true,
            syntaxStyle,
            width: '100%',
          });
          messagesScroll.add(currentAssistantMd);
        }

        currentAssistantMd.content += delta;
        streamedAnyText = true;
        break;
      }

      case 'thinking_delta': {
        finalizeAssistantStream();
        const delta = event.delta ?? event.content ?? '';
        const noisyFlueLog =
          /\[flue:|submission-processing|FlueError|throwIfError|normalizeLogAttributes|OperationFailedError|operation_failed|CallOverrides|persisted-image|direct\([^)]*\) failed:/.test(
            delta,
          ) ||
          /^\}\s*\d+\s*\|/m.test(delta) ||
          /^\d+\s*\|/m.test(delta);
        if (noisyFlueLog) {break;}
        if (!streamingThinking) {
          streamingThinking = true;
          hideLavaLamp();
          const children = messagesScroll.getChildren();
          const last = children.at(-1);
          if (last && last instanceof BoxRenderable) {
            const hasThinking = last.getRenderable('thinking-content');
            if (hasThinking) {
              currentThinkingBlock = last;
              currentThinkingText = '';
              const contentEl =
                currentThinkingBlock.getRenderable('thinking-content');
              if (contentEl && contentEl instanceof TextRenderable) {
                contentEl.visible = true;
              }
              const hdr = currentThinkingBlock
                .getChildren()
                .find((c) => c instanceof BoxRenderable);
              if (hdr) {
                const label = hdr
                  .getChildren()
                  .find((c) => c instanceof TextRenderable);
                if (label && label instanceof TextRenderable) {
                  label.content = 'Reasoning... \u25BC';
                  label.fg = COLORS.link;
                }
              }
            } else {
              currentThinkingBlock = createThinkingBlock();
              messagesScroll.add(currentThinkingBlock);
              currentThinkingText = '';
            }
          } else {
            currentThinkingBlock = createThinkingBlock();
            messagesScroll.add(currentThinkingBlock);
            currentThinkingText = '';
          }
        }
        currentThinkingText += delta;
        accThinking += delta;
        if (currentThinkingBlock) {
          const contentEl =
            currentThinkingBlock.getRenderable('thinking-content');
          if (contentEl && contentEl instanceof TextRenderable)
            {contentEl.content = currentThinkingText;}
        }
        break;
      }

      case 'tool_start': {
        finalizeAssistantStream();
        if (streamingThinking && currentThinkingBlock) {
          finalizeThinkingBlock();
        }
        const name = event.toolName ?? 'unknown';
        const args = event.args ?? {};

        createMutationBackup(name, args);

        if (
          name === 'create_task' ||
          name === 'complete_task' ||
          name === 'start_task' ||
          name === 'edit_task' ||
          name === 'delete_task' ||
          name === 'skip_task'
        ) {
          const action = name.replace('_task', '');
          handleTaskToolStart({ ...args, action});
        }

        const summary = summarizeToolArgs(name, args, cwd);

        const _entry = addToolGroupEntry(name, summary, args);

        state.currentTool = { args, id: `tool-${Date.now()}`, name };
        const grp = toolUiMgr.getActiveGroup();
        if (grp !== null) {
          _lastToolBlockId = `toolgroup-${grp.entries.length - 1}`;
        }
        if (event.toolCallId !== null && grp !== null) {
          pendingToolEntries.set(
            event.toolCallId,
            grp.entries.length - 1,
          );
          accCurrentTool = { args, id: event.toolCallId, name };
        }
        updateTaskStatus(name, args);
        requestScroll();
        break;
      }

      case 'tool': {
        if (event.toolName === 'deploy_parallel_subs') {
          const marker =
            typeof event.result === 'string'
              ? (() => {
                  try {
                    return JSON.parse(event.result) as unknown;
                  } catch {
                    return null;
                  }
                })()
              : event.result;
          if (
            marker !== null &&
            typeof marker === 'object'
          ) {
            const deployMarker = marker as { type: string; queries: string[] };
            if (deployMarker.type === 'parallel_deploy' && Array.isArray(deployMarker.queries)) {
              subManager
                .deploy(deployMarker.queries)
                .catch((error: unknown) =>
                  addInfoLine(
                    `  subagents failed: ${error instanceof Error ? error.message : String(error)}`,
                    COLORS.red,
                  ),
                );
            }
          }
        }
        const activeGrp = toolUiMgr.getActiveGroup();
        if (
          activeGrp !== null &&
          event.toolCallId !== null &&
          pendingToolEntries.has(event.toolCallId)
        ) {
          const idx = pendingToolEntries.get(event.toolCallId) ?? -1;
          if (idx < 0) {break;}
          const entry = activeGrp.entries[idx] as ToolGroupEntry | undefined;
          if (entry !== null) {
            const resultStr = extractResultText(event.result);
            entry.result = resultStr;
            entry.isError = Boolean(event.isError);
            entry.durationMs = event.durationMs;
            populateToolEntryContent(
              entry,
              entry.toolName,
              entry.args,
              resultStr,
              Boolean(event.isError),
              event.durationMs,
            );
          }
          if (accCurrentTool && accCurrentTool.id === event.toolCallId) {
            accToolCalls.push({
              args: accCurrentTool.args,
              durationMs: event.durationMs,
              id: accCurrentTool.id,
              isError: Boolean(event.isError),
              name: accCurrentTool.name,
              result: event.result,
            });
            accCurrentTool = null;
          }
        }
        state.currentTool = null;
        _lastToolBlockId = null;
        clearTaskStatus();
        requestScroll();
        break;
      }

      case 'compaction_start': {
        addInfoLine('  compacting context...', COLORS.dim);
        requestScroll();
        break;
      }
      case 'compaction': {
        addInfoLine(
          `  compacted: ${event.messagesBefore} -> ${event.messagesAfter} messages`,
          COLORS.dim,
        );
        requestScroll();
        break;
      }
      case 'log': {
        break;
      }
      case 'error': {
        const errMsg = event.error ?? event.message ?? 'unknown';
        const cleanMsg =
          typeof errMsg === 'string'
            ? errMsg.replaceAll(/\s+/g, ' ').slice(0, 200)
            : 'unknown error';
        showResultPanel('error', [
          { content: `  ${cleanMsg}`, fg: COLORS.red },
        ]);
        break;
      }
      default: {
        // unhandled event types are silently ignored
        break;
      }
    }
  }

  function finalizeStream() {
    stopSpinner();
    finalizeToolGroup();
    if (currentThinkingBlock && currentThinkingText) {
      const contentEl = currentThinkingBlock.getRenderable('thinking-content');
      if (contentEl && contentEl instanceof TextRenderable) {
        contentEl.content = currentThinkingText;
        contentEl.visible = false;
      }
      const hdr = currentThinkingBlock
        .getChildren()
        .find((c) => c instanceof BoxRenderable);
      if (hdr) {
        const label = hdr
          .getChildren()
          .find((c) => c instanceof TextRenderable);
        if (label && label instanceof TextRenderable) {
          label.content = '\u25B8 Reasoning...';
          label.fg = COLORS.link;
        }
      }
    }
    currentThinkingBlock = null;
    currentThinkingText = '';
    streamingThinking = false;

    clearTaskStatus();

    finalizeAssistantStream();
    state.currentTool = null;
    _lastToolBlockId = null;
    pendingToolEntries.clear();
    streamedAnyText = false;
    requestScroll();
  }

  function clearResponseAccumulators() {
    currentAssistantText = '';
    accThinking = '';
    accToolCalls = [];
    accCurrentTool = null;
  }

  function formatErrorMessage(err: Error): string {
    const message = err.message.trim();
    if (isAuthError(err)) {
      return 'authentication failed (401). Restart lavalamp to re-authenticate.';
    }
    return message.split('\n')[0] ?? 'Unknown error';
  }

  function printUsage(result: FlueResult) {
    const u = result.usage;
    if (u == null) {return;}
    state.usageTotals.input += u.input;
    state.usageTotals.output += u.output;
    state.usageTotals.cacheRead += u.cacheRead;
    state.usageTotals.cacheWrite += u.cacheWrite;
    state.usageTotals.totalTokens += u.totalTokens;
    state.usageTotals.cost += u.cost.total;
    const m = result.model != null ? `${result.model.provider}/${result.model.id}` : '';
    const config = resolveConfig();
    const label = config.usageDisplayMode === 'neurons' ? 'neurons' : 'usage';
    addInfoLine(
      `  ${label}: ${formatTokenCount(u.totalTokens)} tok (${formatCost(u.cost.total)}) | session ${formatTokenCount(state.usageTotals.totalTokens)} tok (${formatCost(state.usageTotals.cost)}) | ${m}`,
      COLORS.dim,
    );
  }

  function readStringArg(
    args: Record<string, unknown>,
    names: string[],
  ): string | undefined {
    for (const name of names) {
      const value = args[name];
      if (typeof value === 'string' && value.length > 0) {
        return value;
      }
    }
    return undefined;
  }

  function extractHashlinePaths(value: unknown): string[] {
    if (typeof value !== 'string') {
      return [];
    }

    const paths: string[] = [];
    for (const line of value.split('\n')) {
      const match = /^\[([^#\]]+)#[^\]]+\]/.exec(line.trim());
      if (match) {
        paths.push(match[1]);
      }
    }
    return paths;
  }

  function unquoteShellWord(word: string): string {
    if (
      (word.startsWith('"') && word.endsWith('"')) ||
      (word.startsWith("'") && word.endsWith("'"))
    ) {
      return word.slice(1, -1);
    }
    return word;
  }

  function looksLikePath(value: string): boolean {
    if (value.length === 0 || value.startsWith('-')) {
      return false;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
      return false;
    }
    return (
      value.includes('/') ||
      value.startsWith('.') ||
      /\.[A-Za-z0-9]{1,8}$/.test(value)
    );
  }

  function extractBashMutationPaths(command: string): string[] {
    const paths: string[] = [];
    const redirectMatches = command.matchAll(
      /(?:^|[\s])(?:\d?>|>>|&>)\s*("[^"]+"|'[^']+'|[^\s;&|]+)/g,
    );
    for (const match of redirectMatches) {
      paths.push(unquoteShellWord(match[1]));
    }

    const words =
      command.match(/"[^"]+"|'[^']+'|[^\s;&|()<>]+/g)?.map(unquoteShellWord) ??
      [];
    const mutatingCommands = new Set([
      'cp',
      'install',
      'mkdir',
      'mv',
      'rm',
      'sed',
      'tee',
      'touch',
      'truncate',
    ]);

    if (!mutatingCommands.has(words[0] ?? '')) {
      return paths;
    }

    for (const word of words.slice(1)) {
      if (looksLikePath(word)) {
        paths.push(word);
      }
    }

    return [...new Set(paths)];
  }

  function getMutationBackupPlan(
    name: string,
    args: Record<string, unknown>,
  ): { paths: string[] } | null {
    if (name === 'write' || name === 'edit') {
      const paths = [
        readStringArg(args, ['file_path', 'path', 'filePath']),
        ...extractHashlinePaths(args.patch),
        ...extractHashlinePaths(args.content),
        ...extractHashlinePaths(args.input),
      ].filter((value): value is string => value !== undefined);
      return paths.length > 0 ? { paths } : null;
    }

    if (name === 'rename') {
      const paths = [
        readStringArg(args, ['oldPath', 'old_path', 'from']),
        readStringArg(args, ['newPath', 'new_path', 'to']),
      ].filter((value): value is string => value !== undefined);
      return paths.length > 0 ? { paths } : null;
    }

    if (name === 'bash') {
      const command = readStringArg(args, ['command', 'cmd']) ?? '';
      if (/^\s*(sed|cat|pwd|ls|find|rg|grep|git\s+(status|diff|show|log|branch))\b/.test(command)) {
        return null;
      }
      const paths = extractBashMutationPaths(command);
      return paths.length > 0 ? { paths } : null;
    }

    return null;
  }

  function createMutationBackup(
    name: string,
    args: Record<string, unknown>,
  ): void {
    if (turnBackupCreated) {
      return;
    }

    const plan = getMutationBackupPlan(name, args);
    if (plan === null) {
      return;
    }

    try {
      const ts = backupEngine.createBackup(plan.paths);
      backupHistory.push(ts);
      turnBackupCreated = true;
    } catch {}
  }

  async function _sendPrompt(prompt: string) {
    state.processing = true;
    turnBackupCreated = false;
    state.historyIndex = -1;
    prompt = withModeTag(prompt);
    state.commandHistory.push(visiblePrompt(prompt));
    hideResultPanel();
    hideConfirm(false);
    startSpinner();

    hideLavaLamp();
    addUserLine(visiblePrompt(prompt));
    state.messages.push({
      content: visiblePrompt(prompt),
      id: nextId(),
      role: 'user',
      timestamp: Date.now(),
    });
    updateStatus();

    clearResponseAccumulators();

    let imageDescriptionContext = '';
    if (attachedImages.length > 0) {
      for (const img of attachedImages) {
        addInfoLine(
          `  [spectacle] Describing clipboard image via Workers AI...`,
          COLORS.dim,
        );
        try {
          const desc = await describeImageWithSpectacle(img.path);
          imageDescriptionContext += `\n\n[ATTACHED IMAGE ${img.tag}: ${img.path}]\n${desc}`;
        } catch (error: unknown) {
          imageDescriptionContext += `\n\n[ATTACHED IMAGE ${img.tag} ERROR: ${error instanceof Error ? error.message : String(error)}]`;
        }
      }
      attachedImages.length = 0; // Clear after processing
    }

    const steeredPrompt = steerPrompt(prompt, cwd) + imageDescriptionContext;

    flue.prompt(
      steeredPrompt,
      {
        onError: (err) => {
          finalizeStream();
          state.processing = false;
          saveSessionSnapshot();
          addInfoLine(`  error: ${formatErrorMessage(err)}`, COLORS.red);

          if (renderer.capabilities && renderer.capabilities.notifications) {
            renderer.triggerNotification(
              `Error: ${formatErrorMessage(err)}`,
              'lavalamp',
            );
          }

          clearResponseAccumulators();
          updateStatus();
          drainPending();
        },
        onEvent: (event) => {
          handleEvent(event);
          if (event.type === 'text_delta')
            {currentAssistantText += event.text ?? event.delta ?? '';}
        },
        onResult: (result) => {
          const didStream = streamedAnyText;
          finalizeStream();
          state.processing = false;

          if (currentAssistantText && !didStream) {
            addAssistantMarkdown(currentAssistantText);
          }
          if (currentAssistantText || accThinking || accToolCalls.length > 0) {
            state.messages.push({
              content: currentAssistantText,
              id: nextId(),
              role: 'assistant',
              thinking: accThinking || undefined,
              timestamp: Date.now(),
              toolCalls: accToolCalls.length > 0 ? accToolCalls : undefined,
            });

            if (state.planMode) {
              showSpecApprovalBox((approved) => {
                if (approved) {
                  setPlanMode(false).catch(() => {});
                }
              });
            }

            const filePaths = extractFilePaths(currentAssistantText, cwd);
            if (filePaths.length > 0) {
              const fileRow = new BoxRenderable(renderer, {
                flexDirection: 'row',
                flexWrap: 'wrap',
                gap: 1,
                id: nextId(),
                width: '100%',
              });
              for (const fp of filePaths.slice(0, 8)) {
                const displayPath = stripCwd(fp, cwd);
                const linkBox = new BoxRenderable(renderer, {
                  focusable: true,
                  height: 1,
                  id: nextId(),
                  onMouseDown: () => {
                    const storedDiff = storedDiffs.get(displayPath);
                    const viewerCtx = {
                      closeViewer,
                      cwd,
                      hideMainTui,
                      nextId,
                      onReadError: (fp: string) =>
                        addInfoLine(`  could not read ${fp}`, COLORS.red),
                      overlay: viewerOverlay,
                      renderer,
                    };
                    if (storedDiff) {
                      openDiffViewer(viewerCtx, fp, storedDiff.diff);
                    } else {
                      openCodeViewer(viewerCtx, fp);
                    }
                  },
                  width: displayPath.length,
                });
                const linkText = new TextRenderable(renderer, {
                  attributes: TextAttributes.UNDERLINE,
                  content: displayPath,
                  fg: COLORS.link,
                  id: nextId(),
                });
                linkBox.add(linkText);
                fileRow.add(linkBox);
              }
              messagesScroll.add(fileRow);
            }
          }

          if (renderer.capabilities && renderer.capabilities.notifications) {
            renderer.triggerNotification('Response complete', 'lavalamp');
          }

          printUsage(result);
          clearResponseAccumulators();
          updateStatus();
          drainPending();
        },
      },
      currentSessionId,
    );
  }

  function drainPending() {
    if (state.steerPending.length > 0) {
      const prompt = state.steerPending.shift();
      if (prompt === null) {return;}
      refreshQueuePanel();
      addInfoLine('  (steer)', COLORS.dim);
      return;
    }
    if (state.queuePending.length > 0) {
      const prompt = state.queuePending.shift();
      if (prompt === null) {return;}
      refreshQueuePanel();
      addInfoLine('  (queued)', COLORS.yellow);
    }
  }

  function handleInterrupt() {
    flue.cancel();
    flue.restart().catch(() => {});
    state.processing = false;
    stopSpinner();
    state.steerPending = [];
    state.queuePending = [];
    refreshQueuePanel();
    state.historyIndex = -1;
    inputField.setText('');
    if (currentAssistantMd) {
      messagesScroll.remove(currentAssistantMd);
      currentAssistantMd.destroy();
      currentAssistantMd = null;
    }
    if (currentThinkingBlock) {
      messagesScroll.remove(currentThinkingBlock);
      currentThinkingBlock.destroy();
      currentThinkingBlock = null;
      currentThinkingText = '';
      streamingThinking = false;
    }
    const grp = toolUiMgr.getActiveGroup();
    if (grp !== null) {
      messagesScroll.remove(grp.box);
      grp.box.destroy();
      toolUiMgr.clearActiveGroup();
    }
    _lastToolBlockId = null;
    pendingToolEntries.clear();
    streamedAnyText = false;
    saveSessionSnapshot();
    clearResponseAccumulators();
    clearTaskStatus();
    addInfoLine('  interrupted', COLORS.yellow);
    updateStatus();
  }

  function printExitSummary(sessionId: string) {
    const reset = '\u001B[0m';
    const accentColor = hexToAnsi(COLORS.accent);
    const dimColor = hexToAnsi(COLORS.dim);
    const cyanColor = hexToAnsi(COLORS.cyan);
    const whiteColor = hexToAnsi(COLORS.white);
    const banner = LAVA_LAMP_FRAMES[0].join('\n');
    process.stdout.write(
      `\n${accentColor}${banner}${reset}\n\n` +
        `${dimColor}session:${reset} ${whiteColor}${sessionId}${reset}\n` +
        `${dimColor}continue:${reset} ${cyanColor}lavalamp --continue ${sessionId}${reset}\n`,
    );
  }

  let exiting = false;
  let exitSummaryPrinted = false;
  let savedSessionOnExit: string | null = null;

  function saveSessionSnapshot(): string | null {
    if (savedSessionOnExit !== null) {return savedSessionOnExit;}
    if (state.processing) {
      if (currentAssistantText || accThinking || accToolCalls.length > 0) {
        state.messages.push({
          content: currentAssistantText,
          id: nextId(),
          role: 'assistant',
          thinking: accThinking || undefined,
          timestamp: Date.now(),
          toolCalls: accToolCalls.length > 0 ? accToolCalls : undefined,
        });
      }
      clearResponseAccumulators();
    }
    if (state.messages.length > 0) {
      const sessionName = nameSession(state.messages);
      savedSessionOnExit = saveSession(
        state.messages,
        sessionName,
        currentSessionId,
      );
      currentSessionId = savedSessionOnExit;
    }
    return savedSessionOnExit;
  }

  function handleExit() {
    if (exiting) {return;}
    exiting = true;

    const savedSessionId = saveSessionSnapshot();
    stopSpinner();
    clearInterval(lavaLampTimer);
    renderer.destroy();
    if (savedSessionId !== null && !exitSummaryPrinted) {
      exitSummaryPrinted = true;
      printExitSummary(savedSessionId);
    }
  }


  function togglePlanMode() {
    setPlanMode(!state.planMode).catch(() => {});
  }

  let sessionPickerActive = false;
  let sessionPickerSelected = 0;
  let sessionPickerSessions: {
    id: string;
    name: string;
    savedAt: number;
    messageCount: number;
  }[] = [];
  const _sessionPickerOffKey: (() => void) | null = null;

  function showSessionPicker(
    sessions: {
      id: string;
      name: string;
      savedAt: number;
      messageCount: number;
    }[],
  ) {
    sessionPickerSessions = sessions;
    sessionPickerSelected = 0;
    sessionPickerActive = true;

    renderPicker();
  }

  function resumeSession(index: number) {
    const chosen = sessionPickerSessions[index];
    if (!chosen) {return;}
    closeSessionPicker();
    const messages = loadSession(chosen.id);
    if (messages !== null) {
      currentSessionId = chosen.id;
      state.messages = messages;

      renderAllMessages();
    }
  }

  function closeSessionPicker() {
    sessionPickerActive = false;
    hideResultPanel();
  }

  function renderPicker() {
    const rows: { content: string; fg?: string; bold?: boolean }[] = [];
    for (let i = 0; i < sessionPickerSessions.length; i++) {
      const s = sessionPickerSessions[i];
      const age = formatAge(s.savedAt);
      const marker = i === sessionPickerSelected ? '\u25B6 ' : '  ';
      const nameStr = s.name.slice(0, 36);
      rows.push({
        bold: i === sessionPickerSelected,
        content: `${marker}${nameStr}  ${s.messageCount} msgs  ${age}`,
        fg: i === sessionPickerSelected ? COLORS.white : COLORS.gray,
      });
    }
    showResultPanel('/sessions', rows);
  }

  function renderAllMessages() {
    for (const child of messagesScroll.getChildren()) {
      if (child.id !== 'lava-lamp-box') {child.destroy();}
    }
    if (state.messages.length > 0) {lavaLampBox.visible = false;}
    _userMessageCount = 0;
    for (const msg of state.messages) {
      renderMessage(msg);
    }
    requestScroll();
  }

  function renderMessage(msg: Message) {
    if (msg.role === 'user') {
      addUserLine(msg.content);
      return;
    }

    addInfoLine(` ~`, accent());

    if (msg.thinking !== null && msg.thinking !== '') {
      const thinkBox = createThinkingBlock();
      const contentEl = thinkBox.getRenderable('thinking-content');
      if (contentEl !== null && contentEl instanceof TextRenderable) {
        contentEl.content = msg.thinking;
        contentEl.visible = false;
      }
      const hdr = thinkBox
        .getChildren()
        .find((c) => c instanceof BoxRenderable);
      if (hdr !== null) {
        const label = hdr
          .getChildren()
          .find((c) => c instanceof TextRenderable);
        if (label !== null && label instanceof TextRenderable) {
          label.content = 'Reasoning... \u25B8';
          label.fg = COLORS.link;
        }
      }
      messagesScroll.add(thinkBox);
    }

    if (msg.toolCalls && msg.toolCalls.length > 0) {
      let grp: ReturnType<typeof getOrCreateToolGroup> | null = null;
      for (const tc of msg.toolCalls) {
        grp = getOrCreateToolGroup(tc.name);
        const summary = summarizeToolArgs(tc.name, tc.args, cwd);
        const entry = addToolGroupEntry(tc.name, summary, tc.args);
        entry.result = extractResultText(tc.result);
        entry.isError = Boolean(tc.isError);
        entry.durationMs = tc.durationMs;
        populateToolEntryContent(
          entry,
          tc.name,
          tc.args,
          entry.result,
          Boolean(tc.isError),
          tc.durationMs,
        );
      }
      if (grp) {finalizeToolGroup();}
    }

    if (msg.content) {
      const md = new MarkdownRenderable(renderer, {
        content: msg.content,
        fg: COLORS.white,
        id: nextId(),
        padding: { left: 1 },
        syntaxStyle,
        width: '100%',
      });
      md.selectable = true;
      messagesScroll.add(md);
    }
  }

  async function _handleSlashCommand(raw: string) {
    const cmd = raw.split(/\s+/)[0].toLowerCase();
    const arg = raw.slice(cmd.length).trim();
    switch (cmd) {
      case '/help': {
        const rows: { content: string; fg?: string; bold?: boolean }[] = [
          { bold: true, content: '  Commands:', fg: COLORS.white },
        ];
        for (const [name, desc] of [
          ['/help', 'Show this help'],
          ['/clear', 'New session'],
          ['/sessions', 'Switch sessions'],
          ['/compact', 'Compact context'],
          ['/memory', 'Show project memory'],
          ['/model', 'Show/change model'],
          ['/gateway', 'Show/change AI Gateway'],
          ['/usage', 'Show neuron meter'],
          ['/workspace', 'Show workspace'],
          ['/skills', 'List skills'],
          ['/mcp', 'List MCP servers'],
          ['/tools', 'List registered tools'],
          ['/subagents', 'List subagents'],
          ['/sudo', 'Dangerously allow every tool'],
          ['/permissions', 'Show permission rules'],
          ['/plan', 'Toggle plan mode'],
          ['/copy', 'Copy session transcript'],
          ['/undo', 'Undo last change'],
          ['/quit', 'Exit'],
        ] as [string, string][]) {
          rows.push({
            bold: true,
            content: `  ${name.padEnd(14)}${desc}`,
            fg: accent(),
          });
        }
        rows.push({ content: '' }, { bold: true, content: '  Keys:', fg: COLORS.white });
        for (const [key, desc] of [
          ['Tab', 'Autocomplete'],
          ['Shift+Tab / Ctrl+P', 'Toggle plan mode'],
          ['Enter', 'Steer or Submit'],
          ['Ctrl+C', 'Interrupt / exit'],
          ['Escape', 'Clear / interrupt'],
        ] as [string, string][]) {
          rows.push({ content: `  ${key.padEnd(14)}${desc}`, fg: COLORS.gray });
        }
        showResultPanel('/help', rows);
        break;
      }
      case '/clear': {
        const sessionName = nameSession(state.messages);
        if (state.messages.length > 0) {
          saveSession(state.messages, sessionName, currentSessionId);
        }
        for (const child of messagesScroll.getChildren()) {
          if (child.id !== 'lava-lamp-box') {child.destroy();}
        }
        lavaLampBox.visible = true;
        state.messages = [];
        currentSessionId = `session_${Date.now()}`;
        hideResultPanel();
        break;
      }
      case '/sessions': {
        const sessions = listSessions();
        if (sessions.length === 0) {
          showResultPanel('/sessions', [
            { content: '  no saved sessions', fg: COLORS.dim },
          ]);
          break;
        }
        showSessionPicker(sessions);
        break;
      }
      case '/compact': {
        const count = state.messages.length;
        if (count === 0) {
          showResultPanel('/compact', [
            { content: '  nothing to compact', fg: COLORS.dim },
          ]);
          break;
        }
        const half = Math.ceil(count / 2);
        const kept = state.messages.slice(half);
        state.messages = kept;
        for (const child of messagesScroll.getChildren()) {
          if (child.id !== 'lava-lamp-box') {child.destroy();}
        }
        if (state.messages.length > 0) {
          lavaLampBox.visible = false;
          for (const msg of state.messages) {renderMessage(msg);}
        } else {
          lavaLampBox.visible = true;
        }
        showResultPanel('/compact', [
          {
            content: `  compacted: kept last ${kept.length} of ${count} messages`,
            fg: COLORS.green,
          },
        ]);
        break;
      }
      case '/memory': {
        const memPath = path.join(cwd, 'AGENTS.md');
        const rows: { content: string; fg?: string; bold?: boolean }[] =
          [];
        try {
          const content = fs.readFileSync(memPath, 'utf8');
          const lines = content.split('\n');
          rows.push({ bold: true, content: '  AGENTS.md:', fg: COLORS.white });
          for (const line of lines.slice(0, 30)) {
            rows.push({ content: `  ${line}`, fg: COLORS.gray });
          }
          if (lines.length > 30)
            {rows.push({
              content: `  ... (${lines.length - 30} more lines)`,
              fg: COLORS.dim,
            });}
        } catch {
          rows.push({ content: '  no AGENTS.md found', fg: COLORS.dim });
        }
        showResultPanel('/memory', rows);
        break;
      }
      case '/model': {
        if (arg.length > 0) {
          const model = getModelEntry(arg);
          if (model === undefined) {
            showResultPanel('/model', [
              { content: `  unknown model: ${arg}`, fg: COLORS.yellow },
              { content: '  run /model to list known models', fg: COLORS.dim },
            ]);
            break;
          }
          if (state.processing) {
            showResultPanel('/model', [
              {
                content: '  cannot change model while a prompt is running',
                fg: COLORS.yellow,
              },
            ]);
            break;
          }
          updateConfig({ defaultModel: arg });
          process.env.LAVALAMP_MODEL = arg;
          state.model = arg;
          await flue.restart();
          showResultPanel('/model', [
            { content: `  model set: ${arg}`, fg: COLORS.green },
          ]);
          updateStatus();
          break;
        }

        const config = resolveConfig();
        const current = state.model ?? (
          config.defaultModel.length > 0 ? config.defaultModel : BUILD_MODEL
        );
        const currentEntry = getModelEntry(current);
        const rows: { content: string; fg?: string; bold?: boolean }[] = [
          { bold: true, content: `  model: ${current}`, fg: COLORS.white },
          {
            content: `  config: ${configPath()}`,
            fg: COLORS.dim,
          },
        ];
        if (currentEntry !== undefined) {
          rows.push({
            content: `  ${currentEntry.displayName} · ${Math.round(currentEntry.contextWindow / 1000)}k ctx · ${currentEntry.functionCalling ? 'tools' : 'no tools'} · ${currentEntry.vision ? 'vision' : 'text'}`,
            fg: COLORS.gray,
          });
        }
        rows.push({ content: '' }, {
          bold: true,
          content: '  available models:',
          fg: COLORS.white,
        });
        for (const model of listModels()) {
          rows.push({
            content: `  ${model.id}  ${model.vision ? 'vision' : 'text'} ${model.gatewaySupport ? 'gateway' : 'direct'}`,
            fg: model.id === current ? accent() : COLORS.gray,
          });
        }
        showResultPanel('/model', rows);
        break;
      }
      case '/gateway': {
        if (arg.length > 0) {
          if (state.processing) {
            showResultPanel('/gateway', [
              {
                content: '  cannot change Gateway while a prompt is running',
                fg: COLORS.yellow,
              },
            ]);
            break;
          }
          if (arg.toLowerCase() === 'off') {
            updateConfig({
              gatewayEnabled: false,
              preferredProviderRoute: 'direct',
            });
            await flue.restart();
            showResultPanel('/gateway', [
              { content: '  AI Gateway disabled', fg: COLORS.green },
            ]);
            break;
          }
          updateConfig({
            gatewayEnabled: true,
            gatewayId: arg,
            preferredProviderRoute: 'gateway',
          });
          await flue.restart();
          showResultPanel('/gateway', [
            { content: `  AI Gateway enabled: ${arg}`, fg: COLORS.green },
          ]);
          break;
        }

        const config = resolveConfig();
        showResultPanel('/gateway', [
          {
            bold: true,
            content: `  gateway: ${config.gatewayEnabled ? 'on' : 'off'}`,
            fg: config.gatewayEnabled ? COLORS.green : COLORS.gray,
          },
          {
            content: `  id: ${config.gatewayId || '(none)'}`,
            fg: COLORS.gray,
          },
          {
            content: `  route: ${config.preferredProviderRoute}`,
            fg: COLORS.gray,
          },
          {
            content: '  use /gateway <id> to enable · /gateway off to disable',
            fg: COLORS.dim,
          },
        ]);
        break;
      }
      case '/usage': {
        const total = state.usageTotals;
        showResultPanel('/usage', [
          { bold: true, content: '  neuron meter', fg: COLORS.white },
          {
            content: `  total: ${formatTokenCount(total.totalTokens)} tokens · ${formatCost(total.cost)}`,
            fg: COLORS.gray,
          },
          {
            content: `  input: ${formatTokenCount(total.input)} · output: ${formatTokenCount(total.output)}`,
            fg: COLORS.gray,
          },
          {
            content: `  cache read: ${formatTokenCount(total.cacheRead)} · cache write: ${formatTokenCount(total.cacheWrite)}`,
            fg: COLORS.dim,
          },
        ]);
        break;
      }
      case '/workspace': {
        showResultPanel('/workspace', [
          { content: `  workspace: ${cwd}`, fg: COLORS.gray },
        ]);
        break;
      }
      case '/skills': {
        const skills = discoverSkills(cwd);
        const rows: { content: string; fg?: string; bold?: boolean }[] =
          [];
        if (skills.length === 0) {
          rows.push({ content: '  no skills found', fg: COLORS.dim });
        } else {
          rows.push({ bold: true, content: '  skills:', fg: COLORS.white });
          for (const s of skills)
            {rows.push({ content: `  #${s}`, fg: accent() });}
        }
        showResultPanel('/skills', rows);
        break;
      }
      case '/mcp': {
        const mcpConfigPath = path.join(
          process.env.HOME ?? '~',
          '.config',
          'opencode',
          'opencode.json',
        );
        const rows: { content: string; fg?: string; bold?: boolean }[] =
          [];
        try {
          const raw = fs.readFileSync(mcpConfigPath, 'utf8');
          const cfg = JSON.parse(raw);
          const servers: Record<string, unknown> = cfg.mcpServers ?? cfg.mcp ?? {};
          const names = Object.keys(servers);
          if (names.length === 0) {
            rows.push({
              content: '  no MCP servers configured',
              fg: COLORS.dim,
            });
          } else {
            rows.push({
              bold: true,
              content: '  MCP servers:',
              fg: COLORS.white,
            });
            for (const name of names) {
              const srv = servers[name];
              const cmd = srv.command ?? '';
              const args = Array.isArray(srv.args) ? srv.args.join(' ') : '';
              rows.push({ bold: true, content: `  ${name}`, fg: accent() });
              if (typeof cmd === 'string' && cmd.length > 0)
                {rows.push({
                  content: `    ${cmd} ${args}`.trim(),
                  fg: COLORS.gray,
                });}
            }
          }
        } catch {
          rows.push({ content: '  no MCP config found', fg: COLORS.dim });
        }
        showResultPanel('/mcp', rows);
        break;
      }
      case '/tools': {
        const toolsPath = path.join(options.cwd, 'dist', 'server.mjs');
        const rows: { content: string; fg?: string; bold?: boolean }[] =
          [];
        try {
          const content = fs.readFileSync(toolsPath, 'utf8');
          const toolMatches = content.matchAll(/name:\s*["']([^"']+)["']/g);
          const toolNames = new Set<string>();
          for (const m of toolMatches) {toolNames.add(m[1]);}
          if (toolNames.size === 0) {
            rows.push({
              content: '  no tools found in harness',
              fg: COLORS.dim,
            });
          } else {
            rows.push({
              bold: true,
              content: '  registered tools:',
              fg: COLORS.white,
            });
            for (const t of [...toolNames].toSorted()) {
              rows.push({ content: `  ${t}`, fg: accent() });
            }
          }
        } catch {
          rows.push({
            content: '  could not read harness build',
            fg: COLORS.dim,
          });
        }
        showResultPanel('/tools', rows);
        break;
      }
      case '/subagents': {
        const rows =
          state.subAgents.length === 0
            ? [{ content: '  no subagents', fg: COLORS.dim }]
            : state.subAgents.map((sub) => ({
                content: `  ${sub.id.padEnd(6)} ${sub.status.padEnd(9)} ${sub.query}`,
                fg:
                  sub.status === 'running'
                    ? COLORS.pink
                    : (sub.status === 'done'
                      ? COLORS.green
                      : COLORS.red),
              }));
        showResultPanel('/subagents', rows);
        break;
      }
      case '/sudo': {
        if (isAllowAll()) {
          setAllowAll(cwd, false);
          showResultPanel('/sudo', [
            { content: '  sudo disabled', fg: COLORS.green },
          ]);
          updateStatus();
          break;
        }
        showConfirm(
          'Sudo Mode',
          [
            {
              content:
                '  DANGER: allow every tool the agent has access to without prompts',
              fg: COLORS.red,
            },
            {
              content:
                '  This includes every tool the agent has access to, such as bash, write, edit, rename, and undo.',
              fg: COLORS.yellow,
            },
            {
              content: '  Enter to enable · Escape to cancel',
              fg: COLORS.dim,
            },
          ],
          (confirmed) => {
            if (!confirmed) {return;}
            setAllowAll(cwd, true);
            showResultPanel('/sudo', [
              { content: '  sudo enabled: all tools allowed', fg: COLORS.pink },
            ]);
            updateStatus();
          },
          10_000,
          true,
          false,
        );
        updateStatus();
        break;
      }
      case '/permissions': {
        const rows: { content: string; fg?: string; bold?: boolean }[] = [
          {
            content: '  rules from .agents/rules.json merge after defaults',
            fg: COLORS.dim,
          },
        ];
        for (const rule of permissionRules.length > 0
          ? permissionRules
          : getDefaultRules()) {
          rows.push({
            content: `  ${rule.action.padEnd(5)} ${rule.tool}${rule.argPattern !== null ? ` (${rule.argPattern})` : ''}`,
            fg:
              rule.action === 'allow'
                ? COLORS.green
                : (rule.action === 'deny'
                  ? COLORS.red
                  : COLORS.yellow),
          });
        }
        showResultPanel('/permissions', rows);
        break;
      }
      case '/copy': {
        const transcript = state.messages
          .map((m) => {
            const prefix = m.role === 'user' ? '> ' : '~ ';
            return `${prefix}${m.content}`;
          })
          .join('\n\n');
        try {
          const proc = Bun.spawnSync(['pbcopy'], {
            stdin: Buffer.from(transcript),
          });
          if (proc.exitCode === 0) {
            showResultPanel('/copy', [
              { content: '  session copied to clipboard', fg: COLORS.green },
            ]);
          } else {
            showResultPanel('/copy', [
              { content: '  failed to copy', fg: COLORS.red },
            ]);
          }
        } catch {
          showResultPanel('/copy', [
            { content: '  pbcopy not available', fg: COLORS.dim },
          ]);
        }
        break;
      }
      case '/plan': {
        togglePlanMode();
        break;
      }
      case '/undo': {
        if (state.messages.length === 0) {
          showResultPanel('/undo', [
            { content: '  nothing to undo', fg: COLORS.dim },
          ]);
          break;
        }
        const lastBackup = backupHistory.pop();
        let restoreMsg = '';
        if (lastBackup !== null) {
          try {
            backupEngine.restoreBackup(lastBackup);
            restoreMsg = ' and restored workspace files';
          } catch (error: unknown) {
            restoreMsg = ` (failed to restore backup: ${error instanceof Error ? error.message : String(error)})`;
          }
        }
        let removedCount = 0;
        while (state.messages.length > 0 && removedCount < 2) {
          state.messages.pop();
          removedCount++;
        }
        renderAllMessages();
        showResultPanel('/undo', [
          {
            content: `  removed last ${removedCount} messages${restoreMsg}`,
            fg: COLORS.dim,
          },
        ]);
        break;
      }
      case '/quit': {
        handleExit();
        break;
      }
      case '/paste-image': {
        const imgPath = await pasteImageFromClipboard(cwd);
        if (imgPath !== null && imgPath !== '') {
          imageCounter++;
          const tag = `[Image ${imageCounter}]`;
          attachedImages.push({ path: imgPath, tag });
          inputField.insertText(tag);
        } else {
          showResultPanel('/paste-image', [
            { content: '  No image found in clipboard', fg: COLORS.yellow },
          ]);
        }
        break;
      }
      default: {
        showResultPanel(cmd, [
          { content: `  unknown command: ${cmd}`, fg: COLORS.yellow },
        ]);
      }
    }
  }

  inputField.focus();

  const keybindingsCtx = {
    addInfoLine,
    completion,
    confirmBox: confirmBoxMgr,
    handleExit,
    handleInterrupt,
    handleSubmit: () => {
      const text = inputField.plainText.trim();
      if (!text) {return;}
      inputField.setText('');
      if (typeof inputField.onContentChange === 'function') {
        inputField.onContentChange();
      }
      _sendPrompt(text).catch(() => {});
    },
    inputField,
    permissionBox: permissionBoxMgr,
    queuePanelRefresh: refreshQueuePanel,
    requestScroll,
    resultPanel: resultPanelMgr,
    store,
    subBox: subPanelMgr,
    subManager,
    togglePlanMode,
    updateStatus,
    viewerOverlay,
    withModeTag,
  };

  renderer.keyInput.on('keypress', (key: KeyEvent) => {
    if (viewerOverlay.visible) {return;}
    if ((key.ctrl || key.meta) && key.name === 'v') {
      pasteImageFromClipboard(cwd)
        .then((imgPath) => {
          if (imgPath !== null && imgPath !== '') {
            imageCounter++;
            const tag = `[Image ${imageCounter}]`;
            attachedImages.push({ path: imgPath, tag });
            inputField.insertText(tag);
            renderer.requestRender();
          }
        })
        .catch(() => {});
    }
    if (sessionPickerActive) {
      if (key.name === 'up' || (key.name === 'k' && !key.ctrl)) {
        sessionPickerSelected = Math.max(0, sessionPickerSelected - 1);
        renderPicker();
        key.stopPropagation();
        return;
      }
      if (key.name === 'down' || (key.name === 'j' && !key.ctrl)) {
        sessionPickerSelected = Math.min(
          sessionPickerSessions.length - 1,
          sessionPickerSelected + 1,
        );
        renderPicker();
        key.stopPropagation();
        return;
      }
      if (key.name === 'return') {
        resumeSession(sessionPickerSelected);
        key.stopPropagation();
        return;
      }
      if (key.name === 'escape') {
        closeSessionPicker();
        key.stopPropagation();
        return;
      }
    }
    if (specApprovalBox.visible) {
      if (key.name === 'y' || key.name === 'return') {
        hideSpecApprovalBox(true);
        key.stopPropagation();
        return;
      }
      if (key.name === 'n' || key.name === 'escape') {
        hideSpecApprovalBox(false);
        key.stopPropagation();
        return;
      }
      key.stopPropagation();
      return;
    }
    handleKeyPress(key, keybindingsCtx);
  });

  process.on('SIGTERM', () => {
    stopSpinner();
    clearInterval(lavaLampTimer);
    renderer.destroy();
  });
  process.on('uncaughtException', (err) => {
    stopSpinner();
    clearInterval(lavaLampTimer);
    let savedId: string | null = null;
    if (state.messages.length > 0) {
      const sessionName = nameSession(state.messages);
      savedId = saveSession(state.messages, sessionName, currentSessionId);
    }
    try {
      renderer.destroy();
    } catch { /* intentionally ignored */ }
    console.error(`[lavalamp] Fatal: ${err.message}`);
    if (savedId !== null) {
      const reset = '\u001B[0m';
      const dimColor = hexToAnsi(COLORS.dim);
      const cyanColor = hexToAnsi(COLORS.cyan);
      const whiteColor = hexToAnsi(COLORS.white);
      const bannerColor = hexToAnsi(COLORS.accent);
      console.error(
        `\n${dimColor}session:${reset} ${whiteColor}${savedId}${reset}\n` +
          `${bannerColor}continue:${reset} ${cyanColor}lavalamp --continue ${savedId}${reset}\n`,
      );
    }
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    addInfoLine(
      `  unhandled: ${err instanceof Error ? err.message : String(err)}`,
      COLORS.red,
    );
  });

  await flue.start();
  updateHeader();
  updatePromptChar();
  updateStatus();

  if (options.resumeSession) {
    if (options.resumeSessionId !== null) {
      const messages = loadSession(options.resumeSessionId);
      if (messages !== null) {
        currentSessionId = options.resumeSessionId;
        state.messages = messages;

        renderAllMessages();
      } else {
        showResultPanel('session', [
          {
            content: `  session not found: ${options.resumeSessionId}`,
            fg: COLORS.red,
          },
        ]);
      }
    } else {
      const sessions = listSessions();
      if (sessions.length === 0) {
        showResultPanel('sessions', [
          { content: '  no saved sessions', fg: COLORS.dim },
        ]);
      } else {
        showSessionPicker(sessions);
      }
    }
  }
}
