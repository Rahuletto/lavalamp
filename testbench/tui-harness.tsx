import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { KeyEvent } from '@opentui/core';
import React, { useState } from 'react';
import { HELP_KEYS, SLASH_COMMANDS } from '../src/tui/slash-data.ts';
import { BUILD_MODEL, getModelEntry, listModels } from '../src/config/models.ts';
import { getDefaultRules } from '../src/permissions/rules.ts';
import { discoverSkills } from '../src/tui/discover.ts';
import {
  createModelPickerState,
  moveModelPickerSelection,
  selectedModelId,
  type ModelPickerState,
} from '../src/tui/model-picker.ts';

export interface SlashCommandResult {
  title: string;
  lines: string[];
}

export interface SlashCommandHarnessOptions {
  cwd: string;
}

export interface BenchMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface BenchSession {
  id: string;
  name: string;
  messages: BenchMessage[];
}

export interface BenchHarnessState {
  allowAll: boolean;
  clipboard: string;
  exitRequested: boolean;
  gatewayEnabled: boolean;
  gatewayId: string;
  messages: BenchMessage[];
  model: string;
  planMode: boolean;
  savedSessions: BenchSession[];
  usageTotals: {
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    input: number;
    output: number;
    totalTokens: number;
  };
}

export interface SlashCommandHarness {
  run(commandLine: string): Promise<SlashCommandResult>;
  runSync(commandLine: string): SlashCommandResult;
  seedMessages(messages: BenchMessage[]): void;
  state(): BenchHarnessState;
}

function formatCommand(command: string): string {
  const description =
    SLASH_COMMANDS.find(([name]) => name === command)?.[1] ?? 'command';
  return `${command.padEnd(14)}${description}`;
}

function commandOnly(commandLine: string): string {
  return commandLine.split(/\s+/)[0]?.toLowerCase() ?? '';
}

function cloneState(state: BenchHarnessState): BenchHarnessState {
  return {
    ...state,
    messages: state.messages.map((message) => ({ ...message })),
    savedSessions: state.savedSessions.map((session) => ({
      ...session,
      messages: session.messages.map((message) => ({ ...message })),
    })),
    usageTotals: { ...state.usageTotals },
  };
}

function initialState(): BenchHarnessState {
  return {
    allowAll: false,
    clipboard: '',
    exitRequested: false,
    gatewayEnabled: false,
    gatewayId: '',
    messages: [],
    model: BUILD_MODEL,
    planMode: false,
    savedSessions: [],
    usageTotals: {
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      input: 0,
      output: 0,
      totalTokens: 0,
    },
  };
}

function transcript(messages: BenchMessage[]): string {
  return messages
    .map((message) => `${message.role === 'user' ? '> ' : '~ '}${message.content}`)
    .join('\n\n');
}

function sessionName(messages: BenchMessage[]): string {
  const firstUser = messages.find((message) => message.role === 'user');
  return firstUser?.content.slice(0, 36) || 'untitled session';
}

function toolNames(cwd: string): string[] {
  const toolsPath = join(cwd, 'dist', 'server.mjs');
  try {
    const content = readFileSync(toolsPath, 'utf8');
    const names = new Set<string>();
    for (const match of content.matchAll(/name:\s*["']([^"']+)["']/g)) {
      const name = match[1];
      if (name !== undefined) {
        names.add(name);
      }
    }
    return [...names].toSorted();
  } catch {
    return [];
  }
}

