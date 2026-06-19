import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  TextareaRenderable,
  ScrollBoxRenderable,
  MarkdownRenderable,
  DiffRenderable,
  CodeRenderable,
  TextAttributes,
} from "@opentui/core";
import { t, green, dim, bold, fg, type StyledText } from "@opentui/core";
import type { KeyEvent, CliRenderer } from "@opentui/core";
import * as fs from "fs";
import * as path from "path";
import { FlueProcess, type FlueEvent, type FlueResult } from "./ipc";
import { COLORS } from "./theme";
import {
  type AppState,
  type Message,
  type ToolCall,
  createInitialState,
} from "./state";
import { ALL_SLASH_COMMANDS, LAVA_LAMP_FRAMES, syntaxStyle } from "./art";
import { walkFiles, discoverSkills, fuzzySearch } from "./discover";
import { nameSession, saveSession, listSessions, loadSession } from "./sessions";
import { stripCwd, summarizeToolArgs, summarizeToolResult, looksLikeDiff, extractResultText, detectLanguage, extractFilePaths, generateSyntheticDiff, EXT_LANG_MAP } from "./tools";
import { clearCredentials } from "../auth/credentials";
import { login } from "../auth/login";

export interface TuiOptions {
  serverPath: string;
  cwd: string;
  agentName?: string;
  model?: string;
  resumeSession?: boolean;
  resumeSessionId?: string;
}

function shortenPath(p: string): string {
  const home = process.env.HOME ?? "";
  if (home && p.startsWith(home)) return "~" + p.slice(home.length);
  return p;
}

function styleBashCommand(cmd: string): StyledText {
  const parts = cmd.split(/(\s+)/);
  const styled: (string | ReturnType<typeof dim> | ReturnType<typeof bold>)[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (/^\s+$/.test(part)) {
      styled.push(part);
    } else if (i === 0 || (!part.startsWith("-") && i <= 1)) {
      styled.push(bold(part));
    } else if (part.startsWith("-")) {
      styled.push(fg("#79C0FF")(part));
    } else if (part.startsWith('"') || part.startsWith("'")) {
      styled.push(fg("#A5D6FF")(part));
    } else {
      styled.push(dim(part));
    }
  }
  return t`${styled[0]}${styled.slice(1)}` as StyledText;
}

