import { matchRules, loadRules } from './rules';
import type { PermissionRule, PermissionAction } from './rules';
import { getMatchingAutorun, isAllowAll, setAutorun } from './autorun';

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

let rules: PermissionRule[] | null = null;
let ipcListenerInstalled = false;

function ensureRules(cwd: string): PermissionRule[] {
  rules ??= loadRules(cwd);
  return rules;
}

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
    if (msg.type !== 'permission_response') {
      return;
    }
    const requestId = msg.requestId as string;
    const p = pending.get(requestId);
    if (p) {
      pending.delete(requestId);
      p.resolve(msg as unknown as PermissionResponse);
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

  // action === 'ask' — send IPC request to TUI
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
          setAutorun(cwd, toolName, 'allow');
        }
        origResolve(resp);
      },
    });

    // Send IPC message to TUI parent process
    if (process.send) {
      process.send(request);
    } else {
      // No IPC channel (running standalone) — auto-allow
      pending.delete(requestId);
      clearTimeout(timeout);
      resolve({ decision: 'allow', requestId, type: 'permission_response' });
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
}
