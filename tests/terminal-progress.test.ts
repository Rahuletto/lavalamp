import { describe, expect, test } from 'bun:test';
import {
  createTerminalProgress,
  withTerminalProgress,
} from '../src/run/terminal-progress';

const START = '\x1b]9;4;3\x07';
const CLEAR = '\x1b]9;4;0\x07';

describe('terminal progress', () => {
  test('shows indeterminate progress and clears it', () => {
    let output = '';
    const progress = createTerminalProgress({
      env: {},
      isTTY: true,
      write: (chunk) => {
        output += chunk;
      },
    });

    const stop = progress.begin();
    expect(output).toBe(START);
    stop();
    expect(output).toBe(START + CLEAR);
  });

  test('keeps progress active until nested work finishes', () => {
    let output = '';
    const progress = createTerminalProgress({
      env: {},
      isTTY: true,
      write: (chunk) => {
        output += chunk;
      },
    });

    const stopOuter = progress.begin();
    const stopInner = progress.begin();
    stopOuter();
    expect(output).toBe(START);
    stopInner();
    expect(output).toBe(START + CLEAR);
  });

  test('refreshes indeterminate progress until work finishes', () => {
    let output = '';
    let keepAlive: (() => void) | undefined;
    let cleared = false;
    const progress = createTerminalProgress({
      clearInterval: () => {
        cleared = true;
      },
      env: {},
      isTTY: true,
      setInterval: (callback) => {
        keepAlive = callback;
        return 1;
      },
      write: (chunk) => {
        output += chunk;
      },
    });

    const stop = progress.begin();
    keepAlive?.();
    keepAlive?.();
    expect(output).toBe(START.repeat(3));

    stop();
    expect(cleared).toBe(true);
    expect(output).toBe(START.repeat(3) + CLEAR);
  });

  test('completion callback is idempotent', () => {
    let output = '';
    const progress = createTerminalProgress({
      env: {},
      isTTY: true,
      write: (chunk) => {
        output += chunk;
      },
    });

    const stop = progress.begin();
    stop();
    stop();
    expect(output).toBe(START + CLEAR);
  });

  test('does not emit outside a terminal', () => {
    let output = '';
    const progress = createTerminalProgress({
      env: {},
      isTTY: false,
      write: (chunk) => {
        output += chunk;
      },
    });

    progress.begin()();
    expect(output).toBe('');
  });

  test('supports disable and force environment overrides', () => {
    let disabledOutput = '';
    const disabled = createTerminalProgress({
      env: { LAVALAMP_TERMINAL_PROGRESS: '0' },
      isTTY: true,
      write: (chunk) => {
        disabledOutput += chunk;
      },
    });
    disabled.begin()();

    let forcedOutput = '';
    const forced = createTerminalProgress({
      env: { LAVALAMP_TERMINAL_PROGRESS: '1', TERM: 'dumb' },
      isTTY: false,
      write: (chunk) => {
        forcedOutput += chunk;
      },
    });
    forced.begin()();

    expect(disabledOutput).toBe('');
    expect(forcedOutput).toBe(START + CLEAR);
  });

  test('headless callback wrapper holds progress for the prompt lifecycle', () => {
    const lifecycle: string[] = [];
    const callbacks = withTerminalProgress(
      { onResult: () => lifecycle.push('result') },
      () => {
        lifecycle.push('start');
        return () => lifecycle.push('stop');
      },
    );
    expect(lifecycle).toEqual(['start']);
    callbacks.onResult?.({});
    expect(lifecycle).toEqual(['start', 'stop', 'result']);
  });

  test('headless callback wrapper clears progress on errors', () => {
    const lifecycle: string[] = [];
    const callbacks = withTerminalProgress(
      { onError: () => lifecycle.push('error') },
      () => {
        lifecycle.push('start');
        return () => lifecycle.push('stop');
      },
    );

    callbacks.onError?.(new Error('failed'));
    expect(lifecycle).toEqual(['start', 'stop', 'error']);
  });
});
