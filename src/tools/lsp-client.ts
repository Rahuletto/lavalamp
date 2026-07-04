import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { pathToFileURL } from 'node:url';
import { WorkspaceGuard } from '../sandbox/workspace';

export class LspClient {
  private child: ChildProcess | null = null;
  private idCounter = 0;
  private readonly pending = new Map<
    number,
    {
      reject: (err: Error) => void;
      resolve: (res: Record<string, unknown>) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private buffer = '';

  constructor(
    private readonly workspaceRoot: string,
    private readonly command: string,
    private readonly args: string[],
  ) {}

  async start(): Promise<void> {
    if (this.child) {
      return;
    }

    this.child = spawn(this.command, this.args, {
      cwd: this.workspaceRoot,
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    if (this.child.stdout) {
      this.child.stdout.on('data', (chunk: Buffer) => {
        this.buffer += chunk.toString('utf8');
        this.processBuffer();
      });
    }
    this.child.once('exit', () => {
      this.rejectPending(new Error('LSP server exited'));
    });

    // Send initialize request
    await this.request('initialize', {
      capabilities: {},
      processId: process.pid,
      rootUri: pathToFileURL(this.workspaceRoot).href,
    });

    await this.request('initialized', {});
  }

  private processBuffer() {
    while (true) {
      const match = /^Content-Length: (\d+)\r\n\r\n/i.exec(this.buffer);
      if (!match) {
        break;
      }

      const headerLength = match[0].length;
      const rawLength = match[1];
      if (rawLength === undefined) {
        break;
      }
      const contentLength = Number.parseInt(rawLength, 10);

      if (this.buffer.length < headerLength + contentLength) {
        break;
      }

      const body = this.buffer.slice(
        headerLength,
        headerLength + contentLength,
      );
      this.buffer = this.buffer.slice(headerLength + contentLength);

      try {
        const message = JSON.parse(body);
        if (message.id !== undefined) {
          const id = Number(message.id);
          const pending = this.pending.get(id);
          if (pending) {
            this.pending.delete(id);
            clearTimeout(pending.timer);
            pending.resolve(message as Record<string, unknown>);
          }
        }
      } catch {}
    }
  }

  async request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (this.child === null || this.child.stdin === null) {
        reject(new Error('LSP server is not running'));
        return;
      }

      const id = ++this.idCounter;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request timed out: ${method}`));
      }, 15_000);
      this.pending.set(id, { reject, resolve, timer });

      const payload = JSON.stringify({
        id,
        jsonrpc: '2.0',
        method,
        params,
      });

      const header = `Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n`;
      this.child.stdin.write(header + payload);
    });
  }

  shutdown() {
    if (this.child) {
      this.rejectPending(new Error('LSP server stopped'));
      this.child.kill();
      this.child = null;
    }
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

// Define schemas and tools
const lspHoverSchema = v.object({
  character: v.number(),
  filePath: v.string(),
  line: v.number(),
});

export function createLspTools(workspaceRoot: string) {
  const guard = new WorkspaceGuard(workspaceRoot);
  const tsserver = new LspClient(guard.root, 'typescript-language-server', [
    '--stdio',
  ]);

  function uriFor(filePath: string): string {
    return pathToFileURL(guard.constrain(filePath)).href;
  }

  const hoverTool = defineTool({
    description:
      'Query types and hover information at a specific file coordinate via LSP.',
    execute: async (args) => {
      try {
        await tsserver.start();
        const res = await tsserver.request('textDocument/hover', {
          position: { character: args.character, line: args.line - 1 },
          textDocument: { uri: uriFor(args.filePath) },
        });
        if (res.error !== null && res.error !== undefined) {
          return `LSP Error: ${(res.error as { message?: string }).message}`;
        }
        if (
          res.result === null ||
          res.result === undefined ||
          (Array.isArray(res.result) && res.result.length === 0) ||
          (typeof res.result === 'object' &&
            res.result !== null &&
            !('contents' in res.result))
        ) {
          return 'No hover information found.';
        }
        const contents =
          typeof res.result === 'object' &&
          res.result !== null &&
          'contents' in res.result
            ? (res.result as Record<string, unknown>).contents
            : undefined;
        if (contents === null || contents === undefined) {
          return 'No hover information found.';
        }
        return typeof contents === 'string'
          ? contents
          : JSON.stringify(contents);
      } catch (error: unknown) {
        return `LSP hover failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    name: 'lsp_hover',
    parameters: lspHoverSchema,
  });

  const definitionTool = defineTool({
    description: 'Find definitions of a symbol at a specific coordinate.',
    execute: async (args) => {
      try {
        await tsserver.start();
        const res = await tsserver.request('textDocument/definition', {
          position: { character: args.character, line: args.line - 1 },
          textDocument: { uri: uriFor(args.filePath) },
        });
        if (res.error !== null && res.error !== undefined) {
          return `LSP Error: ${(res.error as { message?: string }).message}`;
        }
        if (
          res.result === null ||
          res.result === undefined ||
          (Array.isArray(res.result) && res.result.length === 0)
        ) {
          return 'No definition location found.';
        }
        return JSON.stringify(res.result, null, 2);
      } catch (error: unknown) {
        return `LSP definition failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    name: 'lsp_definition',
    parameters: lspHoverSchema,
  });

  return [hoverTool, definitionTool];
}
