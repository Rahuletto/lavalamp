import { Database } from 'bun:sqlite';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { workspaceDataDir } from './paths';

export interface ChunkResult {
  filePath: string;
  content: string;
  similarity: number;
}

export interface GraphSymbol {
  id?: number;
  filePath: string;
  name: string;
  kind: string;
  startLine: number;
  endLine?: number;
  signature?: string;
}

export interface GraphReference {
  sourceFile: string;
  targetName: string;
  line: number;
}

export interface GraphSnapshotMeta {
  format: string | null;
  fingerprint: string | null;
  incomplete: boolean;
}

export class VectorDb {
  private readonly db: Database;

  constructor(workspaceRoot: string) {
    const dir = path.join(workspaceDataDir(workspaceRoot), 'semantic-index');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const dbPath = path.join(dir, 'vector-db.db');
    this.db = new Database(dbPath);
    this.db.run('PRAGMA busy_timeout = 5000');
    this.db.run('PRAGMA journal_mode = WAL');
    this.initSchema();
  }

  private initSchema() {
    this.db.run('PRAGMA foreign_keys = ON');
    this.db.run(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL
      );
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        embedding BLOB NOT NULL,
        FOREIGN KEY (file_path) REFERENCES files(path) ON DELETE CASCADE
      );
    `);
    this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_path);`,
    );
    this.db.run(
      `CREATE TABLE IF NOT EXISTS graph_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    );
    this.db.run(
      `CREATE TABLE IF NOT EXISTS graph_files (path TEXT PRIMARY KEY, hash TEXT NOT NULL)`,
    );
    this.db.run(`CREATE TABLE IF NOT EXISTS graph_symbols (
      id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT NOT NULL, name TEXT NOT NULL,
      kind TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER, signature TEXT,
      FOREIGN KEY (file_path) REFERENCES graph_files(path) ON DELETE CASCADE)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS graph_dependencies (
      source_file TEXT NOT NULL, target_file TEXT NOT NULL, line INTEGER NOT NULL,
      PRIMARY KEY (source_file, target_file, line),
      FOREIGN KEY (source_file) REFERENCES graph_files(path) ON DELETE CASCADE,
      FOREIGN KEY (target_file) REFERENCES graph_files(path) ON DELETE CASCADE)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS graph_references (
      source_file TEXT NOT NULL, target_symbol_id INTEGER NOT NULL, line INTEGER NOT NULL,
      PRIMARY KEY (source_file, target_symbol_id, line),
      FOREIGN KEY (source_file) REFERENCES graph_files(path) ON DELETE CASCADE,
      FOREIGN KEY (target_symbol_id) REFERENCES graph_symbols(id) ON DELETE CASCADE)`);
    this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_graph_symbol_name ON graph_symbols(name)`,
    );
    this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_graph_dep_target ON graph_dependencies(target_file)`,
    );
    this.db.run(
      `CREATE INDEX IF NOT EXISTS idx_graph_ref_target ON graph_references(target_symbol_id)`,
    );
    this.db
      .prepare(
        `INSERT OR IGNORE INTO graph_meta (key, value) VALUES ('schema_version', '1')`,
      )
      .run();
  }

  replaceGraph(
    files: { path: string; hash: string }[],
    symbols: GraphSymbol[],
    dependencies: { sourceFile: string; targetFile: string; line: number }[],
    references: GraphReference[],
    metadata: { format: string; fingerprint: string; incomplete: boolean },
    expected: GraphSnapshotMeta,
  ): boolean {
    let replaced = false;
    const replace = this.db.transaction(() => {
      const current = this.getGraphSnapshotMeta();
      if (
        (current.format === metadata.format &&
          current.fingerprint === metadata.fingerprint) ||
        current.format !== expected.format ||
        current.fingerprint !== expected.fingerprint
      ) {
        return;
      }
      this.db.run('DELETE FROM graph_references');
      this.db.run('DELETE FROM graph_dependencies');
      this.db.run('DELETE FROM graph_symbols');
      this.db.run('DELETE FROM graph_files');
      const fileStmt = this.db.prepare(
        'INSERT INTO graph_files (path, hash) VALUES (?, ?)',
      );
      const symbolStmt = this.db.prepare(
        `INSERT INTO graph_symbols (file_path,name,kind,start_line,end_line,signature) VALUES (?,?,?,?,?,?)`,
      );
      const depStmt = this.db.prepare(
        'INSERT OR IGNORE INTO graph_dependencies (source_file,target_file,line) VALUES (?,?,?)',
      );
      const refStmt = this.db.prepare(
        'INSERT OR IGNORE INTO graph_references (source_file,target_symbol_id,line) VALUES (?,?,?)',
      );
      for (const file of files) {
        fileStmt.run(file.path, file.hash);
      }
      for (const symbol of symbols) {
        const result = symbolStmt.run(
          symbol.filePath,
          symbol.name,
          symbol.kind,
          symbol.startLine,
          symbol.endLine ?? null,
          symbol.signature ?? null,
        );
        symbol.id = Number(result.lastInsertRowid);
      }
      for (const edge of dependencies) {
        depStmt.run(edge.sourceFile, edge.targetFile, edge.line);
      }
      const uniqueSymbols = new Map<string, GraphSymbol>();
      const duplicateNames = new Set<string>();
      for (const symbol of symbols) {
        if (uniqueSymbols.has(symbol.name)) {
          duplicateNames.add(symbol.name);
        } else {
          uniqueSymbols.set(symbol.name, symbol);
        }
      }
      for (const edge of references) {
        const target = duplicateNames.has(edge.targetName)
          ? undefined
          : uniqueSymbols.get(edge.targetName);
        if (target?.id !== undefined) {
          refStmt.run(edge.sourceFile, target.id, edge.line);
        }
      }
      const metaStmt = this.db.prepare(
        `INSERT INTO graph_meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      );
      metaStmt.run('format_version', metadata.format);
      metaStmt.run('content_fingerprint', metadata.fingerprint);
      metaStmt.run('incomplete', metadata.incomplete ? '1' : '0');
      replaced = true;
    });
    replace.immediate();
    return replaced;
  }

  getGraphSnapshotMeta(): GraphSnapshotMeta {
    const rows = this.db
      .prepare(
        `SELECT key,value FROM graph_meta WHERE key IN ('format_version','content_fingerprint','incomplete')`,
      )
      .all() as Array<{ key: string; value: string }>;
    const values = new Map(rows.map((row) => [row.key, row.value]));
    return {
      format: values.get('format_version') ?? null,
      fingerprint: values.get('content_fingerprint') ?? null,
      incomplete: values.get('incomplete') === '1',
    };
  }

  queryGraph(
    query: string,
    limit: number,
    fileQuery = query,
  ): {
    fileFound: boolean;
    symbols: GraphSymbol[];
    dependencies: { sourceFile: string; targetFile: string; line: number }[];
    references: { sourceFile: string; line: number; symbol: GraphSymbol }[];
  } {
    const symbols = this.db
      .prepare(
        `SELECT id, file_path filePath, name, kind, start_line startLine, end_line endLine, signature FROM graph_symbols WHERE name = ? OR file_path = ? ORDER BY file_path,start_line LIMIT ?`,
      )
      .all(query, fileQuery, limit) as GraphSymbol[];
    const files = new Set(symbols.map((s) => s.filePath));
    const fileFound = Boolean(
      this.db
        .prepare('SELECT 1 FROM graph_files WHERE path = ?')
        .get(fileQuery),
    );
    if (fileFound) files.add(fileQuery);
    const dependencies: {
      sourceFile: string;
      targetFile: string;
      line: number;
    }[] = [];
    for (const file of files)
      dependencies.push(
        ...(this.db
          .prepare(
            `SELECT source_file sourceFile,target_file targetFile,line FROM graph_dependencies WHERE source_file = ? OR target_file = ? ORDER BY source_file,line LIMIT ?`,
          )
          .all(file, file, limit) as typeof dependencies),
      );
    const references: {
      sourceFile: string;
      line: number;
      symbol: GraphSymbol;
    }[] = [];
    for (const symbol of symbols) {
      if (symbol.id === undefined) continue;
      const rows = this.db
        .prepare(
          `SELECT r.source_file sourceFile,r.line,s.id,s.file_path filePath,s.name,s.kind,s.start_line startLine,s.end_line endLine,s.signature FROM graph_references r JOIN graph_symbols s ON s.id=r.target_symbol_id WHERE r.target_symbol_id=? ORDER BY r.source_file,r.line LIMIT ?`,
        )
        .all(symbol.id, limit) as Array<
        { sourceFile: string; line: number } & GraphSymbol
      >;
      references.push(
        ...rows.map((r) => ({
          sourceFile: r.sourceFile,
          line: r.line,
          symbol: r,
        })),
      );
    }
    return { fileFound, symbols, dependencies, references };
  }

  getFileHash(filePath: string): string | null {
    const row = this.db
      .prepare('SELECT hash FROM files WHERE path = ?')
      .get(filePath) as { hash: string } | undefined;
    return row ? row.hash : null;
  }

  getFileChunkCount(filePath: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) count FROM chunks WHERE file_path = ?')
      .get(filePath) as { count: number };
    return row.count;
  }

  upsertFile(filePath: string, hash: string) {
    this.db
      .prepare(
        'INSERT INTO files (path, hash) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET hash=excluded.hash',
      )
      .run(filePath, hash);
  }

  deleteFile(filePath: string) {
    this.db.prepare('DELETE FROM chunks WHERE file_path = ?').run(filePath);
    this.db.prepare('DELETE FROM files WHERE path = ?').run(filePath);
  }

  deleteChunks(filePath: string) {
    this.db.prepare('DELETE FROM chunks WHERE file_path = ?').run(filePath);
  }

  replaceFileChunks(
    filePath: string,
    expectedHash: string | null,
    hash: string,
    chunks: Array<{ content: string; embedding: number[] }>,
  ): boolean {
    let replaced = false;
    const replace = this.db.transaction(() => {
      const currentHash = this.getFileHash(filePath);
      if (
        currentHash === hash &&
        this.getFileChunkCount(filePath) === chunks.length
      ) {
        replaced = true;
        return;
      }
      if (currentHash !== expectedHash) {
        return;
      }
      this.upsertFile(filePath, hash);
      this.deleteChunks(filePath);
      for (let index = 0; index < chunks.length; index++) {
        const chunk = chunks[index];
        if (chunk) {
          this.insertChunk(filePath, index, chunk.content, chunk.embedding);
        }
      }
      replaced = true;
    });
    replace.immediate();
    return replaced;
  }

  insertChunk(
    filePath: string,
    chunkIndex: number,
    content: string,
    embedding: number[],
  ) {
    const floatArray = new Float32Array(embedding);
    const buffer = Buffer.from(floatArray.buffer);
    this.db
      .prepare(`
      INSERT INTO chunks (file_path, chunk_index, content, embedding)
      VALUES (?, ?, ?, ?)
    `)
      .run(filePath, chunkIndex, content, buffer);
  }

  search(queryVector: number[], limit = 5): ChunkResult[] {
    const qVec = new Float32Array(queryVector);
    const rows = this.db
      .prepare(
        `SELECT c.file_path, c.content, c.embedding
         FROM chunks c JOIN files f ON f.path = c.file_path
         WHERE f.hash NOT LIKE 'pending:%'`,
      )
      .all() as {
      file_path: string;
      content: string;
      embedding: Buffer;
    }[];

    const results: ChunkResult[] = [];
    for (const row of rows) {
      const buffer = row.embedding;
      const arrayBuffer = buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      );
      const fVec = new Float32Array(arrayBuffer);
      if (fVec.length !== qVec.length) {
        continue;
      }

      // Calculate dot product (assuming vectors are normalized by API)
      let dot = 0;
      let lenQ = 0;
      let lenF = 0;
      for (let i = 0; i < qVec.length; i++) {
        const q = qVec[i] ?? 0;
        const f = fVec[i] ?? 0;
        dot += q * f;
        lenQ += q * q;
        lenF += f * f;
      }
      const similarity = dot / (Math.sqrt(lenQ) * Math.sqrt(lenF) || 1);
      results.push({
        content: row.content,
        filePath: row.file_path,
        similarity,
      });
    }

    return results
      .toSorted((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  close() {
    this.db.close();
  }
}

// Simple sliding-window chunking
export function chunkText(
  text: string,
  chunkSize = 1000,
  overlap = 200,
): string[] {
  const words = text.split(/\s+/);
  const chunks: string[] = [];
  let i = 0;
  while (i < words.length) {
    const chunkWords = words.slice(i, i + chunkSize);
    chunks.push(chunkWords.join(' '));
    i += chunkSize - overlap;
    if (chunkWords.length < chunkSize) {
      break;
    }
  }
  return chunks;
}

export async function fetchEmbeddings(
  texts: string[],
  accountId: string,
  apiToken: string,
): Promise<number[][]> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/run/@cf/baai/bge-large-en-v1.5`;
  const response = await fetch(url, {
    body: JSON.stringify({ text: texts }),
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    method: 'POST',
  });

  if (!response.ok) {
    throw new Error(
      `Cloudflare AI Embeddings API error: ${response.statusText}`,
    );
  }

  const result = (await response.json()) as {
    success: boolean;
    result: { data: number[][] };
    errors: unknown[];
  };
  if (!result.success) {
    throw new Error(
      `Cloudflare AI Embeddings failed: ${JSON.stringify(result.errors)}`,
    );
  }

  return result.result.data;
}
