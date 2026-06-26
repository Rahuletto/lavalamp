import { spawn, ChildProcess } from 'child_process';
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

export class LspClient {
  private child: ChildProcess | null = null;
  private idCounter = 0;
  private pending = new Map<number, (res: any) => void>();
  private buffer = '';

  constructor(private workspaceRoot: string, private command: string, private args: string[]) {}

  async start(): Promise<void> {
    if (this.child) return;

    this.child = spawn(this.command, this.args, {
      cwd: this.workspaceRoot,
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    this.child.stdout?.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      this.processBuffer();
    });

    // Send initialize request
    await this.request('initialize', {
      processId: process.pid,
      rootUri: `file://${this.workspaceRoot}`,
      capabilities: {},
    });

    await this.request('initialized', {});
  }

  private processBuffer() {
    while (true) {
      const match = this.buffer.match(/^Content-Length: (\d+)\r\n\r\n/i);
      if (!match) break;

      const headerLength = match[0].length;
      const contentLength = parseInt(match[1], 10);

      if (this.buffer.length < headerLength + contentLength) break;

      const body = this.buffer.slice(headerLength, headerLength + contentLength);
      this.buffer = this.buffer.slice(headerLength + contentLength);

      try {
        const message = JSON.parse(body);
        if (message.id !== undefined) {
          const callback = this.pending.get(message.id);
          if (callback) {
            this.pending.delete(message.id);
            callback(message);
          }
        }
      } catch {}
    }
  }

  request(method: string, params: any): Promise<any> {
    return new Promise((resolve) => {
      const id = ++this.idCounter;
      this.pending.set(id, resolve);

      const payload = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params,
      });

      const header = `Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n`;
      this.child?.stdin?.write(header + payload);
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
  filePath: v.string(),
  line: v.number(),
  character: v.number(),
});

export function createLspTools(workspaceRoot: string) {
  const tsserver = new LspClient(workspaceRoot, 'typescript-language-server', ['--stdio']);

  const hoverTool = defineTool({
    name: 'lsp_hover',
    description: 'Query types and hover information at a specific file coordinate via LSP.',
    parameters: lspHoverSchema,
    execute: async (args) => {
      try {
        await tsserver.start();
        const res = await tsserver.request('textDocument/hover', {
          textDocument: { uri: `file://${workspaceRoot}/${args.filePath}` },
          position: { line: args.line - 1, character: args.character },
        });
        if (res.error) return `LSP Error: ${res.error.message}`;
        if (!res.result || !res.result.contents) return 'No hover information found.';
        return typeof res.result.contents === 'string'
          ? res.result.contents
          : JSON.stringify(res.result.contents);
      } catch (err: any) {
        return `LSP hover failed: ${err.message}`;
      }
    },
  });

  const definitionTool = defineTool({
    name: 'lsp_definition',
    description: 'Find definitions of a symbol at a specific coordinate.',
    parameters: lspHoverSchema,
    execute: async (args) => {
      try {
        await tsserver.start();
        const res = await tsserver.request('textDocument/definition', {
          textDocument: { uri: `file://${workspaceRoot}/${args.filePath}` },
          position: { line: args.line - 1, character: args.character },
        });
        if (res.error) return `LSP Error: ${res.error.message}`;
        if (!res.result || (Array.isArray(res.result) && res.result.length === 0)) {
          return 'No definition location found.';
        }
        return JSON.stringify(res.result, null, 2);
      } catch (err: any) {
        return `LSP definition failed: ${err.message}`;
      }
    },
  });

  return [hoverTool, definitionTool];
}
