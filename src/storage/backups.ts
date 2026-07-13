import * as path from 'node:path';
import * as fs from 'node:fs';
import { workspaceDataDir } from './paths';
import { WorkspaceGuard } from '../sandbox/workspace';

interface BackupManifest {
  createdAt: string;
  mode: 'partial';
  files: {
    path: string;
    existed: boolean;
    backedUp: boolean;
  }[];
  version: 1;
}

export class BackupEngine {
  private readonly backupDir: string;
  private readonly guard: WorkspaceGuard;

  constructor(private readonly workspaceRoot: string) {
    this.guard = new WorkspaceGuard(workspaceRoot);
    this.workspaceRoot = this.guard.root;
    this.backupDir = path.join(workspaceDataDir(this.workspaceRoot), 'backups');
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }
  }

  createBackup(paths: string[]): string {
    const timestamp = Date.now().toString();
    const destFolder = path.join(this.backupDir, timestamp);
    fs.mkdirSync(destFolder, { recursive: true });
    this.createPartialBackup(destFolder, paths);
    this.pruneBackups();
    return timestamp;
  }

  private createPartialBackup(destFolder: string, paths: string[]): void {
    const manifest: BackupManifest = {
      createdAt: new Date().toISOString(),
      files: [],
      mode: 'partial',
      version: 1,
    };
    const filesDir = path.join(destFolder, 'files');

    for (const requestedPath of new Set(paths)) {
      const resolved = this.resolveWorkspacePath(requestedPath);
      if (resolved === null) {
        continue;
      }

      const relative = path.relative(this.workspaceRoot, resolved);
      const existed = fs.existsSync(resolved);
      const backedUp = existed && fs.statSync(resolved).isFile();
      manifest.files.push({ backedUp, existed, path: relative });

      if (!backedUp) {
        continue;
      }

      const destPath = path.join(filesDir, relative);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(resolved, destPath);
    }

    fs.writeFileSync(
      path.join(destFolder, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
    );
  }

  private resolveWorkspacePath(requestedPath: string): string | null {
    if (requestedPath.trim().length === 0) {
      return null;
    }

    try {
      return this.guard.constrain(requestedPath);
    } catch {
      return null;
    }
  }

  restoreBackup(timestamp: string): void {
    const srcFolder = path.join(this.backupDir, timestamp);
    if (!fs.existsSync(srcFolder)) {
      throw new Error(`Backup folder not found for timestamp: ${timestamp}`);
    }

    const manifestPath = path.join(srcFolder, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      this.restorePartialBackup(srcFolder, this.readManifest(manifestPath));
      return;
    }
    throw new Error(`Invalid backup: manifest not found in ${srcFolder}`);
  }

  private readManifest(manifestPath: string): BackupManifest {
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null) {
      throw new Error(`Invalid backup manifest: ${manifestPath}`);
    }
    const record = raw as Record<string, unknown>;
    if (record.mode !== 'partial' || !Array.isArray(record.files)) {
      throw new Error(`Invalid backup manifest: ${manifestPath}`);
    }
    const files = record.files
      .map((entry): BackupManifest['files'][number] | null => {
        if (typeof entry !== 'object' || entry === null) {
          return null;
        }
        const file = entry as Record<string, unknown>;
        if (
          typeof file.path !== 'string' ||
          typeof file.existed !== 'boolean'
        ) {
          return null;
        }
        return {
          backedUp:
            typeof file.backedUp === 'boolean' ? file.backedUp : file.existed,
          existed: file.existed,
          path: file.path,
        };
      })
      .filter(
        (entry): entry is BackupManifest['files'][number] => entry !== null,
      );
    return {
      createdAt:
        typeof record.createdAt === 'string'
          ? record.createdAt
          : new Date(0).toISOString(),
      files,
      mode: 'partial',
      version: 1,
    };
  }

  private restorePartialBackup(
    srcFolder: string,
    manifest: BackupManifest,
  ): void {
    for (const file of manifest.files) {
      const destPath = this.resolveWorkspacePath(file.path);
      if (destPath === null) {
        continue;
      }
      if (!file.existed) {
        fs.rmSync(destPath, { force: true, recursive: true });
        continue;
      }

      if (!file.backedUp) {
        continue;
      }
      const srcPath = path.join(srcFolder, 'files', file.path);
      const relative = path.relative(path.join(srcFolder, 'files'), srcPath);
      if (
        relative.startsWith('..') ||
        path.isAbsolute(relative) ||
        !fs.existsSync(srcPath)
      ) {
        continue;
      }
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(srcPath, destPath);
    }
  }

  private pruneBackups() {
    try {
      const folders = fs
        .readdirSync(this.backupDir)
        .map((name) => ({ name, time: Number.parseInt(name, 10) }))
        .filter((entry) => !Number.isNaN(entry.time))
        .toSorted((a, b) => b.time - a.time);

      // Keep only top 8 backups
      if (folders.length > 8) {
        for (const extra of folders.slice(8)) {
          const extraPath = path.join(this.backupDir, extra.name);
          fs.rmSync(extraPath, { force: true, recursive: true });
        }
      }
    } catch {}
  }
}
