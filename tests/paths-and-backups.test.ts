import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDefaultRules, matchRules } from '../src/permissions/rules.ts';
import { BackupEngine } from '../src/storage/backups.ts';
import { planMutationBackup } from '../src/storage/mutation-backups.ts';
import {
  configPathCandidates,
  credentialsPathCandidates,
  memoryPathCandidates,
  sessionDirs,
  workspaceDataDir,
} from '../src/storage/paths.ts';

const originalHome = process.env.HOME;
const originalLavalampHome = process.env.LAVALAMP_HOME;

function restoreEnv(): void {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalLavalampHome === undefined) {
    delete process.env.LAVALAMP_HOME;
  } else {
    process.env.LAVALAMP_HOME = originalLavalampHome;
  }
}

afterEach(() => {
  restoreEnv();
});

describe('path resolution', () => {
  test('LAVALAMP_HOME disables legacy fallback candidates', () => {
    const root = mkdtempSync(join(tmpdir(), 'lavalamp-home-'));
    process.env.LAVALAMP_HOME = root;

    expect(configPathCandidates()).toEqual([join(root, 'config.json')]);
    expect(credentialsPathCandidates()).toEqual([join(root, 'credentials')]);
    expect(sessionDirs()).toEqual([join(root, 'sessions')]);
    expect(memoryPathCandidates('/workspace')).toHaveLength(1);
    expect(workspaceDataDir('/workspace')).toStartWith(
      join(root, 'workspaces'),
    );

    rmSync(root, { force: true, recursive: true });
  });

  test('default candidates keep legacy paths readable', () => {
    delete process.env.LAVALAMP_HOME;

    expect(
      configPathCandidates().some((p) =>
        p.includes(join('.config', 'lavalamp', 'config.json')),
      ),
    ).toBe(true);
    expect(
      credentialsPathCandidates().some((p) =>
        p.includes(join('.config', 'lavalamp', 'credentials')),
      ),
    ).toBe(true);
    expect(
      sessionDirs().some((p) => p.includes(join('.agents', 'sessions'))),
    ).toBe(true);
    expect(
      memoryPathCandidates('/workspace').some((p) =>
        p.includes(join('.agents', 'memory')),
      ),
    ).toBe(true);
  });
});

describe('mutation backup planning', () => {
  test('ignores read-only shell inspection', () => {
    expect(
      planMutationBackup('bash', { command: 'sed -n 1,20p src/run.ts' }),
    ).toBeNull();
    expect(
      planMutationBackup('bash', { command: 'git diff -- src/run.ts' }),
    ).toBeNull();
  });

  test('extracts exact file targets from edit and shell mutations', () => {
    expect(
      planMutationBackup('edit', {
        patch: '[src/run.ts#abc]\nSWAP\n',
      }),
    ).toEqual({ paths: ['src/run.ts'] });
    expect(
      planMutationBackup('bash', {
        command: 'printf hi > "src/out file.txt"',
      }),
    ).toEqual({ paths: ['src/out file.txt'] });
    expect(
      planMutationBackup('bash', {
        command: "sed -i 's/a/b/' src/run.ts",
      }),
    ).toEqual({ paths: ['src/run.ts'] });
  });
});

describe('permission shell classification', () => {
  test('allows read-only shell and asks for mutating sed', () => {
    const rules = getDefaultRules();

    expect(
      matchRules('bash', { command: 'sed -n 1,20p src/run.ts' }, rules),
    ).toBe('allow');
    expect(
      matchRules('bash', { command: "sed -i 's/a/b/' src/run.ts" }, rules),
    ).toBe('ask');
  });
});

describe('BackupEngine', () => {
  test('restores edited files and removes files created after backup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lavalamp-backup-'));
    const state = mkdtempSync(join(tmpdir(), 'lavalamp-state-'));
    process.env.LAVALAMP_HOME = state;
    writeFileSync(join(root, 'a.txt'), 'before\n');

    const engine = new BackupEngine(root);
    const id = engine.createBackup(['a.txt', 'new.txt']);
    writeFileSync(join(root, 'a.txt'), 'after\n');
    writeFileSync(join(root, 'new.txt'), 'created\n');

    engine.restoreBackup(id);

    expect(await Bun.file(join(root, 'a.txt')).text()).toBe('before\n');
    expect(await Bun.file(join(root, 'new.txt')).exists()).toBe(false);

    rmSync(root, { force: true, recursive: true });
    rmSync(state, { force: true, recursive: true });
  });

  test('ignores backup targets outside the workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lavalamp-backup-'));
    const state = mkdtempSync(join(tmpdir(), 'lavalamp-state-'));
    const outside = mkdtempSync(join(tmpdir(), 'lavalamp-outside-'));
    process.env.LAVALAMP_HOME = state;
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(outside, 'secret.txt'), 'secret\n');

    const engine = new BackupEngine(root);
    const id = engine.createBackup(['../secret.txt', 'nested/new.txt']);
    writeFileSync(join(root, 'nested/new.txt'), 'created\n');
    engine.restoreBackup(id);

    expect(await Bun.file(join(outside, 'secret.txt')).text()).toBe('secret\n');
    expect(await Bun.file(join(root, 'nested/new.txt')).exists()).toBe(false);

    rmSync(root, { force: true, recursive: true });
    rmSync(state, { force: true, recursive: true });
    rmSync(outside, { force: true, recursive: true });
  });
});
