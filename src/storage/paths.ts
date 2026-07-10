import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import * as path from 'node:path';

function homeOverride(): string | undefined {
  const override = process.env.LAVALAMP_HOME;
  return override !== undefined && override.length > 0 ? override : undefined;
}

function cleanSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-');
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of paths) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    out.push(candidate);
  }
  return out;
}

export function lavalampConfigDir(): string {
  const override = homeOverride();
  if (override !== undefined) {
    return override;
  }

  if (process.platform === 'win32') {
    return path.join(
      process.env.APPDATA ??
        process.env.LOCALAPPDATA ??
        path.join(homedir(), 'AppData', 'Roaming'),
      'lavalamp',
    );
  }

  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', 'lavalamp');
  }

  return path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'),
    'lavalamp',
  );
}

export function lavalampDataDir(): string {
  const override = homeOverride();
  if (override !== undefined) {
    return override;
  }

  if (process.platform === 'win32') {
    return path.join(
      process.env.LOCALAPPDATA ??
        process.env.APPDATA ??
        path.join(homedir(), 'AppData', 'Local'),
      'lavalamp',
    );
  }

  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', 'lavalamp');
  }

  return path.join(
    process.env.XDG_DATA_HOME ?? path.join(homedir(), '.local', 'share'),
    'lavalamp',
  );
}

export function legacyConfigDir(): string {
  return path.join(homedir(), '.config', 'lavalamp');
}

export function legacyAgentsDir(): string {
  return path.join(homedir(), '.agents');
}

export function configPath(): string {
  return path.join(lavalampConfigDir(), 'config.json');
}

export function configPathCandidates(): string[] {
  if (homeOverride() !== undefined) {
    return [configPath()];
  }
  return uniquePaths([
    configPath(),
    path.join(legacyConfigDir(), 'config.json'),
  ]);
}

export function credentialsPath(): string {
  return path.join(lavalampConfigDir(), 'credentials');
}

export function credentialsPathCandidates(): string[] {
  if (homeOverride() !== undefined) {
    return [credentialsPath()];
  }
  return uniquePaths([
    credentialsPath(),
    path.join(legacyConfigDir(), 'credentials'),
  ]);
}

export function sessionsDir(): string {
  return path.join(lavalampDataDir(), 'sessions');
}

export function legacySessionsDir(): string {
  return path.join(legacyAgentsDir(), 'sessions');
}

export function sessionDirs(): string[] {
  if (homeOverride() !== undefined) {
    return [sessionsDir()];
  }
  return uniquePaths([sessionsDir(), legacySessionsDir()]);
}

export function sessionPath(sessionId: string): string {
  return path.join(sessionsDir(), `${sessionId}.json`);
}

export function sessionPathCandidates(sessionId: string): string[] {
  return sessionDirs().map((dir) => path.join(dir, `${sessionId}.json`));
}

export function memoryDir(): string {
  return path.join(lavalampDataDir(), 'memory');
}

export function legacyMemoryDir(): string {
  return path.join(legacyAgentsDir(), 'memory');
}

export function memoryPath(workspaceRoot: string): string {
  return path.join(memoryDir(), `${workspaceHash(workspaceRoot)}.md`);
}

export function memoryPathCandidates(workspaceRoot: string): string[] {
  const file = `${workspaceHash(workspaceRoot)}.md`;
  if (homeOverride() !== undefined) {
    return [memoryPath(workspaceRoot)];
  }
  return uniquePaths([
    memoryPath(workspaceRoot),
    path.join(legacyMemoryDir(), file),
  ]);
}

export function workspaceDataDir(workspaceRoot: string): string {
  const resolved = path.resolve(workspaceRoot);
  const name = cleanSegment(path.basename(resolved) || 'workspace');
  const hash = createHash('sha256').update(resolved).digest('hex').slice(0, 12);
  return path.join(lavalampDataDir(), 'workspaces', `${name}-${hash}`);
}

export function skillDirs(workspaceRoot: string): string[] {
  const dirs = [
    path.join(path.resolve(workspaceRoot), '.agents', 'skills'),
    path.join(lavalampDataDir(), 'skills'),
  ];
  if (homeOverride() === undefined) {
    dirs.push(path.join(legacyAgentsDir(), 'skills'));
  }
  return uniquePaths(dirs);
}

function workspaceHash(workspaceRoot: string): string {
  const resolved = path.resolve(workspaceRoot);
  return createHash('sha256').update(resolved).digest('hex').slice(0, 12);
}
