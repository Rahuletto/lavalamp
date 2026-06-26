#!/usr/bin/env bun
/**
 * Postinstall script: patches @flue/runtime/node to use bun:sqlite
 * instead of node:sqlite (which Bun doesn't have).
 *
 * Run after every `bun install`:
 *   bun run build/postinstall.ts
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const FLUE_RUNTIME_BASE = join(
  import.meta.dir,
  '..',
  'node_modules',
  '@flue',
  'runtime',
  'dist',
);
const FLUE_CLI_BASE = join(
  import.meta.dir,
  '..',
  'node_modules',
  '@flue',
  'cli',
  'node_modules',
  '@flue',
  'runtime',
  'dist',
);

function patchFile(filePath: string): boolean {
  let code;
  try {
    code = readFileSync(filePath, 'utf8');
  } catch {
    return false;
  }

  if (!code.includes('from "node:sqlite"')) {
    return false;
  }

  const bunShim = `
// --- bun:sqlite shim (patched by postinstall.ts) ---
import { Database as BunDatabase } from "bun:sqlite";
class DatabaseSync {
  #db;
  constructor(filename, opts) {
    this.#db = new BunDatabase(filename === ":memory:" ? ":memory:" : filename);
  }
  exec(sql) { this.#db.exec(sql); }
  prepare(sql) {
    const stmt = this.#db.query(sql);
    return {
      all(...b) { return stmt.all(...b); },
      get(...b) { return stmt.get(...b); },
      run(...b) { stmt.run(...b); },
      iterate(...b) { return stmt.values(...b); },
    };
  }
  close() { this.#db.close(); }
}
// end shim
`;

  code = code.replace(
    /import\s*\{\s*DatabaseSync\s*\}\s*from\s*"node:sqlite"\s*;?/,
    bunShim,
  );

  writeFileSync(filePath, code);
  return true;
}

let patched = 0;

// Patch main runtime
for (const dir of [FLUE_RUNTIME_BASE, FLUE_CLI_BASE]) {
  try {
    const files = readdirSync(join(dir, 'node'), {
      recursive: true,
    }) as string[];
    for (const file of files) {
      if (file.endsWith('.mjs') && patchFile(join(dir, 'node', file))) {
        console.log(
          `[postinstall] Patched: ${join(dir, 'node', file).replace(FLUE_RUNTIME_BASE, '@flue/runtime')}`,
        );
        patched++;
      }
    }
  } catch {}
}

if (patched === 0) {
  console.log('[postinstall] No node:sqlite imports found to patch.');
} else {
  console.log(
    `[postinstall] Patched ${patched} file(s). node:sqlite → bun:sqlite`,
  );
}
