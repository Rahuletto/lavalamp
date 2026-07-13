import { rmSync } from 'node:fs';

export interface FileSnapshot {
  path: string;
  content: Uint8Array | null;
}

export interface ChangeEntry {
  label: string;
  snapshots: FileSnapshot[];
}

export class ChangeTracker {
  readonly #stack: ChangeEntry[] = [];

  async record(label: string, paths: string[]): Promise<void> {
    const snapshots: FileSnapshot[] = [];
    for (const p of paths) {
      const file = Bun.file(p);
      if (await file.exists()) {
        snapshots.push({ content: new Uint8Array(await file.arrayBuffer()), path: p });
      } else {
        snapshots.push({ content: null, path: p });
      }
    }
    this.#stack.push({ label, snapshots });
  }

  async undoLast(): Promise<{ restored: string[]; label: string }> {
    const entry = this.#stack.pop();
    if (!entry) {
      throw new Error('Nothing to undo');
    }

    const restored: string[] = [];
    for (const snap of entry.snapshots) {
      if (snap.content === null) {
        try {
          rmSync(snap.path, { force: true });
        } catch {}
        restored.push(`${snap.path} (deleted — was new file)`);
      } else {
        await Bun.write(snap.path, snap.content);
        restored.push(snap.path);
      }
    }

    return { label: entry.label, restored };
  }

  get history(): string[] {
    return this.#stack.map((e, i) => `${i + 1}. ${e.label}`);
  }

  get size(): number {
    return this.#stack.length;
  }
}
