import * as path from 'path';
import * as fs from 'fs';
import { Glob } from 'bun';

export class BackupEngine {
  private backupDir: string;

  constructor(private workspaceRoot: string) {
    this.backupDir = path.join(workspaceRoot, '.lavalamp', 'backups');
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }
  }

  async createBackup(): Promise<string> {
    const timestamp = Date.now().toString();
    const destFolder = path.join(this.backupDir, timestamp);
    fs.mkdirSync(destFolder, { recursive: true });

    const glob = new Glob('**/*.{ts,js,jsx,tsx,json,md,py,go,rs,cpp,c,h,css,html}');
    for await (const file of glob.scan({ cwd: this.workspaceRoot })) {
      if (
        file.includes('node_modules') ||
        file.includes('.git') ||
        file.includes('.lavalamp') ||
        file.includes('dist') ||
        file.includes('build')
      ) {
        continue;
      }
      const srcPath = path.join(this.workspaceRoot, file);
      const destPath = path.join(destFolder, file);

      const parent = path.dirname(destPath);
      if (!fs.existsSync(parent)) {
        fs.mkdirSync(parent, { recursive: true });
      }

      if (fs.existsSync(srcPath)) {
        fs.copyFileSync(srcPath, destPath);
      }
    }

    this.pruneBackups();
    return timestamp;
  }

  restoreBackup(timestamp: string): void {
    const srcFolder = path.join(this.backupDir, timestamp);
    if (!fs.existsSync(srcFolder)) {
      throw new Error(`Backup folder not found for timestamp: ${timestamp}`);
    }

    // Deep copy back to workspace root
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

  private pruneBackups() {
    try {
      const folders = fs.readdirSync(this.backupDir)
        .map((name) => ({ name, time: parseInt(name, 10) }))
        .filter((entry) => !isNaN(entry.time))
        .sort((a, b) => b.time - a.time);

      // Keep only top 8 backups
      if (folders.length > 8) {
        for (const extra of folders.slice(8)) {
          const extraPath = path.join(this.backupDir, extra.name);
          fs.rmSync(extraPath, { recursive: true, force: true });
        }
      }
    } catch {}
  }
}