function runSlashCommand(
  options: SlashCommandHarnessOptions,
  state: BenchHarnessState,
  commandLine: string,
): SlashCommandResult {
  const command = commandOnly(commandLine);
  const arg = commandLine.slice(command.length).trim();

  if (!SLASH_COMMANDS.some(([name]) => name === command)) {
    return {
      title: command,
      lines: [`unknown command: ${command}`],
    };
  }

  if (command === '/help') {
    return {
      title: command,
      lines: [
        'Commands:',
        ...SLASH_COMMANDS.map(([name]) => formatCommand(name)),
        '',
        'Keys:',
        ...HELP_KEYS.map(([key, desc]) => `${key.padEnd(14)}${desc}`),
      ],
    };
  }

  if (command === '/workspace') {
    return {
      title: command,
      lines: [`workspace: ${options.cwd}`],
    };
  }

  if (command === '/memory') {
    const agentsPath = join(options.cwd, 'AGENTS.md');
    return {
      title: command,
      lines: existsSync(agentsPath)
        ? ['AGENTS.md:', ...readFileSync(agentsPath, 'utf8').split('\n')]
        : ['no AGENTS.md found'],
    };
  }

  if (command === '/clear') {
    if (state.messages.length > 0) {
      state.savedSessions.push({
        id: `session-${state.savedSessions.length + 1}`,
        messages: state.messages.map((message) => ({ ...message })),
        name: sessionName(state.messages),
      });
    }
    state.messages = [];
    return {
      title: command,
      lines: ['new session started'],
    };
  }

  if (command === '/sessions') {
    if (state.savedSessions.length === 0) {
      return {
        title: command,
        lines: ['no saved sessions'],
      };
    }
    return {
      title: command,
      lines: [
        'saved sessions:',
        ...state.savedSessions.map(
          (session) => `${session.name}  ${session.messages.length} msgs`,
        ),
      ],
    };
  }

  if (command === '/compact') {
    const count = state.messages.length;
    if (count === 0) {
      return {
        title: command,
        lines: ['nothing to compact'],
      };
    }
    const kept = state.messages.slice(Math.ceil(count / 2));
    state.messages = kept;
    return {
      title: command,
      lines: [`compacted: kept last ${kept.length} of ${count} messages`],
    };
  }

  if (command === '/model' || command === '/models') {
    if (arg.length > 0) {
      if (getModelEntry(arg) === undefined) {
        return {
          title: command,
          lines: [`unknown model: ${arg}`, 'run /model to list known models'],
        };
      }
      state.model = arg;
      return {
        title: command,
        lines: [`model set: ${arg}`],
      };
    }
    return {
      title: command,
      lines: [
        `model: ${state.model}`,
        'available models:',
        ...listModels().map((model) => model.id),
      ],
    };
  }

  if (command === '/gateway') {
    if (arg.toLowerCase() === 'off') {
      state.gatewayEnabled = false;
      return {
        title: command,
        lines: ['AI Gateway disabled'],
      };
    }
    if (arg.length > 0) {
      state.gatewayEnabled = true;
      state.gatewayId = arg;
      return {
        title: command,
        lines: [`AI Gateway enabled: ${arg}`],
      };
    }
    return {
      title: command,
      lines: [
        `gateway: ${state.gatewayEnabled ? 'on' : 'off'}`,
        `id: ${state.gatewayId || '(none)'}`,
        'use /gateway <id> to enable',
      ],
    };
  }

  if (command === '/usage') {
    return {
      title: command,
      lines: [
        'neuron meter',
        `total: ${state.usageTotals.totalTokens} tokens · $${state.usageTotals.cost.toFixed(4)}`,
        `input: ${state.usageTotals.input} · output: ${state.usageTotals.output}`,
        `cache read: ${state.usageTotals.cacheRead} · cache write: ${state.usageTotals.cacheWrite}`,
      ],
    };
  }

  if (command === '/skills') {
    const skills = discoverSkills(options.cwd);
    return {
      title: command,
      lines:
        skills.length === 0
          ? ['no skills found']
          : ['skills:', ...skills.map((skill) => `#${skill}`)],
    };
  }

  if (command === '/mcp') {
    return {
      title: command,
      lines: ['no MCP config found'],
    };
  }

  if (command === '/tools') {
    const names = toolNames(options.cwd);
    return {
      title: command,
      lines:
        names.length === 0
          ? ['no tools found in harness']
          : ['registered tools:', ...names],
    };
  }

  if (command === '/subagents') {
    return {
      title: command,
      lines: ['no subagents'],
    };
  }

  if (command === '/sudo') {
    if (state.allowAll) {
      state.allowAll = false;
      return {
        title: command,
        lines: ['sudo disabled'],
      };
    }
    state.allowAll = true;
    return {
      title: command,
      lines: [
        'Sudo Mode',
        'allow every tool the agent has access to without prompts',
        'sudo enabled: all tools allowed',
      ],
    };
  }

  if (command === '/permissions') {
    return {
      title: command,
      lines: [
        'rules from .agents/rules.json merge after defaults',
        ...getDefaultRules().map((rule) => `${rule.action} ${rule.tool}`),
      ],
    };
  }

  if (command === '/plan') {
    state.planMode = !state.planMode;
    return {
      title: command,
      lines: [`plan mode: ${state.planMode ? 'on' : 'off'}`],
    };
  }

  if (command === '/copy') {
    state.clipboard = transcript(state.messages);
    return {
      title: command,
      lines: ['session copied to clipboard'],
    };
  }

  if (command === '/undo') {
    if (state.messages.length === 0) {
      return {
        title: command,
        lines: ['nothing to undo'],
      };
    }
    const removed = Math.min(2, state.messages.length);
    state.messages = state.messages.slice(0, -removed);
    return {
      title: command,
      lines: [`removed last ${removed} messages`],
    };
  }

  if (command === '/paste-image') {
    return {
      title: command,
      lines: ['No image found in clipboard'],
    };
  }

  if (command === '/quit') {
    state.exitRequested = true;
    return {
      title: command,
      lines: ['exit requested'],
    };
  }

  const description =
    SLASH_COMMANDS.find(([name]) => name === command)?.[1] ?? 'command';
  return {
    title: command,
    lines: [description],
  };
}

