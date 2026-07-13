import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WorkspaceGuard } from '../sandbox/workspace';
import {
  type GraphFileCache,
  type GraphReference,
  type GraphSymbol,
  VectorDb,
} from './vector-db';

const SOURCE = /\.(?:ts|tsx|js|jsx|py|go|rs|java|cs|c|cc|cpp|cxx|h|hpp)$/i;
const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_BYTES = 96 * 1024 * 1024;
const MAX_SYMBOLS = 100_000;
const MAX_DEPENDENCIES = 100_000;
const MAX_REFERENCES = 200_000;
const MAX_REFERENCE_CHECKS = 2_000_000;
const MAX_VISITED = 100_000;
const MAX_CACHE_PAYLOAD_BYTES = 4 * 1024 * 1024;
const GRAPH_FORMAT = '3';
const IGNORED = new Set([
  'node_modules',
  '.git',
  '.agents',
  '.lavalamp',
  'dist',
  'build',
]);

interface ScanState {
  files: string[];
  visited: number;
  incomplete: boolean;
  failed: boolean;
}

function scan(
  root: string,
  dir = root,
  state: ScanState = {
    files: [],
    visited: 0,
    incomplete: false,
    failed: false,
  },
): ScanState {
  if (state.files.length >= MAX_FILES || state.visited >= MAX_VISITED) {
    state.incomplete = true;
    return state;
  }
  try {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      state.visited++;
      if (state.files.length >= MAX_FILES || state.visited >= MAX_VISITED) {
        state.incomplete = true;
        break;
      }
      if (entry.isDirectory() && !IGNORED.has(entry.name)) {
        scan(root, path.join(dir, entry.name), state);
      } else if (entry.isFile() && SOURCE.test(entry.name)) {
        state.files.push(path.relative(root, path.join(dir, entry.name)));
      }
    }
  } catch {
    state.failed = true;
  }
  return state;
}

function extractSymbols(filePath: string, text: string): GraphSymbol[] {
  const ext = path.extname(filePath).toLowerCase();
  const patterns: Array<[string, RegExp]> = [];
  if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
    patterns.push(
      ['class', /^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/],
      [
        'function',
        /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/,
      ],
      [
        'function',
        /^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?\([^)]*\)\s*=>/,
      ],
      ['interface', /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/],
      ['type', /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/],
    );
  } else if (ext === '.py') {
    patterns.push(
      ['class', /^\s*class\s+([A-Za-z_]\w*)/],
      ['function', /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/],
    );
  } else if (ext === '.go') {
    patterns.push(
      ['type', /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/],
      ['function', /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/],
    );
  } else if (ext === '.rs') {
    patterns.push(
      ['type', /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/],
      [
        'function',
        /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*\(/,
      ],
    );
  } else {
    patterns.push(
      [
        'type',
        /^\s*(?:public\s+|private\s+|protected\s+|internal\s+)?(?:class|interface|struct|enum)\s+([A-Za-z_]\w*)/,
      ],
      [
        'function',
        /^\s*(?:public\s+|private\s+|protected\s+|static\s+|virtual\s+|inline\s+)*[\w:<>,*&\[\]?]+\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:\{|$)/,
      ],
    );
  }
  const result: GraphSymbol[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (ext === '.py' && /^\s/.test(line)) return;
    for (const [kind, regex] of patterns) {
      const match = regex.exec(line);
      if (match?.[1]) {
        result.push({
          filePath,
          name: match[1],
          kind,
          startLine: index + 1,
          signature: line.trim().slice(0, 300),
        });
        break;
      }
    }
  });
  return result;
}

interface ParsedImport {
  specifier: string;
  line: number;
  bindings: Array<{ local: string; imported: string }>;
}

