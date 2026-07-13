import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { workspaceDataDir } from './paths';

export function copyTextToClipboard(text: string): boolean {
  const input = Buffer.from(text);
  const commands: Array<[string, string[]]> =
    process.platform === 'darwin'
      ? [['pbcopy', []]]
      : process.platform === 'win32'
        ? [['clip.exe', []]]
        : process.platform === 'linux'
          ? [
              ['wl-copy', []],
              ['xclip', ['-selection', 'clipboard']],
            ]
          : [];

  for (const [command, args] of commands) {
    const result = spawnSync(command, args, { input });
    if (result.status === 0) {
      return true;
    }
  }
  return false;
}

export async function pasteImageFromClipboard(
  workspaceRoot: string,
): Promise<string | null> {
  const attachmentsDir = path.join(
    workspaceDataDir(workspaceRoot),
    'attachments',
  );
  if (!fs.existsSync(attachmentsDir)) {
    fs.mkdirSync(attachmentsDir, { recursive: true });
  }

  const filename = `img_${Date.now()}.png`;
  const destPath = path.join(attachmentsDir, filename);

  try {
    if (process.platform === 'darwin') {
      // Sniff clipboard info first
      const check = spawnSync('osascript', ['-e', 'clipboard info']);
      const checkOut =
        check.stdout !== undefined ? check.stdout.toString() : '';
      if (!checkOut.includes('«class PNGf»') && !checkOut.includes('picture')) {
        return null; // No image in clipboard
      }

      // Extract PNG image
      const script = `write (the clipboard as «class PNGf») to (open for access POSIX file "${destPath}" with write permission)`;
      const res = spawnSync('osascript', ['-e', script]);
      if (
        res.status === 0 &&
        fs.existsSync(destPath) &&
        fs.statSync(destPath).size > 0
      ) {
        return destPath;
      }
    } else if (process.platform === 'win32') {
      const psScript = `
        Add-Type -AssemblyName System.Windows.Forms;
        if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
          $img = [System.Windows.Forms.Clipboard]::GetImage();
          $img.Save('${destPath.replaceAll('\\', String.raw`\\`)}', [System.Drawing.Imaging.ImageFormat]::Png);
        }
      `;
      const res = spawnSync('powershell', ['-Command', psScript]);
      if (
        res.status === 0 &&
        fs.existsSync(destPath) &&
        fs.statSync(destPath).size > 0
      ) {
        return destPath;
      }
    } else if (process.platform === 'linux') {
      // Check for xclip
      const resXclip = spawnSync('xclip', [
        '-selection',
        'clipboard',
        '-t',
        'image/png',
        '-o',
      ]);
      if (
        resXclip.status === 0 &&
        resXclip.stdout !== undefined &&
        resXclip.stdout.length > 0
      ) {
        fs.writeFileSync(destPath, resXclip.stdout);
        return destPath;
      }
      // Check for wl-paste
      const resWl = spawnSync('wl-paste', ['-t', 'image/png']);
      if (
        resWl.status === 0 &&
        resWl.stdout !== undefined &&
        resWl.stdout.length > 0
      ) {
        fs.writeFileSync(destPath, resWl.stdout);
        return destPath;
      }
    }
  } catch {}

  return null;
}
