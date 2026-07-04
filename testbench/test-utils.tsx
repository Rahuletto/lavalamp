import { mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach } from 'bun:test';
import { createDriver } from '@nigel-dev/opentui-test';
import type { Driver } from '@nigel-dev/opentui-test';
import React, { act } from 'react';
import { BenchApp, createSlashCommandHarness } from './tui-harness.tsx';

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root !== undefined) {
      await rm(root, { force: true, recursive: true });
    }
  }
});

export function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'lavalamp-testbench-'));
  tempRoots.push(root);
  return root;
}

export async function createPreparedHarness() {
  const workspace = makeWorkspace();
  await writeFile(join(workspace, 'AGENTS.md'), '# Bench Memory\nkeep this\n');
  await mkdir(join(workspace, '.agents/skills/example'), { recursive: true });
  await writeFile(
    join(workspace, '.agents/skills/example/SKILL.md'),
    '# example\n',
  );
  await mkdir(join(workspace, 'dist'), { recursive: true });
  await writeFile(
    join(workspace, 'dist/server.mjs'),
    'export default [{ name: "write" }, { name: "edit" }];\n',
  );

  const harness = createSlashCommandHarness({ cwd: workspace });
  harness.seedMessages([
    { role: 'user', content: 'first prompt' },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'second prompt' },
    { role: 'assistant', content: 'second answer' },
  ]);
  return { harness, workspace };
}

export function createSeededHarness() {
  const workspace = makeWorkspace();
  const harness = createSlashCommandHarness({ cwd: workspace });
  harness.seedMessages([
    { role: 'user', content: 'one' },
    { role: 'assistant', content: 'two' },
    { role: 'user', content: 'three' },
    { role: 'assistant', content: 'four' },
  ]);
  return { harness, workspace };
}

export async function createDriverForWorkspace(
  workspace: string,
  size: { width: number; height: number } = { width: 100, height: 30 },
) {
  const driver = await createDriver({
    ...size,
    app: React.createElement(BenchApp, { cwd: workspace }),
  });
  await driver.launch();
  return driver;
}

export async function submitText(driver: Driver, text: string) {
  await act(async () => {
    await driver.typeText(text);
  });
  await act(async () => {
    await driver.pressEnter();
  });
}
