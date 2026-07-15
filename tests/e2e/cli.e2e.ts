import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../..');
const executable = resolve(root, 'src/run.ts');

async function run(...args: string[]) {
  const child = Bun.spawn([process.execPath, executable, ...args], {
    cwd: root,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stderr, stdout };
}

describe('actual CLI entrypoint', () => {
  test('prints help without starting the runtime', async () => {
    const result = await run('--help');

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('lavalamp — AI coding harness');
    expect(result.stdout).toContain('--output-format');
  });

  test('prints the current version', async () => {
    const result = await run('--version');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('lavalamp 0.1.2');
  });

  test('does not self-update the Bun development runtime', async () => {
    const result = await run('update');

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'Self-update is only available in release binaries',
    );
  });

  test('rejects an invalid output format', async () => {
    const result = await run('-p', 'hello', '--output-format', 'xml');

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--output-format must be text or json');
  });
});