export function createSlashCommandHarness(
  options: SlashCommandHarnessOptions,
): SlashCommandHarness {
  const state = initialState();
  return {
    run(commandLine: string): Promise<SlashCommandResult> {
      return Promise.resolve(this.runSync(commandLine));
    },
    runSync(commandLine: string): SlashCommandResult {
      return runSlashCommand(options, state, commandLine);
    },
    seedMessages(messages: BenchMessage[]): void {
      state.messages = messages.map((message) => ({ ...message }));
    },
    state(): BenchHarnessState {
      return cloneState(state);
    },
  };
}

interface ParsedPrompt {
  verb: 'create' | 'edit' | 'delete';
  path: string;
  content?: string;
}

function parsePrompt(input: string): ParsedPrompt | null {
  const createOrEdit = /^(create|edit)\s+(\S+)(?:\s+(?:with|to)\s+(.+))?$/i.exec(
    input,
  );
  if (createOrEdit !== null) {
    const verb = createOrEdit[1]?.toLowerCase();
    const path = createOrEdit[2];
    if ((verb === 'create' || verb === 'edit') && path !== undefined) {
      return {
        content: `${createOrEdit[3] ?? ''}\n`,
        path,
        verb,
      };
    }
  }

  const deleteMatch = /^delete\s+(\S+)$/i.exec(input);
  if (deleteMatch?.[1] !== undefined) {
    return {
      path: deleteMatch[1],
      verb: 'delete',
    };
  }

  return null;
}

function resolveInsideWorkspace(workspace: string, filePath: string): string {
  const root = resolve(workspace);
  const target = resolve(root, filePath);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`prompt path is outside workspace: ${filePath}`);
  }
  return target;
}

