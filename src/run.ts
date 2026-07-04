import { join, resolve } from 'node:path';
import { FlueProcess } from './tui/ipc';
import { startTui } from './tui/app';
import { resolveConfig } from './config/user-config';
import { BUILD_MODEL } from './config/models';
import { resolveRuntimeRoute } from './config/runtime-route';
import { login, validateCredentials } from './auth/login';
import { loadCredentials } from './auth/credentials';

const workspaceRoot = process.env.LAVALAMP_WORKSPACE ?? process.cwd();
const config = resolveConfig();
const env = process.env as Record<string, string | undefined>;
const model =
  env.LAVALAMP_MODEL ??
  (config.defaultModel.length > 0 ? config.defaultModel : undefined);

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
