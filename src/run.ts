import { join, resolve } from 'node:path';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { startTui } from './tui/app';
import { resolveConfig } from './config/user-config';
import { lavalampDataDir } from './storage/paths';
import { preflightInteractiveAuth } from './run/auth-preflight';
import { runPrint } from './run/headless-print';
import { runRepl } from './run/headless-repl';

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
  lavalamp ask                   Start interactive read-only session to ask questions about the codebase
  lavalamp ask "PROMPT"          Ask a single question about the codebase and exit
  lavalamp -p "PROMPT"           Run a single prompt and exit
  lavalamp --repl                TUI-less interactive REPL (multi-turn, stdin pipe)
  lavalamp --simple              Plain stdin/stdout chat (no TUI rendering)
  lavalamp --continue            Resume a previous session
  lavalamp --workspace /path     Set workspace directory (default: cwd)
  lavalamp --model MODEL         Override default model
  lavalamp models                List known models
  lavalamp config show           Show persisted config
  lavalamp config set KEY VALUE  Persist model/Gateway config

OPTIONS:
  -p, --print PROMPT             Run a single prompt and exit
      --repl                     TUI-less interactive REPL
      --simple                   Plain text chat mode
      --yes, --auto-approve      Auto-approve tool calls in headless modes
      --sudo                     Dangerously auto-approve all tools (headless only; no OS elevation)
  -c, --continue [SESSION_ID]    Resume a previous session
  -w, --workspace PATH           Set workspace directory
  -m, --model MODEL              Override the configured model
      --output-format FORMAT     Output format: text or json
      --quiet                    Suppress diagnostic status messages
  -h, --help                     Show this help
  -v, --version                  Show version
`);
  process.exit(0);
}

const askIdx = findFlag(['-a', '--ask']);
const askMode = askIdx !== -1 || process.env.LAVALAMP_ASK === '1';
const askPromptArg = askIdx === -1 ? undefined : process.argv[askIdx + 1];

// Print mode is active if -p/--print is passed OR if -a/--ask is passed WITH a prompt argument
const hasAskPrompt =
  askPromptArg !== undefined && !askPromptArg.startsWith('-');
const printIdx = findFlag(['-p', '--print', '--inline']);
const isPrintMode = printIdx !== -1 || hasAskPrompt;
const printPromptIdx = printIdx !== -1 ? printIdx : askIdx;

const replIdx = findFlag(['--repl']);
const simpleIdx = findFlag(['--simple']);
const simpleMode = simpleIdx !== -1;
const continueIdx = process.argv.indexOf('--continue');
const resumeSession = continueIdx !== -1;
const continueArg =
  continueIdx !== -1 ? process.argv[continueIdx + 1] : undefined;
const resumeSessionId =
  resumeSession && continueArg !== undefined && !continueArg.startsWith('-')
    ? continueArg
    : undefined;
const outputFormatStr = findFlagValue(['--output-format', '--format']) ?? 'text';
const quiet = process.argv.includes('--quiet');
const sudoMode = process.argv.includes('--sudo');
const autoApprove =
  sudoMode ||
  process.argv.includes('--yes') ||
  process.argv.includes('--auto-approve');

if (sudoMode && !isPrintMode && replIdx === -1 && !simpleMode) {
  console.error(
    '[lavalamp] Error: --sudo is only available with -p, --repl, or --simple',
  );
  process.exit(1);
}

if (outputFormatStr !== 'text' && outputFormatStr !== 'json') {
  console.error('[lavalamp] Error: --output-format must be text or json');
  process.exit(1);
}
const outputFormat = outputFormatStr as 'text' | 'json';

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

async function main() {
  const agentName = askMode ? 'explore' : 'build';
  const replLikeMode = replIdx !== -1 || simpleMode;

  if (isPrintMode) {
    let prompt = process.argv[printPromptIdx + 1] ?? '';
    const stdinContent = await readStdin();

    if (!prompt && stdinContent.length > 0) {
      prompt = stdinContent;
    } else if (!prompt && stdinContent.length === 0) {
      console.error('[lavalamp] Error: prompt argument required');
      process.exit(1);
    }

    await runPrint({
      autoApprove,
      prompt,
      stdinContent,
      quiet,
      outputFormat,
      workspaceRoot,
      serverPath,
      config,
      env,
      model,
      agentName,
    });
  } else if (replLikeMode) {
    await runRepl({
      quiet: quiet || simpleMode,
      outputFormat,
      workspaceRoot,
      serverPath,
      config,
      env,
      model,
      agentName,
      simpleMode,
    });
  } else {
    await preflightInteractiveAuth({
      config,
      env,
      model,
      outputFormat,
    });

    await startTui({
      agentName,
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
}

await main();
