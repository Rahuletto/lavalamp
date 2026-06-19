import { join, resolve } from 'path';
import { FlueProcess } from './tui/ipc';
import { startTui } from './tui/app';
import { login } from './auth';

const workspaceRoot = process.env.LAVALAMP_WORKSPACE ?? process.cwd();
const model = process.env.LAVALAMP_MODEL;

const repoRoot = resolve(import.meta.dir, '..');
const serverPath = join(repoRoot, 'dist', 'server.mjs');

function findFlag(flags: string[]): number {
  for (const f of flags) {
    const idx = process.argv.indexOf(f);
    if (idx !== -1) return idx;
  }
  return -1;
}

function findFlagValue(flags: string[]): string | null {
  const idx = findFlag(flags);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

const printIdx = findFlag(['-p', '--print', '--inline']);
const continueIdx = process.argv.indexOf('--continue');
const resumeSession = continueIdx !== -1;
const resumeSessionId = resumeSession && continueIdx + 1 < process.argv.length && !process.argv[continueIdx + 1].startsWith('-')
  ? process.argv[continueIdx + 1]
  : undefined;
const outputFormat = findFlagValue(['--output-format', '--format']) ?? 'text';
const quiet = process.argv.includes('--quiet');

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8').trim();
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

  const fullPrompt = stdinContent && prompt !== stdinContent
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
      onEvent: (event) => {
        if (event.type === 'text_delta') {
          fullText += event.text ?? event.delta ?? '';
        }
      },
      onResult: (result) => {
        if (result?.usage) usage = result.usage as Record<string, unknown>;
        if (result?.model) modelInfo = result.model as Record<string, unknown>;
        process.stdout.write(JSON.stringify({ text: fullText, usage, model: modelInfo }) + '\n');
        flue.shutdown().then(() => process.exit(0));
      },
      onError: (err) => {
        process.stdout.write(JSON.stringify({ error: err.message }) + '\n');
        flue.shutdown().then(() => process.exit(1));
      },
    });
  } else {
    flue.prompt(fullPrompt, {
      onEvent: (event) => {
        if (event.type === 'text_delta') {
          process.stdout.write(event.text ?? event.delta ?? '');
        }
      },
      onResult: (result) => {
        if (result?.usage) {
          const u = result.usage;
          const modelStr = result.model ? `${result.model.provider}/${result.model.id}` : '';
          console.error(`\n  ${u.totalTokens} tok | $${u.cost.total.toFixed(4)} | ${modelStr}`);
        }
        flue.shutdown().then(() => process.exit(0));
      },
      onError: (err) => {
        console.error(`\n  error: ${err.message}`);
        flue.shutdown().then(() => process.exit(1));
      },
    });
  }
} else {
  startTui({
    serverPath,
    cwd: workspaceRoot,
    agentName: 'build',
    model,
    resumeSession,
    resumeSessionId,
  }).catch((err) => {
    console.error(`[lavalamp] Fatal: ${err.message}`);
    process.exit(1);
  });
}
