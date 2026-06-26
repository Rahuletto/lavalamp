import { join, resolve } from 'node:path';
import { FlueProcess } from './tui/ipc';
import { startTui } from './tui/app';

const workspaceRoot = process.env.LAVALAMP_WORKSPACE ?? process.cwd();
const model = process.env.LAVALAMP_MODEL;

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

  if (outputFormat === 'json') {
    let fullText = '';
    let usage: Record<string, unknown> = {};
    let modelInfo: Record<string, unknown> = {};

    flue.prompt(fullPrompt, {
      onError: (err) => {
        process.stdout.write(`${JSON.stringify({ error: err.message })  }\n`);
      },
      onEvent: (event) => {
        if (event.type === 'text_delta') {
          fullText += event.text ?? event.delta ?? '';
        }
      },
      onResult: (result) => {
        if (result !== undefined && result.usage !== undefined) {usage = result.usage as Record<string, unknown>;}
        if (result !== undefined && result.model !== undefined) {modelInfo = result.model as Record<string, unknown>;}
        process.stdout.write(
          `${JSON.stringify({ model: modelInfo, text: fullText, usage })  }\n`,
        );
      },
    });
  } else {
    flue.prompt(fullPrompt, {
      onError: (err) => {
        console.error(`\n  error: ${err.message}`);
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
      },
    });
  }
} else {
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
