import { join, resolve } from 'node:path';
import { FlueProcess } from './tui/ipc';
import { startTui } from './tui/app';
import { resolveConfig } from './config/user-config';
import { BUILD_MODEL, detectProvider } from './config/models';
import { login } from './auth/login';

const workspaceRoot = process.env.LAVALAMP_WORKSPACE ?? process.cwd();
const config = resolveConfig();
const model =
  process.env.LAVALAMP_MODEL ?? (
    config.defaultModel.length > 0 ? config.defaultModel : undefined
  );

const repoRoot = resolve(import.meta.dir, '..');
const serverPath = join(repoRoot, 'dist', 'server.mjs');

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

const printIdx = findFlag(['-p', '--print', '--inline']);
const continueIdx = process.argv.indexOf('--continue');
const resumeSession = continueIdx !== -1;
const resumeSessionId =
  resumeSession &&
  continueIdx + 1 < process.argv.length &&
  !process.argv[continueIdx + 1].startsWith('-')
    ? process.argv[continueIdx + 1]
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
  return Buffer.concat(chunks).toString('utf8').trim();
}

function needsCloudflareAuth(selectedModel: string | undefined): boolean {
  if (config.gatewayEnabled) {
    return true;
  }

  const provider = detectProvider(selectedModel ?? BUILD_MODEL);
  return provider === 'cloudflare-workers-ai';
}

async function preflightInteractiveAuth(): Promise<void> {
  if (!needsCloudflareAuth(model)) {
    return;
  }

  console.error('[lavalamp] Authenticating...');
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

if (printIdx !== -1) {
  let prompt = process.argv[printIdx + 1] ?? '';
  const stdinContent = await readStdin();

  if (!prompt && stdinContent) {
    prompt = stdinContent;
  } else if (!prompt && !stdinContent) {
    console.error('[lavalamp] Error: -p requires a prompt argument');
    process.exit(1);
  }

  const fullPrompt =
    stdinContent && prompt !== stdinContent
      ? `${stdinContent}\n\n---\n\n${prompt}`
      : prompt;

  if (!quiet) {
    console.error(`[lavalamp] Running: ${prompt}`);
    console.error(`[lavalamp] Workspace: ${workspaceRoot}`);
  }

  const flue = new FlueProcess(serverPath, workspaceRoot, 'build');
  await flue.start();

  let exitCode = 0;
  if (outputFormat === 'json') {
    let fullText = '';
    let usage: Record<string, unknown> = {};
    let modelInfo: Record<string, unknown> = {};

    exitCode = await new Promise<number>((resolveExit) => {
      flue.prompt(fullPrompt, {
        onError: (err) => {
          process.stdout.write(`${JSON.stringify({ error: err.message })  }\n`);
          resolveExit(1);
        },
        onEvent: (event) => {
          if (event.type === 'text_delta') {
            fullText += event.text ?? event.delta ?? '';
          }
        },
        onResult: (result) => {
          if (result !== undefined && result.usage !== undefined) {
            usage = result.usage as Record<string, unknown>;
          }
          if (result !== undefined && result.model !== undefined) {
            modelInfo = result.model as Record<string, unknown>;
          }
          const provider =
            typeof modelInfo.provider === 'string'
              ? modelInfo.provider
              : detectProvider(model ?? '');
          const gateway =
            config.gatewayEnabled &&
            config.gatewayId.length > 0 &&
            provider !== undefined &&
            ['cloudflare-workers-ai', 'openai', 'anthropic'].includes(provider);
          process.stdout.write(
            `${JSON.stringify({
              cost: (usage as { cost?: unknown }).cost ?? {},
              model: modelInfo,
              route: {
                gatewayId: gateway ? config.gatewayId : undefined,
                mode: gateway ? 'gateway' : 'direct',
                provider,
              },
              text: fullText,
              usage,
            })  }\n`,
          );
          resolveExit(0);
        },
      });
    });
  } else {
    exitCode = await new Promise<number>((resolveExit) => {
      flue.prompt(fullPrompt, {
        onError: (err) => {
          console.error(`\n  error: ${err.message}`);
          resolveExit(1);
        },
        onEvent: (event) => {
          if (event.type === 'text_delta') {
            process.stdout.write(event.text ?? event.delta ?? '');
          }
        },
        onResult: (result) => {
          if (result !== undefined && result.usage !== undefined) {
            const u = result.usage;
            const modelStr = result.model !== undefined
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
