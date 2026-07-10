import { FlueProcess } from '../tui/ipc';
import { preflightHeadlessAuth, type PreflightContext } from './auth-preflight';
import { resolveRuntimeRoute } from '../config/runtime-route';
import { BUILD_MODEL } from '../config/models';
import { withTerminalProgress } from './terminal-progress';

export interface PrintOptions {
  prompt: string;
  stdinContent: string;
  quiet: boolean;
  outputFormat: 'text' | 'json';
  workspaceRoot: string;
  serverPath: string;
  config: any;
  env: Record<string, string | undefined>;
  model?: string;
  agentName?: string;
}

export async function runPrint(opts: PrintOptions): Promise<void> {
  const fullPrompt =
    opts.stdinContent.length > 0 && opts.prompt !== opts.stdinContent
      ? `${opts.stdinContent}\n\n---\n\n${opts.prompt}`
      : opts.prompt;

  if (!opts.quiet) {
    console.error(`[lavalamp] Running: ${opts.prompt}`);
    console.error(`[lavalamp] Workspace: ${opts.workspaceRoot}`);
  }

  const preflightCtx: PreflightContext = {
    config: opts.config,
    env: opts.env,
    model: opts.model,
    outputFormat: opts.outputFormat,
  };

  if (!(await preflightHeadlessAuth(preflightCtx))) {
    process.exit(1);
  }

  const flue = new FlueProcess(opts.serverPath, opts.workspaceRoot, opts.agentName ?? 'build');
  let pBashRunning = false;

  flue.onBashStream = (chunk: string, stream: 'stdout' | 'stderr') => {
    if (opts.quiet || opts.outputFormat === 'json') {
      return;
    }
    if (!pBashRunning) {
      pBashRunning = true;
      process.stderr.write('  ┌─ bash\n');
    }
    if (stream === 'stderr') {
      process.stderr.write(chunk);
    } else {
      process.stdout.write(chunk);
    }
  };

  try {
    await flue.start();
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    if (opts.outputFormat === 'json') {
      process.stdout.write(`${JSON.stringify({ error: msg })}\n`);
    } else {
      console.error(`[lavalamp] Error: ${msg}`);
    }
    process.exit(1);
  }

  let exitCode = 0;
  if (opts.outputFormat === 'json') {
    let fullText = '';
    let usage: Record<string, unknown> = {};
    let modelInfo: Record<string, unknown> = {};
    const route = resolveRuntimeRoute({
      config: opts.config,
      env: opts.env,
      model: opts.model,
      preferredModel: BUILD_MODEL,
    });

    exitCode = await new Promise<number>((resolveExit) => {
      const callbacks = withTerminalProgress({
        onError: (err) => {
          process.stdout.write(`${JSON.stringify({ error: err.message })}\n`);
          resolveExit(1);
        },
        onEvent: (event) => {
          if (event.type === 'text_delta') {
            fullText += event.text ?? event.delta ?? '';
          }
        },
        onResult: (result) => {
          if (!fullText && typeof result.text === 'string') {
            fullText = result.text;
          }
          if (result !== undefined && result.usage !== undefined) {
            usage = result.usage as Record<string, unknown>;
          }
          if (result !== undefined && result.model !== undefined) {
            modelInfo = result.model as Record<string, unknown>;
          }
          const provider =
            typeof modelInfo.provider === 'string'
              ? modelInfo.provider
              : route.provider;
          process.stdout.write(
            `${JSON.stringify({
              cost: (usage as { cost?: unknown }).cost ?? {},
              model: modelInfo,
              route: {
                gatewayId: route.usesGateway ? route.gatewayId : undefined,
                mode: route.mode,
                provider,
              },
              text: fullText,
              usage,
            })}\n`,
          );
          resolveExit(0);
        },
      });
      try {
        flue.prompt(fullPrompt, callbacks);
      } catch (error: unknown) {
        callbacks.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    });
  } else {
    let streamedText = '';
    exitCode = await new Promise<number>((resolveExit) => {
      const callbacks = withTerminalProgress({
        onError: (err) => {
          console.error(`\n  error: ${err.message}`);
          resolveExit(1);
        },
        onEvent: (event) => {
          if (event.type === 'text_delta') {
            const delta = event.text ?? event.delta ?? '';
            streamedText += delta;
            process.stdout.write(delta);
          } else if (event.type === 'tool_start') {
            if (event.toolName === 'bash' && !opts.quiet) {
              pBashRunning = false;
            }
          } else if (event.type === 'tool') {
            if (pBashRunning) {
              pBashRunning = false;
              if (!opts.quiet) {
                process.stderr.write('  └─\n');
              }
            }
          }
        },
        onResult: (result) => {
          if (!streamedText && typeof result.text === 'string') {
            process.stdout.write(result.text);
          }
          if (!opts.quiet && result !== undefined && result.usage !== undefined) {
            const u = result.usage;
            const modelStr =
              result.model !== undefined
                ? `${result.model.provider}/${result.model.id}`
                : '';
            console.error(
              `\n  ${u.totalTokens} tok | $${u.cost.total.toFixed(4)} | ${modelStr}`,
            );
          }
          resolveExit(0);
        },
      });
      try {
        flue.prompt(fullPrompt, callbacks);
      } catch (error: unknown) {
        callbacks.onError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    });
  }
  await flue.shutdown();
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
