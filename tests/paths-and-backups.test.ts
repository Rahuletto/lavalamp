import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDefaultRules, matchRules } from '../src/permissions/rules.ts';
import {
  autorunPattern,
  clearAutorun,
  getMatchingAutorun,
  setAutorun,
} from '../src/permissions/autorun.ts';
import { BackupEngine } from '../src/storage/backups.ts';
import { planMutationBackup } from '../src/storage/mutation-backups.ts';
import { WorkspaceGuard } from '../src/sandbox/workspace.ts';
import { ChangeTracker } from '../src/tools/change-tracker.ts';
import { truncateToolResult } from '../src/tools/result-budget.ts';
import { readOnlyLocal } from '../src/sandbox/local.ts';
import {
  configPathCandidates,
  credentialsPathCandidates,
  memoryPathCandidates,
  sessionPathCandidates,
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

  test('rejects session path traversal', () => {
    expect(sessionPathCandidates('../credentials')).toEqual([]);
    expect(sessionPathCandidates('nested/session')).toEqual([]);
    expect(sessionPathCandidates('session_123')).not.toHaveLength(0);
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
  test('asks before every free-form shell command', () => {
    const rules = getDefaultRules();

    expect(
      matchRules('bash', { command: 'sed -n 1,20p src/run.ts' }, rules),
    ).toBe('ask');
    expect(
      matchRules('bash', { command: "sed -i 's/a/b/' src/run.ts" }, rules),
    ).toBe('ask');
    expect(
      matchRules(
        'bash',
        { command: 'cat "$(touch /tmp/lavalamp-audit)"' },
        rules,
      ),
    ).toBe('ask');
    expect(
      matchRules('bash', { command: 'cat ~/.ssh/id_rsa' }, rules),
    ).toBe('ask');
  });

  test('lets explicit user rules tighten defaults', () => {
    const rules = [
      { action: 'deny' as const, tool: 'fetch_url' },
      ...getDefaultRules(),
    ];
    expect(matchRules('fetch_url', { url: 'https://example.com' }, rules)).toBe(
      'deny',
    );
  });

  test('scopes always-allow to the exact approved arguments', () => {
    const state = mkdtempSync(join(tmpdir(), 'lavalamp-state-'));
    process.env.LAVALAMP_HOME = state;
    const cwd = '/workspace';
    const approved = { command: 'bun test' };

    clearAutorun(cwd);
    setAutorun(cwd, 'bash', 'allow', autorunPattern(approved));

    expect(getMatchingAutorun('bash', approved)?.action).toBe('allow');
    expect(getMatchingAutorun('bash', { command: 'rm -rf .' })).toBeUndefined();

    clearAutorun(cwd);
    rmSync(state, { force: true, recursive: true });
  });
});

describe('WorkspaceGuard', () => {
  test('rejects symlinks that escape the workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'lavalamp-workspace-'));
    const outside = mkdtempSync(join(tmpdir(), 'lavalamp-outside-'));
    writeFileSync(join(outside, 'secret.txt'), 'secret\n');
    symlinkSync(
      outside,
      join(root, 'external'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const guard = new WorkspaceGuard(root);
    expect(() => guard.constrain('external/secret.txt')).toThrow();
    expect(() => guard.constrain('external/new.txt')).toThrow();

    rmSync(root, { force: true, recursive: true });
    rmSync(outside, { force: true, recursive: true });
  });

  test('allows new files beneath a real workspace directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'lavalamp-workspace-'));
    const guard = new WorkspaceGuard(root);

    expect(guard.constrain('nested/new.txt')).toBe(
      join(guard.root, 'nested/new.txt'),
    );

    rmSync(root, { force: true, recursive: true });
  });

  test('rejects a symlink as a rename entry', () => {
    const root = mkdtempSync(join(tmpdir(), 'lavalamp-workspace-'));
    mkdirSync(join(root, 'target'));
    symlinkSync(
      join(root, 'target'),
      join(root, 'alias'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const guard = new WorkspaceGuard(root);

    expect(() => guard.constrainEntry('alias')).toThrow();

    rmSync(root, { force: true, recursive: true });
  });

  test('rejects symlink aliases to secret files', () => {
    const root = mkdtempSync(join(tmpdir(), 'lavalamp-guard-'));
    writeFileSync(join(root, '.env'), 'TOKEN=secret\n');
    symlinkSync(join(root, '.env'), join(root, 'safe.txt'));

    const guard = new WorkspaceGuard(root);
    expect(() => guard.constrain('safe.txt')).toThrow();

    rmSync(root, { force: true, recursive: true });
  });
});

describe('ChangeTracker', () => {
  test('restores binary files without text conversion', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lavalamp-tracker-'));
    const filePath = join(root, 'binary.dat');
    const original = new Uint8Array([0, 255, 1, 128, 10]);
    await Bun.write(filePath, original);
    const tracker = new ChangeTracker();

    await tracker.record('binary change', [filePath]);
    await Bun.write(filePath, new Uint8Array([1, 2, 3]));
    await tracker.undoLast();

    expect(new Uint8Array(await Bun.file(filePath).arrayBuffer())).toEqual(original);

    rmSync(root, { force: true, recursive: true });
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

describe('tool result budgets', () => {
  test('preserves small results and bounds oversized results', () => {
    expect(truncateToolResult('small', 100)).toBe('small');

    const result = truncateToolResult('a'.repeat(1000), 200);
    expect(result.length).toBe(200);
    expect(result).toContain('Tool result truncated');
    expect(result.startsWith('a')).toBe(true);
    expect(result.endsWith('a')).toBe(true);
  });
});

describe('read-only sandbox', () => {
  test('suppresses Flue built-in mutation tools', () => {
    const sandbox = readOnlyLocal();
    expect(sandbox.tools()).toEqual([]);
  });
});