function parsedImports(filePath: string, text: string): ParsedImport[] {
  const ext = path.extname(filePath).toLowerCase();
  const result: ParsedImport[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
      const match = /^\s*import\s+(.+?)\s+from\s+['"]([^'"]+)['"]/.exec(line);
      if (!match?.[1] || !match[2] || !match[2].startsWith('.')) {
        continue;
      }
      const bindings: ParsedImport['bindings'] = [];
      const clause = match[1].trim();
      const defaultName = /^([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause)?.[1];
      if (defaultName) {
        bindings.push({ local: defaultName, imported: 'default' });
      }
      const named = /\{([^}]+)\}/.exec(clause)?.[1];
      for (const item of named?.split(',') ?? []) {
        const binding =
          /^\s*([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(
            item,
          );
        if (binding?.[1]) {
          bindings.push({
            imported: binding[1],
            local: binding[2] ?? binding[1],
          });
        }
      }
      result.push({ specifier: match[2], line: index + 1, bindings });
    } else if (ext === '.py') {
      const match = /^\s*from\s+(\.+[\w.]*)\s+import\s+(.+?)(?:\s*#.*)?$/.exec(
        line,
      );
      if (!match?.[1] || !match[2]) {
        continue;
      }
      const bindings: ParsedImport['bindings'] = [];
      for (const item of match[2].split(',')) {
        const binding =
          /^\s*([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?\s*$/.exec(item);
        if (binding?.[1]) {
          bindings.push({
            imported: binding[1],
            local: binding[2] ?? binding[1],
          });
        }
      }
      result.push({ specifier: match[1], line: index + 1, bindings });
    } else if (['.c', '.cc', '.cpp', '.cxx', '.h', '.hpp'].includes(ext)) {
      const match = /^\s*#include\s*"([^"]+)"/.exec(line);
      if (match?.[1]) {
        result.push({ specifier: match[1], line: index + 1, bindings: [] });
      }
    } else if (ext === '.rs') {
      const mod = /^\s*(?:pub\s+)?mod\s+([A-Za-z_]\w*)\s*;/.exec(line);
      const specifier = mod?.[1];
      if (specifier) {
        result.push({ specifier, line: index + 1, bindings: [] });
      }
    }
  }
  return result;
}

function resolveDependency(
  source: string,
  specifier: string,
  files: Set<string>,
): string | undefined {
  const ext = path.extname(source).toLowerCase();
  let base: string;
  if (ext === '.py') {
    const dots = /^\.+/.exec(specifier)?.[0].length ?? 0;
    if (dots === 0) {
      return undefined;
    }
    let parent = path.dirname(source);
    for (let index = 1; index < dots; index++) {
      parent = path.dirname(parent);
    }
    base = path.join(parent, specifier.slice(dots).replaceAll('.', path.sep));
  } else if (ext === '.rs') {
    base = path.join(path.dirname(source), specifier);
  } else {
    if (
      ['.ts', '.tsx', '.js', '.jsx'].includes(ext) &&
      !specifier.startsWith('.')
    ) {
      return undefined;
    }
    base = path.normalize(path.join(path.dirname(source), specifier));
  }
  let candidates: string[];
  if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
    candidates = [
      base,
      ...['.ts', '.tsx', '.js', '.jsx'].map((e) => base + e),
      ...['index.ts', 'index.tsx', 'index.js', 'index.jsx'].map((n) =>
        path.join(base, n),
      ),
    ];
  } else if (ext === '.py') {
    candidates = [base + '.py', path.join(base, '__init__.py')];
  } else if (ext === '.rs') {
    candidates = [base + '.rs', path.join(base, 'mod.rs')];
  } else if (['.c', '.cc', '.cpp', '.cxx', '.h', '.hpp'].includes(ext)) {
    candidates = [base];
  } else {
    return undefined;
  }
  return candidates.find((candidate) => files.has(candidate));
}

function maskTsJs(text: string): string {
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' =
    'code';
  let escaped = false;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? '';
    const next = text[i + 1] ?? '';
    if (state === 'code' && c === '/' && next === '/') {
      state = 'line';
      out += '  ';
      i++;
      continue;
    }
    if (state === 'code' && c === '/' && next === '*') {
      state = 'block';
      out += '  ';
      i++;
      continue;
    }
    if (state === 'code' && (c === "'" || c === '"' || c === '`')) {
      state = c === "'" ? 'single' : c === '"' ? 'double' : 'template';
      out += ' ';
      continue;
    }
    if (state === 'line' && c === '\n') {
      state = 'code';
      out += '\n';
      continue;
    }
    if (state === 'block' && c === '*' && next === '/') {
      out += '  ';
      i++;
      state = 'code';
      continue;
    }
    if (
      (state === 'single' || state === 'double' || state === 'template') &&
      !escaped &&
      ((state === 'single' && c === "'") ||
        (state === 'double' && c === '"') ||
        (state === 'template' && c === '`'))
    ) {
      state = 'code';
      out += ' ';
      continue;
    }
    if (state !== 'code') {
      escaped = !escaped && c === '\\';
      out += c === '\n' ? '\n' : ' ';
    } else out += c;
  }
  return out;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface ParsedPayload {
  symbols: GraphSymbol[];
  imports: ParsedImport[];
  usages: Array<{ importIndex: number; bindingIndex: number; lines: number[] }>;
  referenceChecks: number;
  incomplete: boolean;
}

function parsePayload(filePath: string, text: string): ParsedPayload {
  const imports = parsedImports(filePath, text);
  const ext = path.extname(filePath).toLowerCase();
  const masked = ['.ts', '.tsx', '.js', '.jsx'].includes(ext)
    ? maskTsJs(text)
    : text;
  const lines = masked.split(/\r?\n/);
  const usages: ParsedPayload['usages'] = [];
  let referenceChecks = 0;
  let incomplete = false;
  outer: for (
    let importIndex = 0;
    importIndex < imports.length;
    importIndex++
  ) {
    const imported = imports[importIndex];
    if (!imported) continue;
    for (
      let bindingIndex = 0;
      bindingIndex < imported.bindings.length;
      bindingIndex++
    ) {
      const binding = imported.bindings[bindingIndex];
      if (!binding) continue;
      const local = escapeRegex(binding.local);
      const shadow = new RegExp(
        [
          `\\b(?:const|let|var|function|class|catch)\\s*(?:\\([^)]*)?\\b${local}\\b`,
          `\\([^)]*\\b${local}\\b[^)]*\\)\\s*(?:=>|\\{)`,
          `\\b${local}\\s*=>`,
          `\\b(?:const|let|var)\\s*\\{[^}]*\\b${local}\\b\\s*(?:[,}=])`,
          `\\b(?:const|let|var)\\s*\\[[^\]]*\\b${local}\\b`,
        ].join('|'),
      );
      let shadowed = false;
      for (let index = 0; index < lines.length; index++) {
        if (index + 1 === imported.line) continue;
        if (++referenceChecks >= MAX_REFERENCE_CHECKS) {
          incomplete = true;
          break outer;
        }
        if (shadow.test(lines[index] ?? '')) {
          shadowed = true;
          break;
        }
      }
      if (shadowed) continue;
      const usage = new RegExp(`(^|[^.\\w$])${local}\\b`);
      const propertyKey = new RegExp(`\\b${local}\\s*:`);
      const usageLines: number[] = [];
      for (let index = 0; index < lines.length; index++) {
        if (++referenceChecks >= MAX_REFERENCE_CHECKS) {
          incomplete = true;
          break outer;
        }
        if (index + 1 === imported.line) continue;
        const code = lines[index] ?? '';
        if (usage.test(code) && !propertyKey.test(code))
          usageLines.push(index + 1);
      }
      usages.push({ importIndex, bindingIndex, lines: usageLines });
    }
  }
  return {
    symbols: extractSymbols(filePath, text),
    imports,
    usages,
    referenceChecks,
    incomplete,
  };
}

function decodePayload(record: GraphFileCache): ParsedPayload | undefined {
  try {
    if (record.payload.length > MAX_FILE_BYTES * 4) return undefined;
    const decoded: unknown = JSON.parse(record.payload);
    if (typeof decoded !== 'object' || decoded === null) return undefined;
    const value = decoded as ParsedPayload;
    const symbolsValid = value.symbols?.every(
      (symbol) =>
        symbol.filePath === record.path &&
        typeof symbol.name === 'string' &&
        typeof symbol.kind === 'string' &&
        Number.isSafeInteger(symbol.startLine),
    );
    const importsValid = value.imports?.every(
      (imported) =>
        typeof imported.specifier === 'string' &&
        Number.isSafeInteger(imported.line) &&
        Array.isArray(imported.bindings) &&
        imported.bindings.every(
          (binding) =>
            typeof binding.local === 'string' &&
            typeof binding.imported === 'string',
        ),
    );
    const usagesValid = value.usages?.every(
      (usage) =>
        Number.isSafeInteger(usage.importIndex) &&
        Number.isSafeInteger(usage.bindingIndex) &&
        Array.isArray(usage.lines) &&
        usage.lines.every((line) => Number.isSafeInteger(line) && line > 0),
    );
    if (
      !Array.isArray(value.symbols) ||
      !Array.isArray(value.imports) ||
      !Array.isArray(value.usages) ||
      !symbolsValid ||
      !importsValid ||
      !usagesValid ||
      !Number.isSafeInteger(value.referenceChecks) ||
      value.referenceChecks < 0 ||
      typeof value.incomplete !== 'boolean'
    )
      return undefined;
    return value;
  } catch {
    return undefined;
  }
}

export class GraphIndexer {
  private readonly db: VectorDb;
  private readonly guard: WorkspaceGuard;
  private manifest: string | undefined;
  private incomplete = false;
  private stale = false;
  lastIndexStats = { parsedFiles: 0, reusedFiles: 0 };
  constructor(private readonly workspaceRoot: string) {
    this.db = new VectorDb(workspaceRoot);
    this.guard = new WorkspaceGuard(workspaceRoot);
  }

  close(): void {
    this.db.close();
  }

  index(): void {
    const candidates: Array<{
      path: string;
      size: number;
      mtimeMs: number;
      ctimeMs: number;
    }> = [];
    let totalBytes = 0;
    const scanned = scan(this.workspaceRoot);
    if (scanned.failed) {
      this.stale = true;
      return;
    }
    let incomplete = scanned.incomplete;
    const scannedFiles = scanned.files.sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    for (const file of scannedFiles) {
      if (!this.guard.isAccessible(file)) {
        continue;
      }
      try {
        const stat = fs.statSync(this.guard.constrain(file));
        if (
          stat.size > MAX_FILE_BYTES ||
          totalBytes + stat.size > MAX_SOURCE_BYTES
        ) {
          incomplete = true;
          continue;
        }
        totalBytes += stat.size;
        candidates.push({
          path: file,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
        });
      } catch {
        this.stale = true;
        return;
      }
    }
    const manifest = JSON.stringify(candidates);
    if (manifest === this.manifest) return;
    const cached = new Map(
      this.db.getGraphFileCache().map((record) => [record.path, record]),
    );
    const records: Array<GraphFileCache & { parsed: ParsedPayload }> = [];
    let parsedFiles = 0;
    let reusedFiles = 0;
    for (const candidate of candidates) {
      const prior = cached.get(candidate.path);
      if (
        prior?.format === GRAPH_FORMAT &&
        prior.size === candidate.size &&
        prior.mtimeMs === candidate.mtimeMs &&
        prior.ctimeMs === candidate.ctimeMs
      ) {
        const parsed = decodePayload(prior);
        if (parsed) {
          records.push({ ...prior, parsed });
          reusedFiles++;
          continue;
        }
      }
      try {
        const text = fs.readFileSync(
          this.guard.constrain(candidate.path),
          'utf8',
        );
        const parsed = parsePayload(candidate.path, text);
        let payload = JSON.stringify(parsed);
        if (payload.length > MAX_CACHE_PAYLOAD_BYTES) {
          parsed.incomplete = true;
          payload = '';
        }
        records.push({
          ...candidate,
          hash: crypto.createHash('sha256').update(text).digest('hex'),
          format: GRAPH_FORMAT,
          payload,
          parsed,
        });
        parsedFiles++;
      } catch {
        this.stale = true;
        return;
      }
    }
    this.lastIndexStats = { parsedFiles, reusedFiles };
    const fingerprint = crypto
      .createHash('sha256')
      .update(`${incomplete ? 'incomplete' : 'complete'}\0`)
      .update(
        records
          .map(
            (r) =>
              `${r.path}\0${r.hash}\0${r.size}\0${r.mtimeMs}\0${r.ctimeMs}`,
          )
          .join('\0'),
      )
      .digest('hex');
    const previous = this.db.getGraphSnapshotMeta();
    if (
      previous.format === GRAPH_FORMAT &&
      previous.fingerprint === fingerprint
    ) {
      this.manifest = manifest;
      this.incomplete = previous.incomplete;
      this.stale = false;
      return;
    }
    const fileSet = new Set(records.map((r) => r.path));
    const symbols: GraphSymbol[] = [];
    for (const record of records) {
      const remaining = MAX_SYMBOLS - symbols.length;
      if (remaining <= 0) {
        incomplete = true;
        break;
      }
      const extracted = record.parsed.symbols;
      symbols.push(...extracted.slice(0, remaining));
      if (extracted.length > remaining) {
        incomplete = true;
      }
    }
    const imports = new Map<
      string,
      Array<ParsedImport & { targetFile: string }>
    >();
    const dependencies: Array<{
      sourceFile: string;
      targetFile: string;
      line: number;
    }> = [];
    dependencyScan: for (const record of records) {
      for (const imported of record.parsed.imports) {
        if (dependencies.length >= MAX_DEPENDENCIES) {
          incomplete = true;
          break dependencyScan;
        }
        const targetFile = resolveDependency(
          record.path,
          imported.specifier,
          fileSet,
        );
        if (targetFile) {
          const entries = imports.get(record.path) ?? [];
          entries.push({ ...imported, targetFile });
          imports.set(record.path, entries);
          dependencies.push({
            sourceFile: record.path,
            targetFile,
            line: imported.line,
          });
        }
      }
    }
    const symbolsByFile = new Map<string, Map<string, GraphSymbol>>();
    for (const symbol of symbols) {
      const ext = path.extname(symbol.filePath).toLowerCase();
      if (
        ['.ts', '.tsx', '.js', '.jsx'].includes(ext) &&
        !/^export\s/.test(symbol.signature ?? '')
      )
        continue;
      const byName = symbolsByFile.get(symbol.filePath) ?? new Map();
      byName.set(symbol.name, symbol);
      if (/^export\s+default\b/.test(symbol.signature ?? '')) {
        byName.set('default', symbol);
      }
      symbolsByFile.set(symbol.filePath, byName);
    }
    const references: GraphReference[] = [];
    let referenceChecks = 0;
    referenceScan: for (const record of records) {
      referenceChecks += record.parsed.referenceChecks;
      if (referenceChecks >= MAX_REFERENCE_CHECKS || record.parsed.incomplete) {
        incomplete = true;
        break;
      }
      for (const usage of record.parsed.usages) {
        const rawImport = record.parsed.imports[usage.importIndex];
        const binding = rawImport?.bindings[usage.bindingIndex];
        if (!rawImport || !binding) continue;
        const imported = (imports.get(record.path) ?? []).find(
          (entry) =>
            entry.line === rawImport.line &&
            entry.specifier === rawImport.specifier,
        );
        if (!imported) continue;
        const target = symbolsByFile
          .get(imported.targetFile)
          ?.get(binding.imported);
        if (!target) {
          continue;
        }
        for (const line of usage.lines) {
          if (references.length >= MAX_REFERENCES) {
            incomplete = true;
            break referenceScan;
          }
          references.push({
            sourceFile: record.path,
            targetName: target.name,
            line,
          });
        }
      }
    }
    try {
      this.db.replaceGraph(
        records.map(({ parsed: _parsed, ...record }) => record),
        symbols,
        dependencies,
        references,
        { format: GRAPH_FORMAT, fingerprint, incomplete },
        previous,
      );
      const committed = this.db.getGraphSnapshotMeta();
      this.incomplete = committed.incomplete;
      this.stale =
        committed.format !== GRAPH_FORMAT ||
        committed.fingerprint !== fingerprint;
      if (!this.stale) this.manifest = manifest;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/SQLITE_BUSY|database is locked/i.test(message)) {
        throw error;
      }
      this.stale = true;
      // A reader can safely continue using the previous committed WAL snapshot.
    }
  }

  query(query: string, limit = 20, depth = 1): string {
    this.index();
    let fileQuery = path.normalize(query.replaceAll('/', path.sep));
    if (fileQuery.startsWith(`.${path.sep}`)) {
      fileQuery = fileQuery.slice(2);
    }
    const result = this.db.queryGraph(
      query,
      Math.max(1, Math.min(limit, 50)),
      fileQuery,
    );
    if (!result.fileFound && !result.symbols.length) {
      const warning = this.stale
        ? ' [Graph snapshot is stale.]'
        : this.incomplete
          ? ' [Index is incomplete due to resource limits.]'
          : '';
      return `No graph entry found for ${query}.${warning}`;
    }
    const lines = [`# Graph: ${query}`];
    if (this.incomplete) {
      lines.push(
        '[Index limits reached; results cover only the bounded source set.]',
      );
    }
    if (this.stale)
      lines.push(
        '[Graph snapshot is stale; the latest rebuild could not be committed.]',
      );
    if (result.fileFound) {
      lines.push(`File: ${fileQuery}`);
    }
    if (result.symbols.length) {
      lines.push(
        'Definitions:',
        ...result.symbols.map(
          (s) =>
            `- ${s.kind} ${s.name} — ${s.filePath}:${s.startLine}${s.signature ? ` — ${s.signature}` : ''}`,
        ),
      );
    }
    if (depth <= 0) {
      return lines.join('\n');
    }
    const outgoing = result.dependencies.filter(
      (d) =>
        d.sourceFile === fileQuery ||
        result.symbols.some((s) => s.filePath === d.sourceFile),
    );
    const incoming = result.dependencies.filter((d) => !outgoing.includes(d));
    if (outgoing.length) {
      lines.push(
        'Dependencies:',
        ...outgoing.map(
          (d) => `- ${d.sourceFile}:${d.line} -> ${d.targetFile}`,
        ),
      );
    }
    if (incoming.length) {
      lines.push(
        'Reverse dependencies:',
        ...incoming.map(
          (d) => `- ${d.sourceFile}:${d.line} -> ${d.targetFile}`,
        ),
      );
    }
    if (result.references.length) {
      lines.push(
        'References:',
        ...result.references.map(
          (r) =>
            `- ${r.sourceFile}:${r.line} -> ${r.symbol.name} (${r.symbol.filePath}:${r.symbol.startLine})`,
        ),
      );
    }
    return lines.join('\n');
  }
}
