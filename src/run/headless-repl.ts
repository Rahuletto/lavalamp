import * as readline from 'node:readline';
import {
  FlueProcess,
  type FlueEvent,
  type FlueResult,
  type PermissionRequestMsg,
  type QuestionRequestMsg,
} from '../tui/ipc';
import {
  preflightHeadlessAuth,
  preflightSimpleAuth,
  type PreflightContext,
} from './auth-preflight';
import { createSimpleEventStream } from './simple-event-stream';
import { withTerminalProgress } from './terminal-progress';

export interface ReplOptions {
  quiet: boolean;
  outputFormat: 'text' | 'json';
  simpleMode?: boolean;
  workspaceRoot: string;
  serverPath: string;
  config: any;
  env: Record<string, string | undefined>;
  model?: string;
  agentName?: string;
}

function defaultQuestionAnswers(
  questions: QuestionRequestMsg['questions'],
): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const q of questions) {
    answers[q.id] =
      q.default ?? (q.type === 'multiselect' ? [] : '');
  }
  return answers;
}

export async function runRepl(opts: ReplOptions): Promise<void> {
  const isTTY = process.stdin.isTTY ?? false;
  const autoApprove =
    process.argv.includes('--yes') ||
    process.argv.includes('--auto-approve');
  const simple = opts.simpleMode === true;

  if (!opts.quiet && !simple) {
    console.error(`[lavalamp] REPL — workspace: ${opts.workspaceRoot}`);
    if (autoApprove) {
      console.error('[lavalamp] --yes: all tool calls auto-approved');
    } else if (!isTTY) {
      console.error(
        '[lavalamp] piped stdin: destructive tools auto-denied (use --yes to allow)',
      );
    }
    if (isTTY) {
      console.error(
        '[lavalamp] /exit or Ctrl+D to quit · /clear to reset · Ctrl+C to cancel turn',
      );
    }
    console.error('');
  }

  const preflightCtx: PreflightContext = {
    config: opts.config,
    env: opts.env,
    model: opts.model,
    outputFormat: opts.outputFormat,
  };

  if (simple && isTTY) {
    await preflightSimpleAuth(preflightCtx, opts.quiet);
  } else if (!(await preflightHeadlessAuth(preflightCtx))) {
    process.exit(1);
  }

  const flue = new FlueProcess(
    opts.serverPath,
    opts.workspaceRoot,
    opts.agentName ?? 'build',
  );
  let flueStarted = false;
  let startupError: Error | null = null;
  let startupPromise: Promise<void> | null = null;
  let needsRestart = false;
  let processing = false;
  let bashRunning = false;

  async function ensureFlueStarted(): Promise<void> {
    if (flueStarted) {
      return;
    }
    if (startupError !== null) {
      throw startupError;
    }
    if (startupPromise === null) {
      startupPromise = flue
        .start()
        .then(() => {
          flueStarted = true;
        })
        .catch((error: unknown) => {
          const err =
            error instanceof Error ? error : new Error(String(error));
          startupError = err;
          throw err;
        });
    }
    await startupPromise;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: simple ? '> ' : 'lavalamp> ',
    terminal: isTTY,
  });

  flue.onBashStream = (chunk: string, stream: 'stdout' | 'stderr') => {
    if (opts.quiet || opts.outputFormat === 'json' || simple) {
      return;
    }
    if (!bashRunning) {
      bashRunning = true;
      process.stderr.write('  ┌─ bash\n');
    }
    if (stream === 'stderr') {
      process.stderr.write(chunk);
    } else {
      process.stdout.write(chunk);
    }
  };

  flue.onPermissionRequest = (req: PermissionRequestMsg) => {
    if (autoApprove) {
      flue.sendPermissionResponse(req.requestId, 'allow');
      return;
    }
    if (!isTTY) {
      flue.sendPermissionResponse(req.requestId, 'deny');
      if (!opts.quiet && !simple) {
        process.stderr.write(
          `  [denied: ${req.toolName} — use --yes to allow]\n`,
        );
      }
      return;
    }
    const prompt = simple
      ? `[allow ${req.toolName}? y/N] `
      : `  [permission] ${req.toolName} — allow? [y/N] `;
    rl.question(prompt, (answer) => {
      const allow = answer.trim().toLowerCase().startsWith('y');
      flue.sendPermissionResponse(req.requestId, allow ? 'allow' : 'deny');
    });
  };

  flue.onQuestionRequest = (request: QuestionRequestMsg) => {
    flue.sendQuestionResponse(
      request.requestId,
      defaultQuestionAnswers(request.questions),
    );
  };

  async function shutdown(): Promise<void> {
    if (flueStarted) {
      try {
        await flue.shutdown();
      } catch {}
    }
    rl.close();
    process.exit(0);
  }

  function sendTurn(text: string): Promise<void> {
    return new Promise((resolve) => {
      processing = true;
      let streamed = '';
      const simpleEvents = createSimpleEventStream((chunk) => {
        process.stdout.write(chunk);
      });

      const handleError = (err: Error) => {
        if (simple && opts.outputFormat !== 'json') {
          simpleEvents.finish();
        }
        if (opts.outputFormat === 'json') {
          process.stdout.write(`${JSON.stringify({ error: err.message })}\n`);
        } else if (simple) {
          process.stderr.write(`error: ${err.message}\n`);
        } else {
          process.stderr.write(`\n  error: ${err.message}\n`);
        }
        processing = false;
        resolve();
      };

      const handleResult = (result: FlueResult) => {
        if (simple && opts.outputFormat !== 'json') {
          simpleEvents.finish();
        }
        if (opts.outputFormat === 'json') {
          process.stdout.write(
            `${JSON.stringify({
              model: result.model,
              text: streamed || result.text,
              usage: result.usage,
            })}\n`,
          );
        } else {
          if (!streamed && typeof result.text === 'string') {
            process.stdout.write(result.text);
            streamed = result.text;
          }
          if (streamed && !streamed.endsWith('\n')) {
            process.stdout.write('\n');
          }
          if (!opts.quiet && !simple && result.usage !== undefined) {
            const u = result.usage;
            const modelStr =
              result.model !== undefined
                ? `${result.model.provider}/${result.model.id}`
                : '';
            process.stderr.write(
              `  ${u.totalTokens} tok | $${u.cost.total.toFixed(4)} | ${modelStr}\n`,
            );
          }
        }
        processing = false;
        resolve();
      };

      const handleEvent = (event: FlueEvent) => {
        if (simple && opts.outputFormat !== 'json') {
          if (event.type === 'text_delta') {
            streamed += event.text ?? event.delta ?? '';
          }
          simpleEvents.handle(event);
          return;
        }

        if (event.type === 'text_delta') {
          const delta = event.text ?? event.delta ?? '';
          streamed += delta;
          if (opts.outputFormat !== 'json') {
            process.stdout.write(delta);
          }
        } else if (event.type === 'tool_start') {
          if (
            event.toolName === 'bash' &&
            !opts.quiet &&
            opts.outputFormat !== 'json' &&
            !simple
          ) {
            bashRunning = false;
          }
        } else if (event.type === 'tool') {
          if (bashRunning) {
            bashRunning = false;
            if (!opts.quiet && opts.outputFormat !== 'json' && !simple) {
              process.stderr.write('  └─\n');
            }
          }
        }
      };

      const callbacks = withTerminalProgress({
          onError: handleError,
          onEvent: handleEvent,
          onResult: handleResult,
        });
      try {
        flue.prompt(text, callbacks);
      } catch (err: unknown) {
        callbacks.onError?.(
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    });
  }

  let chain = Promise.resolve();

  async function handleLine(line: string): Promise<void> {
    const input = line.trim();

    if (!input) {
      if (isTTY) {
        rl.prompt();
      }
      return;
    }

    if (input === '/exit' || input === '/quit') {
      await shutdown();
      return;
    }

    if (input === '/help') {
      if (simple) {
        process.stderr.write('/exit · /quit · Ctrl+D to quit\n');
        process.stderr.write('/clear · reset conversation\n');
        process.stderr.write('/help · this message\n');
      } else {
        process.stderr.write('  /exit · /quit — leave REPL\n');
        process.stderr.write('  /clear — reset conversation context\n');
        process.stderr.write('  /help — this message\n');
        process.stderr.write('  Ctrl+C — cancel current turn (or exit when idle)\n');
        process.stderr.write('  Ctrl+D — exit\n');
      }
      if (isTTY) {
        rl.prompt();
      }
      return;
    }

    if (input === '/clear') {
      try {
        await ensureFlueStarted();
        await flue.restart();
        flueStarted = true;
        startupPromise = null;
        startupError = null;
        if (!opts.quiet && !simple) {
          process.stderr.write('  [context cleared]\n');
        }
      } catch (err: unknown) {
        if (!opts.quiet && !simple) {
          process.stderr.write(
            `  [clear failed: ${err instanceof Error ? err.message : String(err)}]\n`,
          );
        }
      }
      if (isTTY) {
        rl.prompt();
      }
      return;
    }

    rl.pause();
    try {
      await ensureFlueStarted();
      await sendTurn(input);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      if (opts.outputFormat === 'json') {
        process.stdout.write(`${JSON.stringify({ error: msg })}\n`);
      } else {
        process.stderr.write(`error: ${msg}\n`);
      }
    }
    if (needsRestart && flueStarted) {
      needsRestart = false;
      try {
        await flue.restart();
      } catch (err: unknown) {
        if (!opts.quiet && !simple) {
          process.stderr.write(
            `  [restart failed: ${err instanceof Error ? err.message : String(err)}]\n`,
          );
        }
      }
    }
    if (isTTY) {
      rl.resume();
      rl.prompt();
    }
  }

  rl.on('line', (line: string) => {
    chain = chain.then(() => handleLine(line));
  });

  rl.on('close', () => {
    chain
      .then(async () => {
        if (flueStarted) {
          try {
            await flue.shutdown();
          } catch {}
        }
      })
      .finally(() => {
        process.exit(0);
      })
      .catch(() => {
        process.exit(0);
      });
  });

  process.on('SIGINT', () => {
    if (processing) {
      needsRestart = true;
      flue.cancel();
      flueStarted = false;
      startupPromise = null;
      if (!simple) {
        process.stderr.write('\n  [cancelled]\n');
      } else {
        process.stderr.write('\n');
      }
    } else {
      chain = chain.then(() => shutdown());
    }
  });

  if (isTTY) {
    rl.prompt();
  }
}
