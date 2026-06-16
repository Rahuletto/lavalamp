import { join, resolve } from 'path';
import { FlueProcess } from './repl/ipc';
import { EventRenderer } from './repl/render';
import { startRepl } from './repl/repl';

const workspaceRoot = process.env.LAVALAMP_WORKSPACE ?? process.cwd();
const model = process.env.LAVALAMP_MODEL;

const repoRoot = resolve(import.meta.dir, '..');
const serverPath = join(repoRoot, 'dist', 'server.mjs');

const inlineIdx = process.argv.indexOf('--inline');
if (inlineIdx !== -1) {
  const prompt = process.argv[inlineIdx + 1];
  if (!prompt) {
    console.error('[lavalamp] Error: --inline requires a prompt');
    process.exit(1);
  }

  const flue = new FlueProcess(serverPath, workspaceRoot, 'build');
  const renderer = new EventRenderer(process.stdout);

  await flue.start();

  flue.prompt(prompt, {
    onEvent: (event) => renderer.render(event),
    onResult: (result) => {
      renderer.flush();
      if (result?.usage) {
        const u = result.usage;
        const modelStr = result.model ? `${result.model.provider}/${result.model.id}` : '';
        console.error(`\n  ${u.totalTokens} tok | $${u.cost.total.toFixed(4)} | ${modelStr}`);
      }
      flue.shutdown().then(() => process.exit(0));
    },
    onError: (err) => {
      renderer.flush();
      console.error(`\n  error: ${err.message}`);
      flue.shutdown().then(() => process.exit(1));
    },
  });
} else {
  startRepl({
    serverPath,
    cwd: workspaceRoot,
    agentName: 'build',
    model,
  }).catch((err) => {
    console.error(`[lavalamp] Fatal: ${err.message}`);
    process.exit(1);
  });
}
