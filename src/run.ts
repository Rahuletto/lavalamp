import { join, resolve } from 'node:path';
import * as readline from 'node:readline';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import {
  FlueProcess,
  type FlueEvent,
  type FlueResult,
  type PermissionRequestMsg,
} from './tui/ipc';
import { startTui } from './tui/app';
import { resolveConfig } from './config/user-config';
import { BUILD_MODEL } from './config/models';
import { resolveRuntimeRoute } from './config/runtime-route';
import { login, validateCredentials } from './auth/login';
import { loadCredentials } from './auth/credentials';
import { lavalampDataDir } from './storage/paths';

// @ts-ignore
import serverCode from '../dist/server.mjs' with { type: 'text' };

const workspaceRoot = process.env.LAVALAMP_WORKSPACE ?? process.cwd();
const config = resolveConfig();
const env = process.env as Record<string, string | undefined>;
const model =
  env.LAVALAMP_MODEL ??
  (config.defaultModel.length > 0 ? config.defaultModel : undefined);

const subcommand = process.argv[2];
if (subcommand === 'login' || subcommand === 'logout' || subcommand === 'status') {
  await import('./cli/auth');
  process.exit(0);
}
if (subcommand === 'config' || subcommand === 'models') {
  await import('./cli/config');
  process.exit(0);
}

const repoRoot = resolve(import.meta.dir, '..');
let serverPath = join(repoRoot, 'dist', 'server.mjs');

if (!existsSync(serverPath)) {
  const dataDir = lavalampDataDir();
  mkdirSync(dataDir, { recursive: true });
  serverPath = join(dataDir, 'server.mjs');
  writeFileSync(serverPath, serverCode, 'utf8');
}

function findFlag(flags: string[]): number {
  for (const f of flags) {
    const idx = process.argv.indexOf(f);
    if (idx !== -1) {
      return idx;
    }
  }
  return -1;
}

function findFlagValue(flags: string[]): string | null {
  const idx = findFlag(flags);
  if (idx === -1) {
    return null;
  }
  return process.argv[idx + 1] ?? null;
}

const versionIdx = findFlag(['-v', '--version']);
const helpIdx = findFlag(['-h', '--help']);

if (versionIdx !== -1) {
  console.log('lavalamp 0.1.0');
  process.exit(0);
}

if (helpIdx !== -1) {
  console.log(`lavalamp — AI coding harness

USAGE:
  lavalamp                       Start interactive session in current directory
  lavalamp -p "PROMPT"           Run a single prompt and exit
  lavalamp --repl                TUI-less interactive REPL (multi-turn, stdin pipe)
  lavalamp --continue            Resume a previous session
  lavalamp --workspace /path     Set workspace directory (default: cwd)
  lavalamp --model MODEL         Override default model
  lavalamp models                List known models
  lavalamp config show           Show persisted config
  lavalamp config set KEY VALUE  Persist model/Gateway config
`);
  process.exit(0);
}

const printIdx = findFlag(['-p', '--print', '--inline']);
const replIdx = findFlag(['--repl']);
const continueIdx = process.argv.indexOf('--continue');
const resumeSession = continueIdx !== -1;
const continueArg =
  continueIdx !== -1 ? process.argv[continueIdx + 1] : undefined;
const resumeSessionId =
  resumeSession && continueArg !== undefined && !continueArg.startsWith('-')
    ? continueArg
    : undefined;
const outputFormat = findFlagValue(['--output-format', '--format']) ?? 'text';
const quiet = process.argv.includes('--quiet');

