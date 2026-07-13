import {
  VectorDb,
  chunkText,
  fetchEmbeddings,
  rerankChunks,
} from './vector-db';
import { loadCredentials } from '../auth/credentials';
import { WorkspaceGuard } from '../sandbox/workspace';
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
          file.name === '.lavalamp' ||
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
  private readonly guard: WorkspaceGuard;

  constructor(private readonly workspaceRoot: string) {
    this.guard = new WorkspaceGuard(workspaceRoot);
    this.db = new VectorDb(workspaceRoot);
  }

  async startIndexing(): Promise<void> {
    if (this.indexingPromise) {
      return this.indexingPromise;
    }
    this.indexingPromise = this.runIndex()
      .catch((error: unknown) => {
        console.error('[lavalamp] Indexing error:', error);
      })
      .finally(() => {
        this.indexingPromise = null;
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

      const queryVector = vectors[0];
      if (queryVector === undefined) {
        return 'Failed to embed query.';
      }

      const candidateLimit = Math.min(Math.max(limit * 4, 20), 40);
      const candidates = this.db.search(queryVector, candidateLimit);
      let matches = candidates.slice(0, limit);
      try {
        matches = await rerankChunks(
          query,
          candidates,
          creds.accountId,
          creds.apiToken,
          limit,
        );
      } catch {
        // Vector similarity remains a safe fallback if reranking is unavailable.
      }
      if (matches.length === 0) {
        return 'No matching semantic chunks found.';
      }

      return matches
        .map(
          (m, i) =>
            `### Match ${i + 1} (${m.filePath} - ${m.relevance === undefined ? 'similarity' : 'rerank relevance'}: ${((m.relevance ?? m.similarity) * 100).toFixed(1)}%)\n\n${m.content}`,
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
      if (!this.guard.isAccessible(file)) {
        continue;
      }
      const fullPath = this.guard.constrain(file);
      if (!fs.existsSync(fullPath)) {
        continue;
      }

      const content = fs.readFileSync(fullPath, 'utf8');
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      const chunks = chunkText(content);

      const existingHash = this.db.getFileHash(file);
      if (
        existingHash === hash &&
        this.db.getFileChunkCount(file) === chunks.length
      ) {
        continue;
      } // Up to date

      // Hash changed or file is new - remove old chunks and re-index
      if (chunks.length === 0) {
        this.db.deleteFile(file);
        continue;
      }

      try {
        const batchSize = 16;
        let dimensions: number | undefined;
        const embeddedChunks: Array<{
          content: string;
          embedding: number[];
        }> = [];
        for (let i = 0; i < chunks.length; i += batchSize) {
          const batch = chunks.slice(i, i + batchSize);
          const vectors = await fetchEmbeddings(
            batch,
            creds.accountId,
            creds.apiToken,
          );
          const expectedDimensions = dimensions ?? vectors[0]?.length;
          if (
            vectors.length !== batch.length ||
            expectedDimensions === undefined ||
            vectors.some(
              (vector) =>
                !Array.isArray(vector) ||
                vector.length === 0 ||
                vector.some((value) => !Number.isFinite(value)) ||
                vector.length !== expectedDimensions,
            )
          ) {
            throw new Error(
              'Embedding response did not contain one valid vector per chunk',
            );
          }
          dimensions = expectedDimensions;
          for (let j = 0; j < batch.length; j++) {
            const content = batch[j];
            const vector = vectors[j];
            if (content === undefined || vector === undefined)
              throw new Error('Invalid embedding batch');
            embeddedChunks.push({ content, embedding: vector });
          }
        }
        this.db.replaceFileChunks(file, existingHash, hash, embeddedChunks);
      } catch (error) {
        console.error(`[lavalamp] Failed to index ${file}:`, error);
      }
    }
  }
}
