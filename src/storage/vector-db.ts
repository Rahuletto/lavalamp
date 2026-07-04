import { Database } from 'bun:sqlite';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { workspaceDataDir } from './paths';

export interface ChunkResult {
  filePath: string;
  content: string;
  similarity: number;
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
    this.initSchema();
  }

  private initSchema() {
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
  }

  getFileHash(filePath: string): string | null {
    const row = this.db
      .prepare('SELECT hash FROM files WHERE path = ?')
      .get(filePath) as { hash: string } | undefined;
    return row ? row.hash : null;
  }

  upsertFile(filePath: string, hash: string) {
    this.db
      .prepare('INSERT OR REPLACE INTO files (path, hash) VALUES (?, ?)')
      .run(filePath, hash);
  }

  deleteFile(filePath: string) {
    this.db.prepare('DELETE FROM chunks WHERE file_path = ?').run(filePath);
    this.db.prepare('DELETE FROM files WHERE path = ?').run(filePath);
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
      .prepare('SELECT file_path, content, embedding FROM chunks')
      .all() as {
      file_path: string;
      content: string;
      embedding: Buffer;
    }[];

    const results: ChunkResult[] = [];
    for (const row of rows) {
      const buffer = row.embedding;
      const fVec = new Float32Array(
        buffer.buffer,
        buffer.byteOffset,
        buffer.byteLength / 4,
      );
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