if (outputFormat !== 'text' && outputFormat !== 'json') {
  console.error('[lavalamp] Error: --output-format must be text or json');
  process.exit(1);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return '';
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function currentRoute() {
  return resolveRuntimeRoute({
    config,
    env,
    model,
    preferredModel: BUILD_MODEL,
  });
}

async function hasValidCloudflareCredentials(): Promise<boolean> {
  const creds = loadCredentials();
  return creds !== null && (await validateCredentials(creds));
}

function emitHeadlessError(message: string): void {
  if (outputFormat === 'json') {
    process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  } else {
    console.error(`[lavalamp] Error: ${message}`);
  }
}

async function preflightInteractiveAuth(): Promise<void> {
  const route = currentRoute();
  if (!route.requiresCloudflareAuth) {
    return;
  }

  console.error('[lavalamp] Authenticating...');
  if (await hasValidCloudflareCredentials()) {
    console.error('[lavalamp] Authentication complete. Opening TUI...');
    return;
  }

  try {
    await login();
    console.error('[lavalamp] Authentication complete. Opening TUI...');
  } catch (error: unknown) {
    console.error(
      `[lavalamp] Authentication failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

async function preflightHeadlessAuth(): Promise<boolean> {
  const route = currentRoute();
  if (!route.requiresCloudflareAuth) {
    return true;
  }
  if (await hasValidCloudflareCredentials()) {
    return true;
  }
  emitHeadlessError(
    'Cloudflare authentication required. Run `lavalamp login` before using headless mode.',
  );
  return false;
}

async function runRepl(): Promise<void> {
  const isTTY = process.stdin.isTTY ?? false;
  const autoApprove =
    process.argv.includes('--yes') ||
    process.argv.includes('--auto-approve');

  if (!quiet) {
    console.error(`[lavalamp] REPL — workspace: ${workspaceRoot}`);
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

  if (!(await preflightHeadlessAuth())) {
    process.exit(1);
  }

  const flue = new FlueProcess(serverPath, workspaceRoot, 'build');
  let needsRestart = false;
  let processing = false;
  let bashRunning = false;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'lavalamp> ',
    terminal: isTTY,
  });

  flue.onBashStream = (chunk: string, stream: 'stdout' | 'stderr') => {
    if (quiet || outputFormat === 'json') {
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
      if (!quiet) {
        process.stderr.write(
          `  [denied: ${req.toolName} — use --yes to allow]\n`,
        );
      }
      return;
    }
    rl.question(`  [permission] ${req.toolName} — allow? [y/N] `, (answer) => {
      const allow = answer.trim().toLowerCase().startsWith('y');
      flue.sendPermissionResponse(req.requestId, allow ? 'allow' : 'deny');
    });
  };

  try {
    await flue.start();
  } catch (error: unknown) {
    emitHeadlessError(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  async function shutdown(): Promise<void> {
    try {
      await flue.shutdown();
    } catch {}
    rl.close();
    process.exit(0);
  }

  function sendTurn(text: string): Promise<void> {
    return new Promise((resolve) => {
      processing = true;
      let streamed = '';

      const handleError = (err: Error) => {
        if (outputFormat === 'json') {
          process.stdout.write(`${JSON.stringify({ error: err.message })}\n`);
        } else {
          process.stderr.write(`\n  error: ${err.message}\n`);
        }
        processing = false;
        resolve();
      };

      const handleResult = (result: FlueResult) => {
        if (outputFormat === 'json') {
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
          if (!quiet && result.usage !== undefined) {
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
        if (event.type === 'text_delta') {
          const delta = event.text ?? event.delta ?? '';
          streamed += delta;
          if (outputFormat !== 'json') {
            process.stdout.write(delta);
          }
        } else if (event.type === 'tool_start') {
          if (event.toolName === 'bash' && !quiet && outputFormat !== 'json') {
            bashRunning = false; // will be set true by first stream chunk
          }
        } else if (event.type === 'tool') {
          if (bashRunning) {
            bashRunning = false;
            if (!quiet && outputFormat !== 'json') {
              process.stderr.write('  └─\n');
            }
          }
        }
      };

      try {
        flue.prompt(text, {
          onError: handleError,
          onEvent: handleEvent,
          onResult: handleResult,
        });
      } catch (err: unknown) {
        handleError(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  let chain = Promise.resolve();

  async function handleLine(line: string): Promise<void> {
    const input = line.trim();

    if (!input) {
      if (isTTY) rl.prompt();
      return;
    }

    if (input === '/exit' || input === '/quit') {
      await shutdown();
      return;
    }

    if (input === '/clear') {
      try {
        await flue.restart();
        if (!quiet) process.stderr.write('  [context cleared]\n');
      } catch (err: unknown) {
        if (!quiet) {
          process.stderr.write(
            `  [clear failed: ${err instanceof Error ? err.message : String(err)}]\n`,
          );
        }
      }
      if (isTTY) rl.prompt();
      return;
    }

    if (input === '/help') {
      process.stderr.write('  /exit · /quit — leave REPL\n');
      process.stderr.write('  /clear — reset conversation context\n');
      process.stderr.write('  /help — this message\n');
      process.stderr.write('  Ctrl+C — cancel current turn (or exit when idle)\n');
      process.stderr.write('  Ctrl+D — exit\n');
      if (isTTY) rl.prompt();
      return;
    }

    rl.pause();
    if (isTTY && !quiet) process.stderr.write('');
    await sendTurn(input);
    if (needsRestart) {
      needsRestart = false;
      try {
        await flue.restart();
      } catch (err: unknown) {
        if (!quiet) {
          process.stderr.write(
            `  [restart failed: ${err instanceof Error ? err.message : String(err)}]\n`,
          );
        }
      }
    }
    if (isTTY) {
      process.stderr.write('');
      rl.resume();
      rl.prompt();
    }
  }

  rl.on('line', (line: string) => {
    chain = chain.then(() => handleLine(line));
  });

  rl.on('close', async () => {
    try {
      await flue.shutdown();
    } catch {}
    process.exit(0);
  });

  process.on('SIGINT', () => {
    if (processing) {
      needsRestart = true;
      flue.cancel();
      process.stderr.write('\n  [cancelled]\n');
    } else {
      chain = chain.then(() => shutdown());
    }
  });

  if (isTTY) {
    rl.prompt();
  }
}

if (printIdx !== -1) {
  let prompt = process.argv[printIdx + 1] ?? '';
  const stdinContent = await readStdin();

  if (!prompt && stdinContent.length > 0) {
    prompt = stdinContent;
  } else if (!prompt && stdinContent.length === 0) {
    console.error('[lavalamp] Error: -p requires a prompt argument');
    process.exit(1);
  }

  const fullPrompt =
    stdinContent.length > 0 && prompt !== stdinContent
      ? `${stdinContent}\n\n---\n\n${prompt}`
      : prompt;

  if (!quiet) {
    console.error(`[lavalamp] Running: ${prompt}`);
    console.error(`[lavalamp] Workspace: ${workspaceRoot}`);
  }

  if (!(await preflightHeadlessAuth())) {
    process.exit(1);
  }

  const flue = new FlueProcess(serverPath, workspaceRoot, 'build');
  let pBashRunning = false;

  flue.onBashStream = (chunk: string, stream: 'stdout' | 'stderr') => {
    if (quiet || outputFormat === 'json') {
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
    emitHeadlessError(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  let exitCode = 0;
  if (outputFormat === 'json') {
    let fullText = '';
    let usage: Record<string, unknown> = {};
    let modelInfo: Record<string, unknown> = {};
    const route = currentRoute();

    exitCode = await new Promise<number>((resolveExit) => {
      flue.prompt(fullPrompt, {
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
    });
  } else {
    let streamedText = '';
    exitCode = await new Promise<number>((resolveExit) => {
      flue.prompt(fullPrompt, {
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
            if (event.toolName === 'bash' && !quiet) {
              pBashRunning = false;
            }
          } else if (event.type === 'tool') {
            if (pBashRunning) {
              pBashRunning = false;
              if (!quiet) {
                process.stderr.write('  └─\n');
              }
            }
          }
        },
        onResult: (result) => {
          if (!streamedText && typeof result.text === 'string') {
            process.stdout.write(result.text);
          }
          if (!quiet && result !== undefined && result.usage !== undefined) {
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
    });
  }
  await flue.shutdown();
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
} else if (replIdx !== -1) {
  await runRepl();
} else {
  await preflightInteractiveAuth();
  await startTui({
    agentName: 'build',
    cwd: workspaceRoot,
    model,
    resumeSession,
    resumeSessionId,
    serverPath,
  }).catch((error: unknown) => {
    console.error(`[lavalamp] Fatal: ${(error as Error).message}`);
    process.exit(1);
  });
}