function runPromptSync(workspace: string, input: string): string {
  const parsed = parsePrompt(input);
  if (parsed === null) {
    return `prompt: ${input}`;
  }

  const target = resolveInsideWorkspace(workspace, parsed.path);
  if (parsed.verb === 'delete') {
    rmSync(target, { force: true, recursive: true });
  } else {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, parsed.content ?? '');
  }

  return `${parsed.verb === 'edit' ? 'edited' : `${parsed.verb}d`} ${parsed.path}`;
}

export function BenchApp(props: { cwd: string }) {
  const [input, setInput] = useState('');
  const [inputVersion, setInputVersion] = useState(0);
  const [harness] = useState(() => createSlashCommandHarness({ cwd: props.cwd }));
  const [lines, setLines] = useState<string[]>([
    'type slash commands or simple file prompts',
  ]);
  const [panel, setPanel] = useState<string[]>([]);
  const [modelPicker, setModelPicker] = useState<ModelPickerState | null>(null);

  function modelPickerLines(picker: ModelPickerState): string[] {
    const current = harness.state().model;
    return [
      `model: ${current}`,
      'available models:',
      ...picker.models.map((model, index) => {
        const marker = index === picker.selectedIndex ? '> ' : '  ';
        const currentTag = model.id === current ? ' current' : '';
        return `${marker}${model.id}${currentTag}`;
      }),
    ];
  }

  function setModelPickerPanel(picker: ModelPickerState) {
    setPanel(['> /model', '[/model]', ...modelPickerLines(picker)]);
  }

  function handleBenchKeyDown(key: KeyEvent) {
    if (modelPicker === null) {
      return;
    }
    if (key.name === 'down') {
      const next = {
        models: modelPicker.models,
        selectedIndex: modelPicker.selectedIndex,
      };
      moveModelPickerSelection(next, 1);
      setModelPicker(next);
      setModelPickerPanel(next);
      key.stopPropagation();
      return;
    }
    if (key.name === 'up') {
      const next = {
        models: modelPicker.models,
        selectedIndex: modelPicker.selectedIndex,
      };
      moveModelPickerSelection(next, -1);
      setModelPicker(next);
      setModelPickerPanel(next);
      key.stopPropagation();
      return;
    }
    if (key.name === 'return') {
      const id = selectedModelId(modelPicker);
      if (id !== undefined) {
        const result = harness.runSync(`/model ${id}`);
        setPanel([`> /model ${id}`, `[${result.title}]`, ...result.lines]);
      }
      setModelPicker(null);
      key.stopPropagation();
      return;
    }
    if (key.name === 'escape') {
      setModelPicker(null);
      setPanel([]);
      key.stopPropagation();
    }
  }

  function submit(value: string) {
    const text = value.trim();
    if (text.length === 0) {
      return;
    }
    setInput('');
    setInputVersion((version) => version + 1);

    if (text.startsWith('/')) {
      const command = commandOnly(text);
      const arg = text.slice(command.length).trim();
      if ((command === '/model' || command === '/models') && arg.length === 0) {
        const picker = createModelPickerState(harness.state().model);
        setModelPicker(picker);
        setPanel([`> ${text}`, `[${command}]`, ...modelPickerLines(picker)]);
        return;
      }
      setModelPicker(null);
      const result = harness.runSync(text);
      setPanel([
        `> ${text}`,
        `[${result.title}]`,
        ...result.lines,
      ]);
      return;
    }

    const result = runPromptSync(props.cwd, text);
    setLines((current) => [...current, `> ${text}`, result]);
  }

  return (
    <box flexDirection="column" width="100%" height="100%">
      <text>
        {[
          'lavalamp testbench',
          ...lines.slice(-8),
          ...(panel.length > 0 ? ['', ...panel] : []),
        ].join('\n')}
      </text>
      <input
        key={`bench-input-${inputVersion}`}
        focused
        placeholder="bench>"
        value={input}
        onKeyDown={handleBenchKeyDown}
        onInput={setInput}
        onChange={setInput}
        onSubmit={submit}
      />
    </box>
  );
}
