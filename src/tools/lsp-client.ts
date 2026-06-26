import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

export class LspClient {
  private child: ChildProcess | null = null;
  private idCounter = 0;
  private readonly pending = new Map<number, (res: unknown) => void>();
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

    // Send initialize request
    await this.request('initialize', {
      capabilities: {},
      processId: process.pid,
      rootUri: `file://${this.workspaceRoot}`,
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
      const contentLength = Number.parseInt(match[1], 10);

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
          const callback = this.pending.get(id);
          if (callback) {
            this.pending.delete(id);
            callback(message);
          }
        }
      } catch {}
    }
  }

   async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const id = ++this.idCounter;
      this.pending.set(id, resolve);

      const payload = JSON.stringify({
        id,
        jsonrpc: '2.0',
        method,
        params,
      });

      const header = `Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n`;
      if (this.child !== null && this.child.stdin !== null) {
        this.child.stdin.write(header + payload);
      }
    });
  }

  shutdown() {
    if (this.child) {
      this.child.kill();
      this.child = null;
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
  const tsserver = new LspClient(workspaceRoot, 'typescript-language-server', [
    '--stdio',
  ]);

  const hoverTool = defineTool({
    description:
      'Query types and hover information at a specific file coordinate via LSP.',
    execute: async (args) => {
      try {
        await tsserver.start();
        const res = await tsserver.request('textDocument/hover', {
          position: { character: args.character, line: args.line - 1 },
          textDocument: { uri: `file://${workspaceRoot}/${args.filePath}` },
        });
        if (res.error !== null && res.error !== undefined) {return `LSP Error: ${(res.error as { message?: string }).message}`;}
        if (
          res.result === null ||
          res.result === undefined ||
          (Array.isArray(res.result) && res.result.length === 0) ||
          (typeof res.result === 'object' && res.result !== null && !('contents' in res.result))
        )
          {return 'No hover information found.';}
        const contents = typeof res.result === 'object' && res.result !== null && 'contents' in res.result
          ? (res.result as Record<string, unknown>).contents
          : undefined;
        if (contents === null || contents === undefined) {return 'No hover information found.';}
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
          textDocument: { uri: `file://${workspaceRoot}/${args.filePath}` },
        });
        if (res.error !== null && res.error !== undefined) {return `LSP Error: ${(res.error as { message?: string }).message}`;}
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
