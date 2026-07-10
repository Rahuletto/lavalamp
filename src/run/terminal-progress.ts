const INDETERMINATE = '\x1b]9;4;3\x07';
const CLEAR = '\x1b]9;4;0\x07';

interface TerminalProgressOptions {
  clearInterval?: (timer: unknown) => void;
  env: Record<string, string | undefined>;
  isTTY: boolean;
  setInterval?: (callback: () => void, intervalMs: number) => unknown;
  write: (chunk: string) => void;
}

export interface TerminalProgress {
  begin(): () => void;
}

function enabled(options: TerminalProgressOptions): boolean {
  const override = options.env.LAVALAMP_TERMINAL_PROGRESS;
  if (override === '0') {
    return false;
  }
  if (override === '1') {
    return true;
  }
  return options.isTTY && options.env.TERM !== 'dumb';
}

export function createTerminalProgress(
  options: TerminalProgressOptions,
): TerminalProgress {
  let active = 0;
  let refreshTimer: unknown;
  const schedule =
    options.setInterval ??
    ((callback: () => void, intervalMs: number) =>
      setInterval(callback, intervalMs));
  const cancel =
    options.clearInterval ??
    ((timer: unknown) =>
      clearInterval(timer as ReturnType<typeof setInterval>));

  return {
    begin() {
      if (!enabled(options)) {
        return () => {};
      }

      active += 1;
      if (active === 1) {
        options.write(INDETERMINATE);
        refreshTimer = schedule(() => options.write(INDETERMINATE), 1_000);
      }

      let stopped = false;
      return () => {
        if (stopped) {
          return;
        }
        stopped = true;
        active -= 1;
        if (active === 0) {
          cancel(refreshTimer);
          refreshTimer = undefined;
          options.write(CLEAR);
        }
      };
    },
  };
}

const processProgress = createTerminalProgress({
  env: process.env,
  isTTY: process.stderr.isTTY ?? false,
  write: (chunk) => process.stderr.write(chunk),
});

export function beginTerminalProgress(): () => void {
  return processProgress.begin();
}

export function withTerminalProgress(
  callbacks: PromptCallbacks,
  beginProgress: () => () => void = beginTerminalProgress,
): PromptCallbacks {
  const stopProgress = beginProgress();
  return {
    ...callbacks,
    onError: (error) => {
      stopProgress();
      callbacks.onError?.(error);
    },
    onResult: (result) => {
      stopProgress();
      callbacks.onResult?.(result);
    },
  };
}
import type { PromptCallbacks } from '../tui/ipc';
