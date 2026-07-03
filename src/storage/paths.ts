import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import * as path from 'node:path';

function cleanSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-');
}

export function lavalampDataDir(): string {
  const override = process.env.LAVALAMP_HOME;
  if (override !== undefined && override.length > 0) {
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

export function workspaceDataDir(workspaceRoot: string): string {
  const resolved = path.resolve(workspaceRoot);
  const name = cleanSegment(path.basename(resolved) || 'workspace');
  const hash = createHash('sha256').update(resolved).digest('hex').slice(0, 12);
  return path.join(lavalampDataDir(), 'workspaces', `${name}-${hash}`);
}
