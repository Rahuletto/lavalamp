import { matchRules, loadRules } from './rules';
import type { PermissionRule, PermissionAction } from './rules';
import {
  autorunPattern,
  getMatchingAutorun,
  isAllowAll,
  setAutorun,
} from './autorun';
import { withMutationLock } from '../sandbox/mutation-lock';

export interface PermissionRequest {
  type: 'permission_request';
  requestId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface PermissionResponse {
  type: 'permission_response';
  requestId: string;
  decision: PermissionAction;
  alwaysAllow?: boolean;
}

const pending = new Map<
  string,
  { resolve: (response: PermissionResponse) => void }
>();

let rules: { cwd: string; values: PermissionRule[] } | null = null;
let ipcListenerInstalled = false;
let permissionQueue: Promise<void> = Promise.resolve();

function ensureRules(cwd: string): PermissionRule[] {
  if (rules === null || rules.cwd !== cwd) {
    rules = { cwd, values: loadRules(cwd) };
  }
  return rules.values;
}

const pendingQuestions = new Map<
  string,
  { resolve: (answers: Record<string, any>) => void }
>();

function installIpcListener(): void {
  if (ipcListenerInstalled) {
    return;
  }
  ipcListenerInstalled = true;
  process.on('message', (raw: unknown) => {
    if (raw === null || raw === undefined || typeof raw !== 'object') {
      return;
    }
    const msg = raw as Record<string, unknown>;
    if (msg.type === 'permission_response') {
      const requestId = msg.requestId as string;
      const p = pending.get(requestId);
      if (p) {
        pending.delete(requestId);
        p.resolve(msg as unknown as PermissionResponse);
      }
      return;
    }
    if (msg.type === 'question_response') {
      const requestId = msg.requestId as string;
      const p = pendingQuestions.get(requestId);
      if (p) {
        pendingQuestions.delete(requestId);
        p.resolve(msg.answers as Record<string, any>);
      }
      return;
    }
  });
}

/**
 * Check what action a tool requires.
 * Returns 'allow' if autorun/sudo covers it, 'deny' if denied, 'ask' if it needs user approval.
 */
export function checkPermission(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
): PermissionAction {
  if (isAllowAll()) {
    return 'allow';
  }

  const autorunEntry = getMatchingAutorun(toolName, args);
  if (autorunEntry) {
    return autorunEntry.action;
  }

  return matchRules(toolName, args, ensureRules(cwd));
}

/**
 * Request permission from the TUI process via IPC.
 * Sends a permission_request message and waits for permission_response.
 * Auto-denies after 30 seconds.
 */
export async function requestPermission(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
): Promise<PermissionResponse> {
  const action = checkPermission(toolName, args, cwd);

  if (action === 'allow') {
    return { decision: 'allow', requestId: '', type: 'permission_response' };
  }
  if (action === 'deny') {
    return { decision: 'deny', requestId: '', type: 'permission_response' };
  }

  const previous = permissionQueue;
  let releaseQueue: () => void = () => {};
  permissionQueue = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  await previous;

  try {
    const queuedAction = checkPermission(toolName, args, cwd);
    if (queuedAction === 'allow' || queuedAction === 'deny') {
      return {
        decision: queuedAction,
        requestId: '',
        type: 'permission_response',
      };
    }
    return await requestPermissionViaIpc(toolName, args, cwd);
  } finally {
    releaseQueue();
  }
}

function requestPermissionViaIpc(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
): Promise<PermissionResponse> {
  installIpcListener();

  const requestId = `perm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const request: PermissionRequest = {
    args,
    requestId,
    toolName,
    type: 'permission_request',
  };

  return new Promise<PermissionResponse>((resolve) => {
    pending.set(requestId, { resolve });

    // Auto-deny after 30 seconds
    const timeout = setTimeout(() => {
      if (pending.has(requestId)) {
        pending.delete(requestId);
        resolve({ decision: 'deny', requestId, type: 'permission_response' });
      }
    }, 30_000);

    // Clean up timeout when resolved normally
    const origResolve = resolve;
    pending.set(requestId, {
      resolve: (resp) => {
        clearTimeout(timeout);
        if (resp.alwaysAllow) {
          setAutorun(cwd, toolName, 'allow', autorunPattern(args));
        }
        origResolve(resp);
      },
    });

    // Send IPC message to TUI parent process
    if (process.send) {
      process.send(request);
    } else {
      // No user is available to approve the operation. Fail closed.
      pending.delete(requestId);
      clearTimeout(timeout);
      resolve({ decision: 'deny', requestId, type: 'permission_response' });
    }
  });
}

/**
 * Wrap a tool's execute function with permission gating.
 * If the tool needs permission and is denied, returns an error object.
 */
export function wrapToolExecute(
  toolName: string,
  originalExecute: (args: Record<string, unknown>) => Promise<unknown>,
  cwd: string,
): (args: Record<string, unknown>) => Promise<unknown> {
  return async (args: Record<string, unknown>) => {
    const response = await requestPermission(toolName, args, cwd);

    if (response.decision === 'deny') {
      return { error: `Permission denied for ${toolName}` };
    }

    if (
      [
        'bash',
        'edit',
        'edit_file',
        'memory_append',
        'memory_write',
        'rename',
        'undo',
        'write',
        'write_file',
      ].includes(toolName)
    ) {
      return withMutationLock(() => originalExecute(args));
    }

    return originalExecute(args);
  };
}

/**
 * Reject all pending permission requests (e.g. on shutdown).
 */
export function rejectAllPending(): void {
  for (const [id, p] of pending) {
    p.resolve({ decision: 'deny', requestId: id, type: 'permission_response' });
  }
  pending.clear();
  for (const [, pendingQuestion] of pendingQuestions) {
    pendingQuestion.resolve({});
  }
  pendingQuestions.clear();
}

/**
 * Request answers for one or more questions from the TUI process via IPC.
 * If the process is not connected to IPC, returns default values.
 */
export async function askUserQuestions(
  questions: any[],
): Promise<Record<string, any>> {
  installIpcListener();

  const requestId = `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const request = {
    questions,
    requestId,
    type: 'question_request',
  };

  return new Promise<Record<string, any>>((resolve) => {
    pendingQuestions.set(requestId, { resolve });

    // Send IPC message to TUI parent process
    if (process.send) {
      process.send(request);
    } else {
      // No IPC channel (running standalone / headless) — return default options
      pendingQuestions.delete(requestId);
      const defaults: Record<string, any> = {};
      for (const q of questions) {
        defaults[q.id] = q.default ?? (q.type === 'multiselect' ? [] : '');
      }
      resolve(defaults);
    }
  });
}