export async function startTui(options: TuiOptions): Promise<void> {
  const state = createInitialState(options.cwd, options.model);
  const flue = new FlueProcess(
    options.serverPath,
    options.cwd,
    options.agentName ?? "build",
  );
  const cwd = options.cwd;
  let currentSessionId = `session_${Date.now()}`;

  const renderer: CliRenderer = await createCliRenderer({
    exitOnCtrlC: false,
    screenMode: "alternate-screen",
    useMouse: true,
    exitSignals: [
      "SIGTERM",
      "SIGQUIT",
      "SIGABRT",
      "SIGHUP",
      "SIGBREAK",
      "SIGPIPE",
      "SIGBUS",
    ],
    onDestroy: () => {
      destroyed = true;
      if (spinnerTimer) {
        clearInterval(spinnerTimer);
        spinnerTimer = null;
      }
      clearInterval(lavaLampTimer);
      flue.shutdown().catch(() => {});
    },
  });

  const root = renderer.root;
  root.flexDirection = "column";
  root.width = "100%";
  root.height = "100%";

  const accent = (): string =>
    state.planMode ? COLORS.planAccent : COLORS.accent;
  let idCounter = 0;
  function nextId(): string {
    return `el-${++idCounter}`;
  }

  let destroyed = false;
  let scrollPending = false;
  let userHasScrolledUp = false;
  let lastScrollTop = 0;

  function requestScroll() {
    if (destroyed) return;
    if (userHasScrolledUp) return;
    if (scrollPending) return;
    scrollPending = true;
    queueMicrotask(() => {
      if (!destroyed) messagesScroll.scrollBy(1000);
      scrollPending = false;
    });
  }

  const header = new BoxRenderable(renderer, {
    id: "header",
    flexDirection: "row",
    width: "100%",
    height: 1,
    padding: { left: 1, right: 1 },
  });
  const headerTitle = new TextRenderable(renderer, {
    id: "header-title",
    content: "lavalamp",
    fg: COLORS.accent,
    attributes: TextAttributes.BOLD,
  });
  const headerSep = new TextRenderable(renderer, {
    id: "header-sep",
    content: "  ",
    fg: COLORS.gray,
  });
  const headerPath = new TextRenderable(renderer, {
    id: "header-path",
    content: "",
    fg: COLORS.gray,
  });
  header.add(headerTitle);
  header.add(headerSep);
  header.add(headerPath);
  root.add(header);

  const messagesScroll = new ScrollBoxRenderable(renderer, {
    id: "messages",
    width: "100%",
    flexGrow: 1,
    stickyScroll: false,
    scrollY: true,
    padding: { left: 1, right: 1 },
  });
  root.add(messagesScroll);

  messagesScroll.on("scroll", () => {
    const currentScrollTop = messagesScroll.scrollTop;
    if (currentScrollTop < lastScrollTop) {
      userHasScrolledUp = true;
    } else {
      const scrollHeight = messagesScroll.scrollHeight;
      const atBottom = scrollHeight - currentScrollTop < 50;
      if (atBottom) userHasScrolledUp = false;
    }
    lastScrollTop = currentScrollTop;
  });

  const completionBox = new BoxRenderable(renderer, {
    id: "completion-box",
    flexDirection: "column",
    width: "100%",
    flexShrink: 0,
    maxHeight: 10,
    visible: false,
  });
  const completionScroll = new ScrollBoxRenderable(renderer, {
    id: "completion-scroll",
    width: "100%",
    flexGrow: 1,
    scrollY: true,
    maxHeight: 10,
  });
  completionBox.add(completionScroll);
  root.add(completionBox);

  const lavaLampBox = new BoxRenderable(renderer, {
    id: "lava-lamp-box",
    flexDirection: "column",
    width: "100%",
    flexGrow: 1,
    justifyContent: "center",
    alignItems: "center",
    visible: true,
  });
  const lavaLampText = new TextRenderable(renderer, {
    id: "lava-lamp-text",
    content: LAVA_LAMP_FRAMES[0].join("\n"),
    fg: COLORS.accent,
    selectable: false,
  });
  lavaLampBox.add(lavaLampText);
  messagesScroll.add(lavaLampBox);

  let lavaLampFrame = 0;
  const lavaLampTimer = setInterval(() => {
    if (destroyed) return;
    lavaLampFrame = (lavaLampFrame + 1) % LAVA_LAMP_FRAMES.length;
    lavaLampText.content = LAVA_LAMP_FRAMES[lavaLampFrame].join("\n");
  }, 600);

  const taskStatusBar = new BoxRenderable(renderer, {
    id: "task-status-bar",
    flexDirection: "row",
    width: "100%",
    height: 1,
    padding: { left: 1 },
    visible: false,
  });
  const taskStatusText = new TextRenderable(renderer, {
    id: "task-status-text",
    content: "",
    fg: COLORS.green,
  });
  taskStatusBar.add(taskStatusText);
  root.add(taskStatusBar);

  const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let spinnerFrame = 0;
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;

  function startSpinner() {
    spinnerFrame = 0;
    updateStatus();
    spinnerTimer = setInterval(() => {
      spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
      updateStatus();
    }, 80);
  }

  function stopSpinner() {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
    updateStatus();
  }

  const resultBox = new BoxRenderable(renderer, {
    id: "result-box",
    flexDirection: "column",
    width: "100%",
    flexShrink: 0,
    maxHeight: 20,
    visible: false,
  });
  const resultTitle = new TextRenderable(renderer, {
    id: nextId(),
    content: "",
    fg: COLORS.white,
    attributes: TextAttributes.BOLD,
    width: "100%",
    height: 1,
  });
  const resultScroll = new ScrollBoxRenderable(renderer, {
    id: "result-scroll",
    width: "100%",
    flexGrow: 1,
    scrollY: true,
    maxHeight: 18,
  });
  resultBox.add(resultTitle);
  resultBox.add(resultScroll);
  root.add(resultBox);

  function showResultPanel(title: string, rows: Array<{ content: string; fg?: string; bold?: boolean }>) {
    for (const child of resultScroll.getChildren()) child.destroy();
    resultTitle.content = ` ${title}`;
    resultTitle.fg = COLORS.white;
    for (const row of rows) {
      resultScroll.add(
        new TextRenderable(renderer, {
          id: nextId(),
          content: row.content,
          fg: row.fg ?? COLORS.gray,
          attributes: row.bold ? TextAttributes.BOLD : TextAttributes.NONE,
          width: "100%",
        }),
      );
    }
    resultBox.visible = true;
    resultScroll.scrollTo(0);
  }

  function hideResultPanel() {
    resultBox.visible = false;
    for (const child of resultScroll.getChildren()) child.destroy();
    inputField.focus();
  }

  const confirmBox = new BoxRenderable(renderer, {
    id: "confirm-box",
    flexDirection: "column",
    width: "100%",
    flexShrink: 0,
    borderStyle: "single",
    borderColor: COLORS.warn,
    padding: { left: 1, right: 1, top: 0, bottom: 0 },
    visible: false,
  });
  const confirmTitle = new TextRenderable(renderer, {
    id: nextId(),
    content: "",
    fg: COLORS.warn,
    attributes: TextAttributes.BOLD,
    width: "100%",
    height: 1,
  });
  const confirmBody = new BoxRenderable(renderer, {
    id: "confirm-body",
    flexDirection: "column",
    width: "100%",
  });
  confirmBox.add(confirmTitle);
  confirmBox.add(confirmBody);
  root.add(confirmBox);

  let confirmResolve: ((choice: boolean) => void) | null = null;

  let confirmTimeout: ReturnType<typeof setTimeout> | null = null;

  function showConfirm(title: string, rows: Array<{ content: string; fg?: string }>, resolve: (choice: boolean) => void) {
    for (const child of confirmBody.getChildren()) child.destroy();
    confirmTitle.content = ` ${title}`;
    for (const row of rows) {
      confirmBody.add(
        new TextRenderable(renderer, {
          id: nextId(),
          content: row.content,
          fg: row.fg ?? COLORS.gray,
          width: "100%",
        }),
      );
    }
    confirmBox.visible = true;
    confirmResolve = resolve;
    if (confirmTimeout) clearTimeout(confirmTimeout);
    confirmTimeout = setTimeout(() => {
      if (confirmBox.visible) hideConfirm(false);
    }, 2000);
  }

  function hideConfirm(choice: boolean) {
    confirmBox.visible = false;
    for (const child of confirmBody.getChildren()) child.destroy();
    confirmTitle.content = "";
    if (confirmTimeout) {
      clearTimeout(confirmTimeout);
      confirmTimeout = null;
    }
    if (confirmResolve) {
      const resolve = confirmResolve;
      confirmResolve = null;
      resolve(choice);
    }
  }

  const queueBox = new BoxRenderable(renderer, {
    id: "queue-box",
    flexDirection: "column",
    width: "100%",
    flexShrink: 0,
    borderStyle: "single",
    borderColor: COLORS.border,
    padding: { left: 1, right: 1, top: 0, bottom: 0 },
    visible: false,
  });
  const queueBody = new BoxRenderable(renderer, {
    id: "queue-body",
    flexDirection: "column",
    width: "100%",
  });
  queueBox.add(queueBody);
  root.add(queueBox);

  function refreshQueuePanel() {
    for (const child of queueBody.getChildren()) child.destroy();
    const steerCount = state.steerPending.filter((s) => s.length > 0).length;
    const queueCount = state.queuePending.length;
    if (steerCount === 0 && queueCount === 0) {
      queueBox.visible = false;
      return;
    }
    for (const prompt of state.steerPending) {
      if (!prompt) continue;
      const preview = prompt.length > 60 ? prompt.slice(0, 57) + "..." : prompt;
      queueBody.add(
        new TextRenderable(renderer, {
          id: nextId(),
          content: `\u2191 ${preview}`,
          fg: COLORS.green,
          width: "100%",
        }),
      );
    }
    for (let i = 0; i < state.queuePending.length; i++) {
      const preview = state.queuePending[i].length > 60
        ? state.queuePending[i].slice(0, 57) + "..."
        : state.queuePending[i];
      queueBody.add(
        new TextRenderable(renderer, {
          id: nextId(),
          content: `#${i + 1} ${preview}`,
          fg: COLORS.yellow,
          width: "100%",
        }),
      );
    }
    queueBox.visible = true;
  }

  const taskBox = new BoxRenderable(renderer, {
    id: "task-box",
    flexDirection: "column",
    width: "100%",
    flexShrink: 0,
    borderStyle: "single",
    borderColor: COLORS.accent,
    visible: false,
  });
  const taskTitle = new TextRenderable(renderer, {
    id: "task-title",
    content: " tasks",
    fg: COLORS.accent,
    attributes: TextAttributes.BOLD,
    width: "100%",
    height: 1,
  });
  const taskBody = new BoxRenderable(renderer, {
    id: "task-body",
    flexDirection: "column",
    width: "100%",
  });
  taskBox.add(taskTitle);
  taskBox.add(taskBody);
  root.add(taskBox);

  function refreshTaskPanel() {
    for (const child of taskBody.getChildren()) child.destroy();
    if (state.tasks.length === 0) {
      taskBox.visible = false;
      return;
    }
    const icon: Record<string, string> = {
      pending: "[ ]",
      in_progress: "[>]",
      completed: "[x]",
      skipped: "[-]",
    };
    for (const task of state.tasks) {
      const ico = icon[task.status] ?? "[?]";
      const color = task.status === "completed"
        ? COLORS.dim
        : task.status === "in_progress"
          ? COLORS.accent
          : task.status === "skipped"
            ? COLORS.dim
            : COLORS.white;
      taskBody.add(
        new TextRenderable(renderer, {
          id: nextId(),
          content: `  ${ico} #${task.id} ${task.title}`,
          fg: color,
          width: "100%",
        }),
      );
    }
    taskBox.visible = true;
  }

  function handleTaskToolStart(args: Record<string, unknown>) {
    const action = typeof args.action === "string" ? args.action : "";
    const id = typeof args.id === "number" ? args.id : 0;
    const title = typeof args.title === "string" ? args.title : "";

    if (action === "create" && title) {
      const newId = state.tasks.length > 0
        ? Math.max(...state.tasks.map((t) => t.id)) + 1
        : 1;
      state.tasks.push({ id: newId, title, status: "pending" });
    } else if (action === "complete") {
      const task = state.tasks.find((t) => t.id === id);
      if (task) task.status = "completed";
    } else if (action === "skip") {
      const task = state.tasks.find((t) => t.id === id);
      if (task) task.status = "skipped";
    } else if (action === "edit") {
      const task = state.tasks.find((t) => t.id === id);
      if (task && title) task.title = title;
    } else if (action === "delete") {
      state.tasks = state.tasks.filter((t) => t.id !== id);
    } else if (action === "start" || action === "in_progress") {
      const task = state.tasks.find((t) => t.id === id);
      if (task) task.status = "in_progress";
    }
    refreshTaskPanel();
  }

  const MAX_INPUT_HEIGHT = 6;
  const inputRow = new BoxRenderable(renderer, {
    id: "input-row",
    flexDirection: "row",
    width: "100%",
    height: 1,
    paddingTop: 1,
    paddingBottom: 1,
    paddingLeft: 1,
    paddingRight: 1,
  });

  const inputPrefixBox = new BoxRenderable(renderer, {
    id: "input-prefix",
    flexDirection: "column",
    width: 2,
    height: 1,
  });

  function createPrefixLine(): TextRenderable {
    return new TextRenderable(renderer, {
      id: nextId(),
      content: "\u2503",
      fg: COLORS.blue,
      attributes: TextAttributes.BOLD,
      width: 2,
      height: 1,
    });
  }

  inputPrefixBox.add(createPrefixLine());

  const inputField = new TextareaRenderable(renderer, {
    id: "input",
    flexGrow: 1,
    height: 1,
    placeholder: "Type your message...",
    textColor: COLORS.white,
    cursorColor: COLORS.accent,
    wrapMode: "word",
    keyBindings: [
      { name: "return", action: "submit" },
      { name: "return", shift: true, action: "newline" },
    ],
    onSubmit: () => {
      if (sessionPickerActive) {
        resumeSession(sessionPickerSelected);
        return;
      }
      if (confirmBox.visible || resultBox.visible) return;
      const raw = inputField.plainText.trim();
      inputField.setText("");
      if (!raw) {
        if (state.processing) state.steerPending.push("");
        return;
      }
      if (raw.startsWith("/")) {
        handleSlashCommand(raw);
        return;
      }
      const skillMatch = raw.match(/^#([\w-]+)(?:\s+(.+))?$/);
      if (skillMatch) {
        const [, name, p] = skillMatch;
        sendPrompt(
          p
            ? `Activate the skill "${name}" and then: ${p}`
            : `Activate the skill "${name}" and tell me what it does.`,
        );
        return;
      }
      if (raw.startsWith("!")) {
        const c = raw.slice(1).trim();
        if (c) sendPrompt(`Run shell command: ${c}`);
        return;
      }
      if (state.processing) {
        state.steerPending.push(raw);
        addInfoLine("  (steer queued)", COLORS.dim);
        refreshQueuePanel();
        requestScroll();
        return;
      }
      sendPrompt(state.planMode ? `<<PLAN_MODE>> ${raw}` : raw);
    },
    onContentChange: () => {
      const text = inputField.plainText;
      const lines = text.split("\n");
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
          if (last) last.destroy();
        }
      }

      if (inputRow.height !== targetHeight) {
        inputRow.height = targetHeight;
        inputField.height = targetHeight;
        inputPrefixBox.height = targetHeight;
      }
    },
  });
  inputRow.add(inputPrefixBox);
  inputRow.add(inputField);
  root.add(inputRow);

  const statusBar = new BoxRenderable(renderer, {
    id: "status-bar",
    flexDirection: "row",
    width: "100%",
    height: 1,
    padding: { left: 1, right: 1 },
  });
  const statusSpinner = new TextRenderable(renderer, {
    id: "status-spinner",
    content: "",
    fg: COLORS.accent,
  });
  const statusText = new TextRenderable(renderer, {
    id: "status-text",
    content: "",
    fg: COLORS.gray,
  });
  statusBar.add(statusSpinner);
  statusBar.add(statusText);
  root.add(statusBar);

  const viewerOverlay = new BoxRenderable(renderer, {
    id: "viewer-overlay",
    flexDirection: "column",
    width: "100%",
    height: "100%",
    visible: false,
  });

  const mainTuiChildren = [header, messagesScroll, completionBox, taskStatusBar, resultBox, confirmBox, queueBox, taskBox, inputRow, statusBar];

  function hideMainTui() {
    for (const child of mainTuiChildren) {
      root.remove(child);
    }
    if (!viewerOverlay.getParent()) root.add(viewerOverlay);
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
    id: "plan-status",
    content: "",
    fg: COLORS.planAccent,
    visible: false,
  });
  messagesScroll.add(planStatusLine);

  let completing = false;
  let completionList: string[] = [];
  let completionIndex = 0;
  let completionType: "slash" | "at" | "hash" | null = null;
  let completionBaseCol = 0;
  let savedInput = "";
  let fileCache: string[] | null = null;
  let skillCache: string[] | null = null;

  function getFiles(): string[] {
    if (!fileCache) fileCache = walkFiles(cwd);
    return fileCache;
  }
  function getSkills(): string[] {
    if (!skillCache) skillCache = discoverSkills(cwd);
    return skillCache;
  }

  function triggerCompletion() {
    const before = inputField.plainText;
    const slashIdx = before.lastIndexOf("/");
    if (slashIdx >= 0) {
      const afterSlash = before.slice(slashIdx + 1);
      if (
        (slashIdx === 0 || before[slashIdx - 1] === " ") &&
        !afterSlash.includes(" ")
      ) {
        completionType = "slash";
        completionBaseCol = slashIdx;
        completionList = fuzzySearch(
          afterSlash.toLowerCase(),
          ALL_SLASH_COMMANDS,
        ).map((r) => r.item);
        completionIndex = 0;
        if (completionList.length > 0) {
          completing = true;
          renderCompletions();
        } else {
          hideCompletions();
        }
        return;
      }
    }
    const atMatch = before.match(/@([^\s]*)$/);
    if (atMatch) {
      completionType = "at";
      completionBaseCol = before.lastIndexOf("@");
      completionList = fuzzySearch(atMatch[1].toLowerCase(), getFiles()).map(
        (r) => r.item,
      );
      completionIndex = 0;
      if (completionList.length > 0) {
        completing = true;
        renderCompletions();
      } else {
        hideCompletions();
      }
      return;
    }
    const hashMatch = before.match(/(?:^|\s)#([^\s]*)$/);
    if (hashMatch) {
      completionType = "hash";
      completionBaseCol = before.lastIndexOf("#");
      completionList = fuzzySearch(hashMatch[1].toLowerCase(), getSkills()).map(
        (r) => r.item,
      );
      completionIndex = 0;
      if (completionList.length > 0) {
        completing = true;
        renderCompletions();
      } else {
        hideCompletions();
      }
      return;
    }
    if (completing) hideCompletions();
  }

  function renderCompletions() {
    for (const child of completionScroll.getChildren()) child.destroy();
    const spacer = new BoxRenderable(renderer, {
      id: nextId(),
      width: "100%",
      height: 1,
    });
    completionScroll.add(spacer);
    for (let i = 0; i < completionList.length; i++) {
      const sel = i === completionIndex;
      const row = new BoxRenderable(renderer, {
        id: nextId(),
        flexDirection: "row",
        width: "100%",
        height: 1,
        backgroundColor: sel ? COLORS.completionSelectedBg : undefined,
      });
      row.add(
        new TextRenderable(renderer, {
          id: nextId(),
          content: ` ${completionList[i]}`,
          fg: sel ? accent() : COLORS.gray,
          attributes: sel ? TextAttributes.BOLD : TextAttributes.NONE,
          flexGrow: 1,
          overflow: "hidden",
        }),
      );
      completionScroll.add(row);
    }
    completionScroll.scrollTo(completionIndex);
    completionBox.visible = true;
  }

  function hideCompletions() {
    completing = false;
    completionBox.visible = false;
    for (const child of completionScroll.getChildren()) child.destroy();
  }

  function acceptCompletion() {
    const selected = completionList[completionIndex];
    if (!selected) {
      hideCompletions();
      return;
    }
    if (completionType === "slash") {
      inputField.setText(selected + " ");
    } else {
      const before = inputField.plainText;
      const triggerIdx = completionBaseCol;
      const prefix = before.slice(0, triggerIdx);
      const prefixChar = completionType === "hash" ? "#" : "@";
      inputField.setText(prefix + prefixChar + selected + " ");
    }
    inputField.cursorOffset = inputField.plainText.length;
    hideCompletions();
  }

  function updateHeader() {
    headerTitle.content = state.planMode ? "lavalamp [PLAN]" : "lavalamp";
    headerTitle.fg = accent();
    headerPath.content = shortenPath(cwd);
  }

  function updatePromptChar() {
    inputField.cursorColor = accent();
  }

  function updateStatus() {
    if (state.processing) {
      const q =
        state.queuePending.length > 0
          ? ` | queued: ${state.queuePending.length}`
          : "";
      statusSpinner.content = `${SPINNER_FRAMES[spinnerFrame]} `;
      statusSpinner.visible = true;
      statusText.content = `processing...${q} (Enter: steer, Tab: queue)`;
      statusText.fg = COLORS.gray;
    } else if (state.queuePending.length > 0) {
      statusSpinner.content = "";
      statusSpinner.visible = false;
      statusText.content = `queued: ${state.queuePending.length} messages`;
      statusText.fg = COLORS.yellow;
    } else {
      statusSpinner.content = "";
      statusSpinner.visible = false;
      statusText.content = "";
    }
  }

  function hideLavaLamp() {
    if (lavaLampBox.visible) lavaLampBox.visible = false;
  }

  function summarizeToolArgsShort(name: string, args: Record<string, unknown>): string {
    switch (name) {
      case "bash": {
        const cmd = typeof args.command === "string" ? args.command : typeof args.cmd === "string" ? args.cmd : "";
        return cmd.length > 50 ? cmd.slice(0, 47) + "..." : cmd;
      }
      case "read":
      case "write":
      case "edit": {
        const fp = typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "";
        return stripCwd(fp, cwd);
      }
      case "fetch_url":
      case "web_search": {
        const url = typeof args.url === "string" ? args.url : typeof args.query === "string" ? args.query : "";
        return url.length > 50 ? url.slice(0, 47) + "..." : url;
      }
      case "ripgrep":
      case "grep":
      case "codebase_search": {
        const q = typeof args.pattern === "string" ? args.pattern : typeof args.query === "string" ? args.query : "";
        return q.length > 50 ? q.slice(0, 47) + "..." : q;
      }
      default: {
        const entries = Object.entries(args);
        if (!entries.length) return "";
        const parts: string[] = [];
        for (const [, v] of entries.slice(0, 2)) {
          if (typeof v === "string") parts.push(v.length > 30 ? v.slice(0, 27) + "..." : v);
          else if (typeof v === "number" || typeof v === "boolean") parts.push(String(v));
        }
        return parts.join(" ");
      }
    }
  }

  function updateTaskStatus(name: string, args: Record<string, unknown>) {
    const summary = summarizeToolArgsShort(name, args);
    taskStatusText.content = `  ${name} ${summary}`;
    taskStatusText.fg = COLORS.green;
    taskStatusBar.visible = true;
  }

  function clearTaskStatus() {
    taskStatusBar.visible = false;
    taskStatusText.content = "";
  }

  let userMessageCount = 0;

  function addUserLine(content: string) {
    hideLavaLamp();
    userMessageCount++;
    if (userMessageCount > 1) {
      const gap = new TextRenderable(renderer, {
        id: nextId(),
        content: "",
        width: "100%",
        height: 1,
      });
      messagesScroll.add(gap);
      const sep = new TextRenderable(renderer, {
        id: nextId(),
        content: "\u2500".repeat(60),
        fg: COLORS.dim,
        width: "100%",
      });
      messagesScroll.add(sep);
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const row = new BoxRenderable(renderer, {
        id: nextId(),
        flexDirection: "row",
        width: "100%",
      });
      if (i === 0) {
        row.add(
          new TextRenderable(renderer, {
            id: nextId(),
            content: "\u2503 ",
            fg: COLORS.blue,
            attributes: TextAttributes.BOLD,
          }),
        );
      } else {
        row.add(
          new TextRenderable(renderer, {
            id: nextId(),
            content: "\u2503 ",
            fg: COLORS.blue,
          }),
        );
      }
      row.add(
        new TextRenderable(renderer, {
          id: nextId(),
          content: "  " + lines[i],
          fg: COLORS.blue,
          width: "100%",
          selectable: true,
        }),
      );
      messagesScroll.add(row);
    }
  }

  function addAssistantMarkdown(content: string) {
    hideLavaLamp();
    const md = new MarkdownRenderable(renderer, {
      id: nextId(),
      content,
      syntaxStyle,
      width: "100%",
      conceal: true,
    });
    md.selectable = true;
    messagesScroll.add(md);
  }

  function addInfoLine(content: string, color?: string) {
    hideLavaLamp();
    messagesScroll.add(
      new TextRenderable(renderer, {
        id: nextId(),
        content,
        fg: color ?? COLORS.dim,
        width: "100%",
      }),
    );
  }

  const storedDiffs = new Map<string, { diff: string; filePath: string }>();

  function populateToolEntryContent(
    entry: ToolGroupEntry,
    toolName: string,
    args: Record<string, unknown>,
    resultStr: string,
    isError: boolean,
    durationMs?: number,
  ) {
    const fp = typeof args?.file_path === "string"
      ? args.file_path
      : typeof args?.path === "string"
        ? args.path
        : "";
    const displayPath = stripCwd(fp, cwd);
    const dur = durationMs != null ? ` (${durationMs}ms)` : "";

    if (toolName === "edit" || toolName === "write" || toolName === "patch") {
      let diffStr = looksLikeDiff(resultStr) ? resultStr : "";
      if (!diffStr && toolName === "edit" && typeof args?.oldText === "string" && typeof args?.newText === "string") {
        diffStr = generateSyntheticDiff(displayPath, args.oldText, args.newText);
      } else if (!diffStr && toolName === "write" && typeof args?.content === "string") {
        diffStr = generateSyntheticDiff(displayPath, "", args.content);
      } else if (!diffStr && typeof resultStr === "string" && resultStr.includes("\n")) {
        diffStr = generateSyntheticDiff(displayPath, "", resultStr);
      }
      if (diffStr) storedDiffs.set(displayPath, { diff: diffStr, filePath: fp });
      entry.headerLabel.fg = isError ? COLORS.red : COLORS.green;
      entry.headerLabel.content = `\u2713 Edited${dur} \u25b8`;
      if (diffStr) {
        const ext = fp.split(".").pop() || "";
        const lang = EXT_LANG_MAP[ext];
        const diffComp = new DiffRenderable(renderer, {
          id: nextId(),
          diff: diffStr,
          view: "unified",
          filetype: lang || undefined,
          syntaxStyle,
          showLineNumbers: false,
          height: 12,
          width: "100%",
          selectable: true,
        });
        entry.contentBox.add(diffComp);
        entry.contentBox.visible = true;
      }
    } else if (toolName === "read") {
      entry.headerLabel.fg = isError ? COLORS.red : COLORS.green;
      entry.headerLabel.content = `> ${entry.summary}${dur} \u25b8`;
      if (resultStr && !isError) {
        const allLines = resultStr.split("\n");
        const displayStr = allLines.length > 30
          ? allLines.slice(0, 30).join("\n")
          : resultStr;
        const lang = detectLanguage(fp);
        const code = new CodeRenderable(renderer, {
          id: nextId(),
          content: displayStr,
          filetype: lang,
          syntaxStyle,
          width: "100%",
          selectable: true,
        });
        entry.contentBox.add(code);
        if (allLines.length > 30) {
          entry.contentBox.add(
            new TextRenderable(renderer, {
              id: nextId(),
              content: `  ... (${allLines.length - 30} more lines)`,
              fg: COLORS.dim,
              width: "100%",
            }),
          );
        }
        entry.contentBox.visible = true;
      }
    } else {
      entry.headerLabel.fg = isError ? COLORS.red : COLORS.green;
      entry.headerLabel.content = `> ${entry.summary}${dur} \u25b8`;
      if (resultStr) {
        const resultLines = resultStr.trim().split("\n");
        const tail = resultLines.length > 30 ? resultLines.slice(-30) : resultLines;
        const preview = tail.length > 0 ? tail.join("\n") : "(no output)";
        const truncated = resultLines.length > 30 ? `\n  ... (${resultLines.length - 30} lines above)` : "";
        entry.contentBox.add(
          new TextRenderable(renderer, {
            id: nextId(),
            content: preview + truncated,
            fg: isError ? COLORS.red : COLORS.dim,
            width: "100%",
          }),
        );
        entry.contentBox.visible = true;
      }
    }
    if (entry.contentBox.visible) {
      entry.contentVisible = true;
      const cur = String(entry.headerLabel.content);
      entry.headerLabel.content = cur.replace(/\u25b8$/, "\u25bc");
    }
  }

  function closeViewer(offKey: () => void) {
    offKey();
    for (const child of [...viewerOverlay.getChildren()]) {
      child.destroy();
    }
    showMainTui();
    inputField.focus();
  }

  function installVimKeys(
    scrollBox: ScrollBoxRenderable,
    commandLine: TextRenderable,
    close: () => void,
  ): () => void {
    let commandMode = false;
    let commandBuffer = "";
    let countBuffer = "";
    const SCROLL_STEP = 5;

    function getCount(): number {
      return countBuffer.length > 0 ? Math.max(1, parseInt(countBuffer, 10)) : 1;
    }

    function resetCount() {
      countBuffer = "";
    }

    const offKey = renderer.keyInput.on("keypress", (event: KeyEvent) => {
      if (event.ctrl && event.name === "c") {
        close();
        return;
      }
      if (event.name === "escape") {
        if (commandMode) {
          commandMode = false;
          commandBuffer = "";
          commandLine.content = "";
          commandLine.visible = false;
          resetCount();
          return;
        }
        close();
        return;
      }
      if (commandMode) {
        if (event.name === "return") {
          if (commandBuffer === "q" || commandBuffer === "q!") {
            close();
            return;
          }
          commandMode = false;
          commandBuffer = "";
          commandLine.content = "";
          commandLine.visible = false;
          resetCount();
          return;
        }
        if (event.name === "backspace") {
          commandBuffer = commandBuffer.slice(0, -1);
          commandLine.content = commandBuffer ? `:${commandBuffer}` : "";
          if (!commandBuffer) { commandLine.visible = false; commandLine.content = ""; }
          return;
        }
        if (event.name && event.name.length === 1) {
          commandBuffer += event.name;
          commandLine.content = `:${commandBuffer}`;
          return;
        }
        return;
      }
      if (event.name === ":") {
        commandMode = true;
        commandBuffer = "";
        commandLine.content = ":";
        commandLine.visible = true;
        resetCount();
        return;
      }
      if (event.name === "/") {
        commandMode = true;
        commandBuffer = "";
        commandLine.content = "/";
        commandLine.visible = true;
        resetCount();
        return;
      }
      if (event.name >= "1" && event.name <= "9") {
        countBuffer += event.name;
        return;
      }
      if (event.name === "0" && countBuffer.length > 0) {
        countBuffer += "0";
        return;
      }
      const n = getCount();
      if (event.name === "j" || event.name === "down") {
        scrollBox.scrollBy(n);
        resetCount();
        return;
      }
      if (event.name === "k" || event.name === "up") {
        scrollBox.scrollBy(-n);
        resetCount();
        return;
      }
      if (event.name === "h") {
        scrollBox.scrollBy({ x: -n, y: 0 });
        resetCount();
        return;
      }
      if (event.name === "l") {
        scrollBox.scrollBy({ x: n, y: 0 });
        resetCount();
        return;
      }
      if (event.name === "g" && !event.ctrl && !event.shift) {
        if (countBuffer === "g") {
          scrollBox.scrollTo(0);
          resetCount();
          return;
        }
        countBuffer = "g";
        return;
      }
      if ((event.name === "g" && event.shift) || event.name === "G") {
        if (countBuffer.length > 0) {
          const line = parseInt(countBuffer, 10);
          scrollBox.scrollTo(line);
        } else {
          scrollBox.scrollTo(999999);
        }
        resetCount();
        return;
      }
      if (event.ctrl && event.name === "d") {
        scrollBox.scrollBy(SCROLL_STEP * 2 * n);
        resetCount();
        return;
      }
      if (event.ctrl && event.name === "u") {
        scrollBox.scrollBy(-SCROLL_STEP * 2 * n);
        resetCount();
        return;
      }
      if (event.ctrl && event.name === "f") {
        scrollBox.scrollBy(SCROLL_STEP * 4 * n);
        resetCount();
        return;
      }
      if (event.ctrl && event.name === "b") {
        scrollBox.scrollBy(-SCROLL_STEP * 4 * n);
        resetCount();
        return;
      }
      if (event.ctrl && event.name === "e") {
        scrollBox.scrollBy(n);
        resetCount();
        return;
      }
      if (event.ctrl && event.name === "y") {
        scrollBox.scrollBy(-n);
        resetCount();
        return;
      }
      if (event.name === "0") {
        scrollBox.scrollLeft = 0;
        resetCount();
        return;
      }
      if (event.name === "$") {
        scrollBox.scrollLeft = scrollBox.scrollWidth;
        resetCount();
        return;
      }
      if (event.name === "q") {
        close();
        return;
      }
      resetCount();
    });
    return offKey;
  }

  function openDiffViewer(filePath: string, diffContent: string) {
    const titleBar = new TextRenderable(renderer, {
      id: nextId(),
      content: ` ${filePath} [READ ONLY]`,
      fg: COLORS.link,
      attributes: TextAttributes.BOLD,
      width: "100%",
      height: 1,
    });
    viewerOverlay.add(titleBar);

    const diffScroll = new ScrollBoxRenderable(renderer, {
      id: "diff-scroll",
      width: "100%",
      flexGrow: 1,
      scrollY: true,
      stickyScroll: false,
    });
    const diffEl = new DiffRenderable(renderer, {
      id: nextId(),
      diff: diffContent,
      view: "unified",
      syntaxStyle,
      showLineNumbers: true,
      fg: COLORS.white,
      lineNumberFg: COLORS.dim,
      width: "100%",
    });
    diffScroll.add(diffEl);
    viewerOverlay.add(diffScroll);

    const statusBar = new TextRenderable(renderer, {
      id: nextId(),
      content: " j/k scroll  g/G top/bottom  Ctrl+D/U page  :q quit",
      fg: COLORS.dim,
      width: "100%",
      height: 1,
    });
    viewerOverlay.add(statusBar);

    const commandLine = new TextRenderable(renderer, {
      id: nextId(),
      content: "",
      fg: COLORS.white,
      width: "100%",
      height: 1,
      visible: false,
    });
    viewerOverlay.add(commandLine);

    hideMainTui();
    viewerOverlay.focus();

    const offKey = installVimKeys(diffScroll, commandLine, () => closeViewer(offKey));
  }

  function openCodeViewer(filePath: string) {
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      addInfoLine(`  could not read ${filePath}`, COLORS.red);
      return;
    }
    const lang = detectLanguage(filePath);
    const displayPath = stripCwd(filePath, cwd);

    const titleBar = new TextRenderable(renderer, {
      id: nextId(),
      content: ` ${displayPath} [READ ONLY]`,
      fg: COLORS.link,
      attributes: TextAttributes.BOLD,
      width: "100%",
      height: 1,
    });
    viewerOverlay.add(titleBar);

    const codeScroll = new ScrollBoxRenderable(renderer, {
      id: "code-scroll",
      width: "100%",
      flexGrow: 1,
      scrollY: true,
      scrollX: true,
      stickyScroll: false,
    });
    const codeEl = new CodeRenderable(renderer, {
      id: nextId(),
      content,
      filetype: lang,
      syntaxStyle,
      width: "100%",
      selectable: true,
    });
    codeScroll.add(codeEl);
    viewerOverlay.add(codeScroll);

    const statusBar = new TextRenderable(renderer, {
      id: nextId(),
      content: " j/k scroll  g/G top/bottom  Ctrl+D/U page  :q quit",
      fg: COLORS.dim,
      width: "100%",
      height: 1,
    });
    viewerOverlay.add(statusBar);

    const commandLine = new TextRenderable(renderer, {
      id: nextId(),
      content: "",
      fg: COLORS.white,
      width: "100%",
      height: 1,
      visible: false,
    });
    viewerOverlay.add(commandLine);

    hideMainTui();
    viewerOverlay.focus();

    const offKey = installVimKeys(codeScroll, commandLine, () => closeViewer(offKey));
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

  let toolGroup: {
    box: BoxRenderable;
    toolName: string;
    entries: ToolGroupEntry[];
    headerLabel: TextRenderable;
    contentBox: BoxRenderable;
  } | null = null;

  function finalizeToolGroup() {
    if (!toolGroup) return;
    const n = toolGroup.entries.length;
    toolGroup.headerLabel.content = `\u2713 ${toolGroup.toolName} \u00d7${n} \u25b8`;
    toolGroup.headerLabel.fg = toolGroup.entries.some((e) => e.isError) ? COLORS.red : COLORS.green;
    toolGroup = null;
  }

  function getOrCreateToolGroup(name: string): typeof toolGroup {
    if (toolGroup && toolGroup.toolName === name) return toolGroup;
    if (toolGroup) finalizeToolGroup();

    hideLavaLamp();
    const groupId = nextId();
    const entries: ToolGroupEntry[] = [];
    const box = new BoxRenderable(renderer, {
      id: groupId,
      flexDirection: "column",
      width: "100%",
    });
    const hdr = new BoxRenderable(renderer, {
      id: nextId(),
      flexDirection: "row",
      width: "100%",
      focusable: true,
      onMouseDown: () => {
        const content = box.getRenderable("group-content");
        if (content) {
          content.visible = !content.visible;
          const n = entries.length;
          headerLabel.content = content.visible
            ? `\u2713 ${name} \u00d7${n} \u25bc`
            : `\u2713 ${name} \u00d7${n} \u25b8`;
        }
      },
    });
    const headerLabel = new TextRenderable(renderer, {
      id: nextId(),
      content: `\u2713 ${name} \u00d70 \u25b8`,
      fg: COLORS.dim,
      width: "100%",
    });
    hdr.add(headerLabel);
    box.add(hdr);
    const contentBox = new BoxRenderable(renderer, {
      id: "group-content",
      flexDirection: "column",
      width: "100%",
      paddingLeft: 2,
      visible: false,
    });
    box.add(contentBox);
    messagesScroll.add(box);
    toolGroup = { box, toolName: name, entries, headerLabel, contentBox };
    return toolGroup;
  }

  function addToolGroupEntry(name: string, summary: string, args: Record<string, unknown>): ToolGroupEntry {
    const grp = getOrCreateToolGroup(name);

    const entry: ToolGroupEntry = {
      summary,
      toolName: name,
      args,
      result: "",
      isError: false,
      contentVisible: false,
      contentBox: new BoxRenderable(renderer, {
        id: nextId(),
        flexDirection: "column",
        width: "100%",
        paddingLeft: 1,
        visible: false,
      }),
      headerLabel: new TextRenderable(renderer, {
        id: nextId(),
        content: `> ${summary} \u25b8`,
        fg: COLORS.dim,
        width: "100%",
      }),
    };

    const entryHdr = new BoxRenderable(renderer, {
      id: nextId(),
      flexDirection: "row",
      width: "100%",
      focusable: true,
      onMouseDown: () => {
        entry.contentVisible = !entry.contentVisible;
        entry.contentBox.visible = entry.contentVisible;
        entry.headerLabel.content = entry.contentVisible
          ? `> ${summary} \u25bc`
          : `> ${summary} \u25b8`;
      },
    });
    entryHdr.add(entry.headerLabel);
    grp.contentBox.add(entryHdr);
    grp.contentBox.add(entry.contentBox);
    grp.entries.push(entry);

    grp.headerLabel.content = `\u2713 ${name} \u00d7${grp.entries.length} \u25b8`;

    return entry;
  }

  let currentThinkingBlock: BoxRenderable | null = null;

  function createThinkingBlock(): BoxRenderable {
    const box = new BoxRenderable(renderer, {
      id: nextId(),
      flexDirection: "column",
      width: "100%",
    });
    const hdr = new BoxRenderable(renderer, {
      id: nextId(),
      flexDirection: "row",
      width: "100%",
      focusable: true,
      onMouseDown: () => {
        const content = box.getRenderable("thinking-content");
        if (content) {
          content.visible = !content.visible;
          headerLabel.content = content.visible
            ? "thinking... \u25bc"
            : "thinking... \u25b8";
        }
      },
    });
    const headerLabel = new TextRenderable(renderer, {
      id: nextId(),
      content: "thinking... \u25b8",
      fg: COLORS.link,
    });
    hdr.add(headerLabel);
    box.add(hdr);
    box.add(
      new TextRenderable(renderer, {
        id: "thinking-content",
        content: "",
        fg: COLORS.dim,
        width: "100%",
        visible: true,
      }),
    );
    return box;
  }

  function finalizeThinkingBlock() {
    if (currentThinkingBlock) {
      const isErrorDump = /\[flue:|FlueError|throwIfError|normalizeLogAttributes|OperationFailedError|operation_failed|CallOverrides|persisted-image/.test(currentThinkingText) || /^\}\s*\d+\s*\|/m.test(currentThinkingText);
      if (isErrorDump) {
        messagesScroll.remove(currentThinkingBlock);
        currentThinkingBlock.destroy();
        currentThinkingBlock = null;
      } else if (currentThinkingText) {
        const contentEl = currentThinkingBlock.getRenderable("thinking-content");
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
            label.content = "thinking... \u25b8";
            label.fg = COLORS.link;
          }
        }
      } else {
        messagesScroll.remove(currentThinkingBlock);
        currentThinkingBlock.destroy();
        currentThinkingBlock = null;
      }
    }
    currentThinkingText = "";
    streamingThinking = false;
  }

  let currentAssistantMd: MarkdownRenderable | null = null;

  function finalizeAssistantStream() {
    if (currentAssistantMd) {
      currentAssistantMd.streaming = false;
      currentAssistantMd = null;
    }
  }

  let currentThinkingText = "";
  let streamingThinking = false;
  let streamedAnyText = false;
  let lastToolBlockId: string | null = null;
  const pendingToolEntries = new Map<string, number>();
  let accThinking = "";
  let accToolCalls: Array<{ id: string; name: string; args: Record<string, unknown>; result?: unknown; isError?: boolean; durationMs?: number }> = [];
  let accCurrentTool: { id: string; name: string; args: Record<string, unknown> } | null = null;

  function handleEvent(event: FlueEvent) {
    switch (event.type) {
      case "text_delta": {
        const delta = event.text ?? event.delta ?? "";

        if (streamingThinking && currentThinkingBlock) {
          finalizeThinkingBlock();
        }

        if (!currentAssistantMd) {
          stopSpinner();
          hideLavaLamp();
          currentAssistantMd = new MarkdownRenderable(renderer, {
            id: nextId(),
            content: "",
            syntaxStyle,
            width: "100%",
            streaming: true,
            conceal: true,
          });
          messagesScroll.add(currentAssistantMd);
        }

        currentAssistantMd.content += delta;
        streamedAnyText = true;
        break;
      }

      case "thinking_delta": {
        finalizeAssistantStream();
        const delta = event.delta ?? event.content ?? "";
        const noisyFlueLog = /\[flue:|submission-processing|FlueError|throwIfError|normalizeLogAttributes|OperationFailedError|operation_failed|CallOverrides|persisted-image|direct\([^)]*\) failed:/.test(delta) || /^\}\s*\d+\s*\|/m.test(delta) || /^\d+\s*\|/m.test(delta);
        if (noisyFlueLog) break;
        if (!streamingThinking) {
            stopSpinner();
            streamingThinking = true;
            hideLavaLamp();
            const children = messagesScroll.getChildren();
            const last = children[children.length - 1];
            if (last && last instanceof BoxRenderable) {
              const hasThinking = last.getRenderable("thinking-content");
              if (hasThinking) {
                currentThinkingBlock = last;
                currentThinkingText = "";
                const contentEl = currentThinkingBlock.getRenderable("thinking-content");
                if (contentEl && contentEl instanceof TextRenderable) {
                  contentEl.visible = true;
                }
                const hdr = currentThinkingBlock.getChildren().find((c) => c instanceof BoxRenderable);
                if (hdr) {
                  const label = hdr.getChildren().find((c) => c instanceof TextRenderable);
                  if (label && label instanceof TextRenderable) {
                    label.content = "thinking... \u25bc";
                    label.fg = COLORS.link;
                  }
                }
              } else {
                currentThinkingBlock = createThinkingBlock();
                messagesScroll.add(currentThinkingBlock);
                currentThinkingText = "";
              }
            } else {
              currentThinkingBlock = createThinkingBlock();
              messagesScroll.add(currentThinkingBlock);
              currentThinkingText = "";
            }
        }
        currentThinkingText += delta;
        accThinking += delta;
        if (currentThinkingBlock) {
          const contentEl =
            currentThinkingBlock.getRenderable("thinking-content");
          if (contentEl && contentEl instanceof TextRenderable)
            contentEl.content = currentThinkingText;
        }
        break;
      }

      case "tool_start": {
        finalizeAssistantStream();
        if (streamingThinking && currentThinkingBlock) {
          finalizeThinkingBlock();
        }
        const name = event.toolName ?? "unknown";
        const args = event.args ?? {};

        if (name === "create_task" || name === "complete_task" || name === "start_task" || name === "edit_task" || name === "delete_task" || name === "skip_task") {
          const action = name.replace("_task", "");
          handleTaskToolStart({ action, ...args });
        }

        const summary = summarizeToolArgs(name, args, cwd);

        const entry = addToolGroupEntry(name, summary, args);

        state.currentTool = { id: `tool-${Date.now()}`, name, args };
        lastToolBlockId = `toolgroup-${toolGroup!.entries.length - 1}`;
        if (event.toolCallId) {
          pendingToolEntries.set(event.toolCallId, toolGroup!.entries.length - 1);
          accCurrentTool = { id: event.toolCallId, name, args };
        }
        updateTaskStatus(name, args);
        requestScroll();
        break;
      }

      case "tool": {
        if (toolGroup && event.toolCallId && pendingToolEntries.has(event.toolCallId)) {
          const idx = pendingToolEntries.get(event.toolCallId)!;
          pendingToolEntries.delete(event.toolCallId);
          const entry = toolGroup.entries[idx];
          if (entry) {
            const resultStr = extractResultText(event.result);
            entry.result = resultStr;
            entry.isError = !!event.isError;
            entry.durationMs = event.durationMs;
            populateToolEntryContent(entry, entry.toolName, entry.args, resultStr, !!event.isError, event.durationMs);
          }
          if (accCurrentTool && accCurrentTool.id === event.toolCallId) {
            accToolCalls.push({
              id: accCurrentTool.id,
              name: accCurrentTool.name,
              args: accCurrentTool.args,
              result: event.result,
              isError: !!event.isError,
              durationMs: event.durationMs,
            });
            accCurrentTool = null;
          }
        }
        state.currentTool = null;
        lastToolBlockId = null;
        clearTaskStatus();
        requestScroll();
        break;
      }

      case "compaction_start":
        addInfoLine("  compacting context...", COLORS.dim);
        requestScroll();
        break;
      case "compaction":
        addInfoLine(
          `  compacted: ${event.messagesBefore} -> ${event.messagesAfter} messages`,
          COLORS.dim,
        );
        requestScroll();
        break;
      case "log":
        break;
      case "error": {
        const errMsg = event.error ?? event.message ?? "unknown";
        const cleanMsg = typeof errMsg === "string" ? errMsg.replace(/\s+/g, " ").slice(0, 200) : "unknown error";
        showResultPanel("error", [{ content: `  ${cleanMsg}`, fg: COLORS.red }]);
        break;
      }
    }
  }

  function finalizeStream() {
    stopSpinner();
    finalizeToolGroup();
    if (currentThinkingBlock && currentThinkingText) {
      const contentEl = currentThinkingBlock.getRenderable("thinking-content");
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
          label.content = "\u25b8 thinking...";
          label.fg = COLORS.link;
        }
      }
    }
    currentThinkingBlock = null;
    currentThinkingText = "";
    streamingThinking = false;

    clearTaskStatus();

    finalizeAssistantStream();
    state.currentTool = null;
    lastToolBlockId = null;
    pendingToolEntries.clear();
    streamedAnyText = false;
    requestScroll();
  }

  function isAuthError(err: Error): boolean {
    return /\b401\b/.test(err.message);
  }

  function formatErrorMessage(err: Error): string {
    const message = err.message.trim();
    if (isAuthError(err)) {
      return "authentication failed (401). Re-authenticating...";
    }
    return message.split("\n")[0] || "Unknown error";
  }

  function printUsage(result: FlueResult) {
    if (!result?.usage) return;
    const u = result.usage;
    const m = result.model ? `${result.model.provider}/${result.model.id}` : "";
    addInfoLine(
      `  ${u.totalTokens} tok | $${u.cost.total.toFixed(4)} | ${m}`,
      COLORS.dim,
    );
  }

  function sendPrompt(prompt: string) {
    state.processing = true;
    state.historyIndex = -1;
    savedInput = "";
    state.commandHistory.push(prompt);
    hideResultPanel();
    hideConfirm(false);
    startSpinner();

    hideLavaLamp();
    addUserLine(prompt);
    state.messages.push({
      id: nextId(),
      role: "user",
      content: prompt,
      timestamp: Date.now(),
    });
    updateStatus();

    let responseText = "";
    accThinking = "";
    accToolCalls = [];
    accCurrentTool = null;

    flue.prompt(prompt, {
      onEvent: (event) => {
        handleEvent(event);
        if (event.type === "text_delta")
          responseText += event.text ?? event.delta ?? "";
      },
      onResult: (result) => {
        const didStream = streamedAnyText;
        finalizeStream();
        state.processing = false;

        if (responseText && !didStream) {
          addAssistantMarkdown(responseText);
        }
        if (responseText) {
          state.messages.push({
            id: nextId(),
            role: "assistant",
            content: responseText,
            thinking: accThinking || undefined,
            toolCalls: accToolCalls.length > 0 ? accToolCalls : undefined,
            timestamp: Date.now(),
          });

          const filePaths = extractFilePaths(responseText, cwd);
          if (filePaths.length > 0) {
            const fileRow = new BoxRenderable(renderer, {
              id: nextId(),
              flexDirection: "row",
              width: "100%",
              flexWrap: "wrap",
              gap: 1,
            });
            for (const fp of filePaths.slice(0, 8)) {
              const displayPath = stripCwd(fp, cwd);
              const linkBox = new BoxRenderable(renderer, {
                id: nextId(),
                focusable: true,
                onMouseDown: () => {
                  const storedDiff = storedDiffs.get(displayPath);
                  if (storedDiff) {
                    openDiffViewer(fp, storedDiff.diff);
                  } else {
                    openCodeViewer(fp);
                  }
                },
              });
              const linkText = new TextRenderable(renderer, {
                id: nextId(),
                content: displayPath,
                fg: COLORS.link,
                attributes: TextAttributes.UNDERLINE,
              });
              linkBox.add(linkText);
              fileRow.add(linkBox);
            }
            messagesScroll.add(fileRow);
          }
        }

        if (renderer.capabilities?.notifications) {
          renderer.triggerNotification("Response complete", "lavalamp");
        }

        printUsage(result);
        updateStatus();
        drainPending();
      },
      onError: (err) => {
        finalizeStream();
        state.processing = false;
        addInfoLine(`  error: ${formatErrorMessage(err)}`, COLORS.red);

        if (renderer.capabilities?.notifications) {
          renderer.triggerNotification(`Error: ${formatErrorMessage(err)}`, "lavalamp");
        }

        if (isAuthError(err)) {
          clearCredentials();
          login()
            .then(() => {
              addInfoLine("  login complete. Try your message again.", COLORS.green);
              flue.restart().catch(() => {});
            })
            .catch((loginErr) => {
              addInfoLine(`  login failed: ${loginErr instanceof Error ? loginErr.message : String(loginErr)}`, COLORS.red);
            });
        }
        updateStatus();
        drainPending();
      },
    });
  }

  function drainPending() {
    if (state.steerPending.length > 0) {
      const prompt = state.steerPending.shift()!;
      refreshQueuePanel();
      addInfoLine("  (steer)", COLORS.dim);
      sendPrompt(prompt);
      return;
    }
    if (state.queuePending.length > 0) {
      const prompt = state.queuePending.shift()!;
      refreshQueuePanel();
      addInfoLine("  (queued)", COLORS.yellow);
      sendPrompt(prompt);
      return;
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
    savedInput = "";
    inputField.setText("");
    if (currentAssistantMd) {
      messagesScroll.remove(currentAssistantMd);
      currentAssistantMd.destroy();
      currentAssistantMd = null;
    }
    if (currentThinkingBlock) {
      messagesScroll.remove(currentThinkingBlock);
      currentThinkingBlock.destroy();
      currentThinkingBlock = null;
      currentThinkingText = "";
      streamingThinking = false;
    }
    if (toolGroup) {
      messagesScroll.remove(toolGroup.box);
      toolGroup.box.destroy();
      toolGroup = null;
    }
    lastToolBlockId = null;
    pendingToolEntries.clear();
    streamedAnyText = false;
    clearTaskStatus();
    addInfoLine("  interrupted", COLORS.yellow);
    updateStatus();
  }

  function hexToAnsi(hex: string): string {
    const value = hex.replace("#", "");
    const r = parseInt(value.slice(0, 2), 16);
    const g = parseInt(value.slice(2, 4), 16);
    const b = parseInt(value.slice(4, 6), 16);
    return `\x1b[38;2;${r};${g};${b}m`;
  }

  function printExitSummary(sessionId: string) {
    const reset = "\x1b[0m";
    const accentColor = hexToAnsi(COLORS.accent);
    const dimColor = hexToAnsi(COLORS.dim);
    const cyanColor = hexToAnsi(COLORS.cyan);
    const whiteColor = hexToAnsi(COLORS.white);
    const banner = LAVA_LAMP_FRAMES[0].join("\n");
    process.stdout.write(
      `\n${accentColor}${banner}${reset}\n\n` +
        `${dimColor}session:${reset} ${whiteColor}${sessionId}${reset}\n` +
        `${dimColor}continue:${reset} ${cyanColor}lavalamp --continue ${sessionId}${reset}\n`,
    );
  }

  let exiting = false;
  let exitSummaryPrinted = false;

  function handleExit() {
    if (exiting) return;
    exiting = true;

    const hasMessages = state.messages.length > 0;
    let savedSessionId: string | null = null;
    if (hasMessages) {
      const sessionName = nameSession(state.messages);
      savedSessionId = saveSession(state.messages, sessionName);
      currentSessionId = savedSessionId;
    }
    stopSpinner();
    clearInterval(lavaLampTimer);
    renderer.destroy();
    if (savedSessionId && !exitSummaryPrinted) {
      exitSummaryPrinted = true;
      printExitSummary(savedSessionId);
    }
  }

  function togglePlanMode() {
    state.planMode = !state.planMode;
    if (state.planMode) {
      planStatusLine.content =
        "  plan mode enabled  |  Agent can only read, search, research, and plan  |  Press Shift+Tab or /plan to exit";
      planStatusLine.fg = COLORS.planAccent;
      planStatusLine.visible = true;
    } else {
      planStatusLine.content =
        "  build mode enabled  |  Agent can read, write, edit, and run commands";
      planStatusLine.fg = accent();
      planStatusLine.visible = true;
    }
    updatePromptChar();
    updateHeader();
    requestScroll();
  }

  let sessionPickerActive = false;
  let sessionPickerSelected = 0;
  let sessionPickerSessions: Array<{
    id: string;
    name: string;
    savedAt: number;
    messageCount: number;
  }> = [];
  let sessionPickerOffKey: (() => void) | null = null;

  function showSessionPicker(
    sessions: Array<{
      id: string;
      name: string;
      savedAt: number;
      messageCount: number;
    }>,
  ) {
    sessionPickerSessions = sessions;
    sessionPickerSelected = 0;
    sessionPickerActive = true;

    renderPicker();

    sessionPickerOffKey = renderer.keyInput.on("keypress", (event: KeyEvent) => {
      if (!sessionPickerActive) {
        if (sessionPickerOffKey) { sessionPickerOffKey(); sessionPickerOffKey = null; }
        return;
      }
      if (event.name === "up" || (event.name === "k" && !event.ctrl)) {
        sessionPickerSelected = Math.max(0, sessionPickerSelected - 1);
        renderPicker();
        event.stopPropagation();
      } else if (event.name === "down" || (event.name === "j" && !event.ctrl)) {
        sessionPickerSelected = Math.min(sessionPickerSessions.length - 1, sessionPickerSelected + 1);
        renderPicker();
        event.stopPropagation();
      } else if (event.name === "return") {
        event.stopPropagation();
        resumeSession(sessionPickerSelected);
      } else if (event.name === "escape") {
        event.stopPropagation();
        closeSessionPicker();
      }
    });
  }

  function resumeSession(index: number) {
    const chosen = sessionPickerSessions[index];
    if (!chosen) return;
    closeSessionPicker();
    const messages = loadSession(chosen.id);
    if (messages) {
      currentSessionId = chosen.id;
      state.messages = messages;
      renderAllMessages();
    }
  }

  function closeSessionPicker() {
    sessionPickerActive = false;
    if (sessionPickerOffKey) { sessionPickerOffKey(); sessionPickerOffKey = null; }
    hideResultPanel();
  }

  function renderPicker() {
    const rows: Array<{ content: string; fg?: string; bold?: boolean }> = [];
    for (let i = 0; i < sessionPickerSessions.length; i++) {
      const s = sessionPickerSessions[i];
      const age = formatAge(s.savedAt);
      const marker = i === sessionPickerSelected ? "\u25b6 " : "  ";
      const nameStr = s.name.slice(0, 36);
      rows.push({
        content: `${marker}${nameStr}  ${s.messageCount} msgs  ${age}`,
        fg: i === sessionPickerSelected ? COLORS.white : COLORS.gray,
        bold: i === sessionPickerSelected,
      });
    }
    showResultPanel("/sessions", rows);
  }

  function formatAge(ts: number): string {
    const diff = Date.now() - ts;
    const min = Math.floor(diff / 60000);
    if (min < 1) return "just now";
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const d = Math.floor(hr / 24);
    return `${d}d ago`;
  }

  function renderAllMessages() {
    for (const child of [...messagesScroll.getChildren()]) {
      if (child.id !== "lava-lamp-box") child.destroy();
    }
    if (state.messages.length > 0) lavaLampBox.visible = false;
    userMessageCount = 0;
    for (const msg of state.messages) {
      renderMessage(msg);
    }
    requestScroll();
  }

  function renderMessage(msg: Message) {
    if (msg.role === "user") {
      addUserLine(msg.content);
      return;
    }

    addInfoLine(` ~`, accent());

    if (msg.thinking) {
      const thinkBox = createThinkingBlock();
      const contentEl = thinkBox.getRenderable("thinking-content");
      if (contentEl && contentEl instanceof TextRenderable) {
        contentEl.content = msg.thinking;
        contentEl.visible = false;
      }
      const hdr = thinkBox.getChildren().find((c) => c instanceof BoxRenderable);
      if (hdr) {
        const label = hdr.getChildren().find((c) => c instanceof TextRenderable);
        if (label && label instanceof TextRenderable) {
          label.content = "thinking... \u25b8";
          label.fg = COLORS.link;
        }
      }
      messagesScroll.add(thinkBox);
    }

    if (msg.toolCalls?.length) {
      let grp: ReturnType<typeof getOrCreateToolGroup> | null = null;
      for (const tc of msg.toolCalls) {
        grp = getOrCreateToolGroup(tc.name);
        const summary = summarizeToolArgs(tc.name, tc.args, cwd);
        const entry = addToolGroupEntry(tc.name, summary, tc.args);
        entry.result = typeof tc.result === "string" ? tc.result : tc.result ? JSON.stringify(tc.result, null, 2) : "";
        entry.isError = !!tc.isError;
        entry.durationMs = tc.durationMs;
        populateToolEntryContent(entry, tc.name, tc.args, entry.result, !!tc.isError, tc.durationMs);
      }
      if (grp) finalizeToolGroup();
    }

    if (msg.content) {
      const md = new MarkdownRenderable(renderer, {
        id: nextId(),
        content: msg.content,
        syntaxStyle,
        width: "100%",
        fg: COLORS.white,
        padding: { left: 1 },
      });
      md.selectable = true;
      messagesScroll.add(md);
    }
  }

  function handleSlashCommand(raw: string) {
    const cmd = raw.split(/\s+/)[0].toLowerCase();
    switch (cmd) {
      case "/help": {
        const rows: Array<{ content: string; fg?: string; bold?: boolean }> = [];
        rows.push({ content: "  Commands:", fg: COLORS.white, bold: true });
        for (const [name, desc] of [
          ["/help", "Show this help"],
          ["/clear", "New session"],
          ["/sessions", "Switch sessions"],
          ["/compact", "Compact context"],
          ["/memory", "Show project memory"],
          ["/model", "Show/change model"],
          ["/workspace", "Show workspace"],
          ["/skills", "List skills"],
          ["/mcp", "List MCP servers"],
          ["/tools", "List registered tools"],
          ["/plan", "Toggle plan mode"],
          ["/copy", "Copy session transcript"],
          ["/undo", "Undo last change"],
          ["/quit", "Exit"],
        ] as Array<[string, string]>) {
          rows.push({ content: `  ${name.padEnd(14)}${desc}`, fg: accent(), bold: true });
        }
        rows.push({ content: "" });
        rows.push({ content: "  Keys:", fg: COLORS.white, bold: true });
        for (const [key, desc] of [
          ["Tab", "Autocomplete"],
          ["Shift+Tab", "Toggle plan mode"],
          ["Enter", "Steer or Submit"],
          ["Ctrl+C", "Interrupt / exit"],
          ["Escape", "Clear / interrupt"],
        ] as Array<[string, string]>) {
          rows.push({ content: `  ${key.padEnd(14)}${desc}`, fg: COLORS.gray });
        }
        showResultPanel("/help", rows);
        break;
      }
      case "/clear": {
        const sessionName = nameSession(state.messages);
        if (state.messages.length > 0) {
          saveSession(state.messages, sessionName);
        }
        for (const child of [...messagesScroll.getChildren()]) {
          if (child.id !== "lava-lamp-box") child.destroy();
        }
        lavaLampBox.visible = true;
        state.messages = [];
        currentSessionId = `session_${Date.now()}`;
        hideResultPanel();
        break;
      }
      case "/sessions": {
        const sessions = listSessions();
        if (sessions.length === 0) {
          showResultPanel("/sessions", [{ content: "  no saved sessions", fg: COLORS.dim }]);
          break;
        }
        showSessionPicker(sessions);
        break;
      }
      case "/compact": {
        const count = state.messages.length;
        if (count === 0) {
          showResultPanel("/compact", [{ content: "  nothing to compact", fg: COLORS.dim }]);
          break;
        }
        const half = Math.ceil(count / 2);
        const kept = state.messages.slice(half);
        state.messages = kept;
        for (const child of [...messagesScroll.getChildren()]) {
          if (child.id !== "lava-lamp-box") child.destroy();
        }
        if (state.messages.length > 0) {
          lavaLampBox.visible = false;
          for (const msg of state.messages) renderMessage(msg);
        } else {
          lavaLampBox.visible = true;
        }
        showResultPanel("/compact", [{ content: `  compacted: kept last ${kept.length} of ${count} messages`, fg: COLORS.green }]);
        break;
      }
      case "/memory": {
        const memPath = path.join(cwd, "AGENTS.md");
        const rows: Array<{ content: string; fg?: string; bold?: boolean }> = [];
        try {
          const content = fs.readFileSync(memPath, "utf-8");
          const lines = content.split("\n");
          rows.push({ content: "  AGENTS.md:", fg: COLORS.white, bold: true });
          for (const line of lines.slice(0, 30)) {
            rows.push({ content: `  ${line}`, fg: COLORS.gray });
          }
          if (lines.length > 30) rows.push({ content: `  ... (${lines.length - 30} more lines)`, fg: COLORS.dim });
        } catch {
          rows.push({ content: "  no AGENTS.md found", fg: COLORS.dim });
        }
        showResultPanel("/memory", rows);
        break;
      }
      case "/model":
        showResultPanel("/model", [{ content: `  model: ${state.model ?? "default"}`, fg: COLORS.gray }]);
        break;
      case "/workspace":
        showResultPanel("/workspace", [{ content: `  workspace: ${cwd}`, fg: COLORS.gray }]);
        break;
      case "/skills": {
        const skills = getSkills();
        const rows: Array<{ content: string; fg?: string; bold?: boolean }> = [];
        if (skills.length === 0) {
          rows.push({ content: "  no skills found", fg: COLORS.dim });
        } else {
          rows.push({ content: "  skills:", fg: COLORS.white, bold: true });
          for (const s of skills) rows.push({ content: `  #${s}`, fg: accent() });
        }
        showResultPanel("/skills", rows);
        break;
      }
      case "/mcp": {
        const mcpConfigPath = path.join(
          process.env.HOME ?? "~",
          ".config",
          "opencode",
          "opencode.json",
        );
        const rows: Array<{ content: string; fg?: string; bold?: boolean }> = [];
        try {
          const raw = fs.readFileSync(mcpConfigPath, "utf-8");
          const cfg = JSON.parse(raw);
          const servers = cfg.mcpServers ?? cfg.mcp ?? {};
          const names = Object.keys(servers);
          if (names.length === 0) {
            rows.push({ content: "  no MCP servers configured", fg: COLORS.dim });
          } else {
            rows.push({ content: "  MCP servers:", fg: COLORS.white, bold: true });
            for (const name of names) {
              const srv = servers[name];
              const cmd = srv.command ?? "";
              const args = Array.isArray(srv.args) ? srv.args.join(" ") : "";
              rows.push({ content: `  ${name}`, fg: accent(), bold: true });
              if (cmd) rows.push({ content: `    ${cmd} ${args}`.trim(), fg: COLORS.gray });
            }
          }
        } catch {
          rows.push({ content: "  no MCP config found", fg: COLORS.dim });
        }
        showResultPanel("/mcp", rows);
        break;
      }
      case "/tools": {
        const toolsPath = path.join(options.cwd, "dist", "server.mjs");
        const rows: Array<{ content: string; fg?: string; bold?: boolean }> = [];
        try {
          const content = fs.readFileSync(toolsPath, "utf-8");
          const toolMatches = content.matchAll(/name:\s*["']([^"']+)["']/g);
          const toolNames = new Set<string>();
          for (const m of toolMatches) toolNames.add(m[1]);
          if (toolNames.size === 0) {
            rows.push({ content: "  no tools found in harness", fg: COLORS.dim });
          } else {
            rows.push({ content: "  registered tools:", fg: COLORS.white, bold: true });
            for (const t of [...toolNames].sort()) {
              rows.push({ content: `  ${t}`, fg: accent() });
            }
          }
        } catch {
          rows.push({ content: "  could not read harness build", fg: COLORS.dim });
        }
        showResultPanel("/tools", rows);
        break;
      }
      case "/copy": {
        const transcript = state.messages
          .map((m) => {
            const prefix = m.role === "user" ? "> " : "~ ";
            return `${prefix}${m.content}`;
          })
          .join("\n\n");
        try {
          const proc = Bun.spawnSync(["pbcopy"], { stdin: Buffer.from(transcript) });
          if (proc.exitCode === 0) {
            showResultPanel("/copy", [{ content: "  session copied to clipboard", fg: COLORS.green }]);
          } else {
            showResultPanel("/copy", [{ content: "  failed to copy", fg: COLORS.red }]);
          }
        } catch {
          showResultPanel("/copy", [{ content: "  pbcopy not available", fg: COLORS.dim }]);
        }
        break;
      }
      case "/plan":
        togglePlanMode();
        break;
      case "/undo": {
        if (state.messages.length === 0) {
          showResultPanel("/undo", [{ content: "  nothing to undo", fg: COLORS.dim }]);
          break;
        }
        let removedCount = 0;
        while (state.messages.length > 0 && removedCount < 2) {
          state.messages.pop();
          removedCount++;
        }
        renderAllMessages();
        showResultPanel("/undo", [{ content: `  removed last ${removedCount} messages`, fg: COLORS.dim }]);
        break;
      }
      case "/quit":
        handleExit();
        break;
      default:
        showResultPanel(cmd, [{ content: `  unknown command: ${cmd}`, fg: COLORS.yellow }]);
    }
  }

  inputField.focus();

  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    if (viewerOverlay.visible) return;
    if (key.ctrl && key.name === "c") {
      if (confirmBox.visible) {
        hideConfirm(true);
      } else if (state.processing) {
        handleInterrupt();
      } else {
        showConfirm("Ctrl+C", [
          { content: "  press Ctrl+C again to exit", fg: COLORS.dim },
          { content: "  Escape to cancel", fg: COLORS.dim },
        ], (confirmed) => {
          if (confirmed) handleExit();
        });
      }
      key.stopPropagation();
      return;
    }
    if (key.name === "escape") {
      if (confirmBox.visible) {
        hideConfirm(false);
        key.stopPropagation();
        return;
      }
      if (completing) {
        hideCompletions();
        key.stopPropagation();
        return;
      }
      if (resultBox.visible) {
        hideResultPanel();
        key.stopPropagation();
        return;
      }
      if (state.processing) {
        handleInterrupt();
        key.stopPropagation();
        return;
      }
      const now = Date.now();
      if (now - state.lastEscape < 500) inputField.setText("");
      state.lastEscape = now;
      key.stopPropagation();
      return;
    }
    if (key.name === "up" || key.name === "down") {
      if (completing) {
        completionIndex =
          key.name === "up"
            ? (completionIndex - 1 + completionList.length) %
              completionList.length
            : (completionIndex + 1) % completionList.length;
        renderCompletions();
        key.stopPropagation();
        return;
      }
    }
    if (key.name === "tab" && key.shift) {
      togglePlanMode();
      key.stopPropagation();
      return;
    }
    if (key.name === "tab" && !key.shift) {
      if (completing) {
        completionIndex = (completionIndex + 1) % completionList.length;
        renderCompletions();
        key.stopPropagation();
        return;
      }
      if (state.processing) {
        const raw = inputField.plainText.trim();
        if (raw) {
          state.queuePending.push(raw);
          inputField.setText("");
          addInfoLine(
            `  (queued #${state.queuePending.length})`,
            COLORS.yellow,
          );
          refreshQueuePanel();
          updateStatus();
          requestScroll();
        }
        key.stopPropagation();
        return;
      }
      triggerCompletion();
      key.stopPropagation();
      return;
    }
    if (key.ctrl && key.name === "d" && !inputField.plainText) {
      handleExit();
      key.stopPropagation();
      return;
    }
    if (completing && key.name === "return" && !key.shift) {
      acceptCompletion();
      key.stopPropagation();
      return;
    }
    if (!key.ctrl && !key.meta && key.name && key.name.length === 1) {
      queueMicrotask(() => {
        const val = inputField.plainText;
        if (val.match(/(\/|#)\S*$/) || val.match(/@\S*$/)) {
          triggerCompletion();
        } else if (completing) {
          hideCompletions();
        }
      });
    }
    if (key.name === "backspace" && completing) {
      queueMicrotask(() => {
        const val = inputField.plainText;
        if (!val.match(/(\/|#)\S*$/) && !val.match(/@\S*$/)) hideCompletions();
        else triggerCompletion();
      });
    }
  });

  process.on("SIGTERM", () => {
    stopSpinner();
    clearInterval(lavaLampTimer);
    renderer.destroy();
  });
  process.on("uncaughtException", (err) => {
    stopSpinner();
    clearInterval(lavaLampTimer);
    let savedId: string | null = null;
    if (state.messages.length > 0) {
      const sessionName = nameSession(state.messages);
      savedId = saveSession(state.messages, sessionName);
    }
    try {
      renderer.destroy();
    } catch {}
    console.error(`[lavalamp] Fatal: ${err.message}`);
    if (savedId) {
      const reset = "\x1b[0m";
      const accentColor = hexToAnsi(COLORS.accent);
      const dimColor = hexToAnsi(COLORS.dim);
      const cyanColor = hexToAnsi(COLORS.cyan);
      const whiteColor = hexToAnsi(COLORS.white);
      console.error(
        `\n${dimColor}session:${reset} ${whiteColor}${savedId}${reset}\n` +
        `${dimColor}continue:${reset} ${cyanColor}lavalamp --continue ${savedId}${reset}\n`,
      );
    }
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => {
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
    if (options.resumeSessionId) {
      const messages = loadSession(options.resumeSessionId);
      if (messages) {
        currentSessionId = options.resumeSessionId;
        state.messages = messages;
        renderAllMessages();
      } else {
        showResultPanel("session", [{ content: `  session not found: ${options.resumeSessionId}`, fg: COLORS.red }]);
      }
    } else {
      const sessions = listSessions();
      if (sessions.length === 0) {
        showResultPanel("sessions", [{ content: "  no saved sessions", fg: COLORS.dim }]);
      } else {
        showSessionPicker(sessions);
      }
    }
  }
}
