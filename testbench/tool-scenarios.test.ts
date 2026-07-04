import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { makeWorkspace } from './test-utils.tsx';
import { runToolScenario } from './tool-scenarios.ts';

describe('file tool call scenarios', () => {
  test('create writes a file inside the bench workspace', async () => {
    const workspace = makeWorkspace();

    const create = await runToolScenario(workspace, {
      action: 'create',
      path: 'notes/bench.txt',
      content: 'first\n',
    });
    expect(create).toEqual({
      action: 'create',
      ok: true,
      path: 'notes/bench.txt',
    });
    expect(readFileSync(join(workspace, 'notes/bench.txt'), 'utf8')).toBe(
      'first\n',
    );
  });

  test('edit replaces file content inside the bench workspace', async () => {
    const workspace = makeWorkspace();
    await mkdir(join(workspace, 'notes'), { recursive: true });
    await writeFile(join(workspace, 'notes/bench.txt'), 'first\n');

    const edit = await runToolScenario(workspace, {
      action: 'edit',
      path: 'notes/bench.txt',
      content: 'second\n',
    });
    expect(edit).toEqual({
      action: 'edit',
      ok: true,
      path: 'notes/bench.txt',
    });
    expect(readFileSync(join(workspace, 'notes/bench.txt'), 'utf8')).toBe(
      'second\n',
    );
  });

  test('delete removes a file inside the bench workspace', async () => {
    const workspace = makeWorkspace();
    await mkdir(join(workspace, 'notes'), { recursive: true });
    await writeFile(join(workspace, 'notes/bench.txt'), 'second\n');

    const remove = await runToolScenario(workspace, {
      action: 'delete',
      path: 'notes/bench.txt',
    });
    expect(remove).toEqual({
      action: 'delete',
      ok: true,
      path: 'notes/bench.txt',
    });
    expect(await Bun.file(join(workspace, 'notes/bench.txt')).exists()).toBe(
      false,
    );
  });

  test('rejects paths outside the bench workspace', async () => {
    const workspace = makeWorkspace();
    const outside = join(workspace, '..', 'outside.txt');
    await writeFile(outside, 'do not touch\n');

    await expect(
      runToolScenario(workspace, {
        action: 'create',
        path: '../outside.txt',
        content: 'changed\n',
      }),
    ).rejects.toThrow('outside workspace');
  });
});
