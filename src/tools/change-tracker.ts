export interface FileSnapshot {
  path: string;
  content: string | null;
}

export interface ChangeEntry {
  label: string;
  snapshots: FileSnapshot[];
}

export class ChangeTracker {
  #stack: ChangeEntry[] = [];

  async record(label: string, paths: string[]): Promise<void> {
    const snapshots: FileSnapshot[] = [];
    for (const p of paths) {
      const file = Bun.file(p);
      if (await file.exists()) {
        snapshots.push({ path: p, content: await file.text() });
      } else {
        snapshots.push({ path: p, content: null });
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
        await Bun.write(snap.path, '');
        restored.push(`${snap.path} (recreated empty — was new file)`);
      } else {
        await Bun.write(snap.path, snap.content);
        restored.push(snap.path);
      }
    }

    return { restored, label: entry.label };
  }

  get history(): string[] {
    return this.#stack.map((e, i) => `${i + 1}. ${e.label}`);
  }

  get size(): number {
    return this.#stack.length;
  }
}
