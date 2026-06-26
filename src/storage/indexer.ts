import { VectorDb, chunkText, fetchEmbeddings } from './vector-db';
import { loadCredentials } from '../auth/credentials';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';

function walkFiles(
  dir: string,
  workspaceRoot: string,
  results: string[] = [],
): string[] {
  try {
    const list = fs.readdirSync(dir, { withFileTypes: true });
    for (const file of list) {
      const fullPath = path.join(dir, file.name);
      if (file.isDirectory()) {
        if (
          file.name === 'node_modules' ||
          file.name === '.git' ||
          file.name === '.agents' ||
          file.name === 'dist' ||
          file.name === 'build'
        ) {
          continue;
        }
        walkFiles(fullPath, workspaceRoot, results);
      } else {
        if (
          /\.(ts|js|jsx|tsx|json|md|py|go|rs|cpp|c|h|css|html)$/.test(file.name)
        ) {
          const relative = path.relative(workspaceRoot, fullPath);
          results.push(relative);
        }
      }
    }
  } catch {}
  return results;
}

export class CodebaseIndexer {
  private readonly db: VectorDb;
  private indexingPromise: Promise<void> | null = null;

  constructor(private readonly workspaceRoot: string) {
    this.db = new VectorDb(workspaceRoot);
  }

   async startIndexing(): Promise<void> {
    if (this.indexingPromise) {
      return this.indexingPromise;
    }
    this.indexingPromise = this.runIndex().catch((error: unknown) => {
      console.error('[lavalamp] Indexing error:', error);
    });
    return this.indexingPromise;
  }

  async semanticSearch(query: string, limit = 5): Promise<string> {
    const creds = loadCredentials();
    if (!creds) {
      return 'Codebase search offline (Please run wrangler login or set Cloudflare credentials first).';
    }

    try {
      const vectors = await fetchEmbeddings(
        [query],
        creds.accountId,
        creds.apiToken,
      );
      if (vectors.length === 0) {
        return 'Failed to embed query.';
      }

      const matches = this.db.search(vectors[0], limit);
      if (matches.length === 0) {
        return 'No matching semantic chunks found.';
      }

      return matches
        .map(
          (m, i) =>
            `### Match ${i + 1} (${m.filePath} - similarity: ${(m.similarity * 100).toFixed(1)}%)\n\n${m.content}`,
        )
        .join('\n\n---\n\n');
    } catch (error: unknown) {
      return `Semantic search failed: ${(error as Error).message}`;
    }
  }

  private async runIndex() {
    const creds = loadCredentials();
    if (!creds) {
      return;
    } // Silent if no credentials configured yet

    const filesToSync = walkFiles(this.workspaceRoot, this.workspaceRoot);

    // Process files
    for (const file of filesToSync) {
      const fullPath = path.join(this.workspaceRoot, file);
      if (!fs.existsSync(fullPath)) {
        continue;
      }

      const content = fs.readFileSync(fullPath, 'utf8');
      const hash = crypto.createHash('sha256').update(content).digest('hex');

      const existingHash = this.db.getFileHash(file);
      if (existingHash === hash) {
        continue;
      } // Up to date

      // Hash changed or file is new - remove old chunks and re-index
      this.db.deleteFile(file);

      const chunks = chunkText(content);
      if (chunks.length === 0) {
        continue;
      }

      try {
        const batchSize = 16;
        for (let i = 0; i < chunks.length; i += batchSize) {
          const batch = chunks.slice(i, i + batchSize);
          const vectors = await fetchEmbeddings(
            batch,
            creds.accountId,
            creds.apiToken,
          );
          for (let j = 0; j < batch.length; j++) {
            this.db.insertChunk(file, i + j, batch[j], vectors[j]);
          }
        }
        this.db.upsertFile(file, hash);
      } catch (error) {
        console.error(`[lavalamp] Failed to index ${file}:`, error);
      }
    }
  }

  watchWorkspace() {
    setInterval(() => {
      this.runIndex().catch(() => {});
    }, 60_000);
  }
}
