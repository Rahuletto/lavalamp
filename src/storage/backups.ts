import * as path from 'node:path';
import * as fs from 'node:fs';
import { workspaceDataDir } from './paths';

interface BackupManifest {
  mode: 'partial';
  files: {
    path: string;
    existed: boolean;
  }[];
}

export class BackupEngine {
  private readonly backupDir: string;

  constructor(private readonly workspaceRoot: string) {
    this.backupDir = path.join(workspaceDataDir(workspaceRoot), 'backups');
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
    const manifest: BackupManifest = { files: [], mode: 'partial' };
    const filesDir = path.join(destFolder, 'files');

    for (const requestedPath of new Set(paths)) {
      const resolved = this.resolveWorkspacePath(requestedPath);
      if (resolved === null) {
        continue;
      }

      const relative = path.relative(this.workspaceRoot, resolved);
      const existed = fs.existsSync(resolved);
      manifest.files.push({ existed, path: relative });

      if (!existed || !fs.statSync(resolved).isFile()) {
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

    const resolved = path.resolve(this.workspaceRoot, requestedPath);
    const relative = path.relative(this.workspaceRoot, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return null;
    }
    return resolved;
  }

  restoreBackup(timestamp: string): void {
    const srcFolder = path.join(this.backupDir, timestamp);
    if (!fs.existsSync(srcFolder)) {
      throw new Error(`Backup folder not found for timestamp: ${timestamp}`);
    }

    const manifestPath = path.join(srcFolder, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      this.restorePartialBackup(srcFolder, manifestPath);
      return;
    }

    const restoreDir = (dir: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullSrc = path.join(dir, entry.name);
        const relative = path.relative(srcFolder, fullSrc);
        const fullDest = path.join(this.workspaceRoot, relative);

        if (entry.isDirectory()) {
          if (!fs.existsSync(fullDest)) {
            fs.mkdirSync(fullDest, { recursive: true });
          }
          restoreDir(fullSrc);
        } else {
          fs.copyFileSync(fullSrc, fullDest);
        }
      }
    };
    restoreDir(srcFolder);
  }

  private restorePartialBackup(srcFolder: string, manifestPath: string): void {
    const manifest = JSON.parse(
      fs.readFileSync(manifestPath, 'utf8'),
    ) as BackupManifest;

    for (const file of manifest.files) {
      const destPath = path.join(this.workspaceRoot, file.path);
      if (!file.existed) {
        fs.rmSync(destPath, { force: true, recursive: true });
        continue;
      }

      const srcPath = path.join(srcFolder, 'files', file.path);
      if (!fs.existsSync(srcPath)) {
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
