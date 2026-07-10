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
  private readonly diagnostics = new Map<string, unknown[]>();
  onDiagnostics?: (uri: string, diagnostics: unknown[]) => void;

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
      capabilities: {
        textDocument: {
          synchronization: {
            didSave: true,
          },
        },
      },
      processId: process.pid,
      rootUri: pathToFileURL(this.workspaceRoot).href,
    });

    await this.notify('initialized', {});
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
        // Handle notifications (no id)
        if (message.id === undefined && message.method !== undefined) {
          if (message.method === 'textDocument/publishDiagnostics') {
            const uri = message.params?.uri;
            const diags = message.params?.diagnostics ?? [];
            if (typeof uri === 'string') {
              this.diagnostics.set(uri, diags as unknown[]);
              if (this.onDiagnostics) {
                this.onDiagnostics(uri, diags as unknown[]);
              }
            }
          }
          continue;
        }
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

  async notify(
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    if (this.child === null || this.child.stdin === null) {
      return;
    }
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
    });
    const header = `Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n`;
    this.child.stdin.write(header + payload);
  }

  getDiagnostics(uri: string): unknown[] {
    return this.diagnostics.get(uri) ?? [];
  }

  clearDiagnostics(uri: string): void {
    this.diagnostics.delete(uri);
  }

  shutdown() {
    if (this.child) {
      this.rejectPending(new Error('LSP server stopped'));
      this.child.kill();
      this.child = null;
    }
  }

  private rejectPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

// --- Schemas ---

const lspPositionSchema = v.object({
  character: v.number(),
  filePath: v.string(),
  line: v.number(),
});

const lspRenameSchema = v.object({
  character: v.number(),
  filePath: v.string(),
  line: v.number(),
  newName: v.string(),
});

const lspFileSchema = v.object({
  filePath: v.string(),
});

const lspDiagnosticsSchema = v.object({
  filePath: v.optional(v.string()),
});

// --- Formatting helpers ---

interface LspLocation {
  uri: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

function formatLocation(loc: LspLocation, workspaceRoot: string): string {
  const filePath = loc.uri.startsWith('file://')
    ? decodeURIComponent(loc.uri.slice(7))
    : loc.uri;
  const rel = filePath.startsWith(workspaceRoot)
    ? filePath.slice(workspaceRoot.length + 1)
    : filePath;
  const start = loc.range.start;
  return `${rel}:${start.line + 1}:${start.character + 1}`;
}

interface LspDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity?: number;
  message: string;
  source?: string;
  code?: number | string;
}

const SEVERITY_LABELS: Record<number, string> = {
  1: 'Error',
  2: 'Warning',
  3: 'Info',
  4: 'Hint',
};

function formatDiagnostic(
  diag: LspDiagnostic,
  workspaceRoot: string,
  uri: string,
): string {
  const filePath = uri.startsWith('file://')
    ? decodeURIComponent(uri.slice(7))
    : uri;
  const rel = filePath.startsWith(workspaceRoot)
    ? filePath.slice(workspaceRoot.length + 1)
    : filePath;
  const severity = SEVERITY_LABELS[diag.severity ?? 1] ?? 'Error';
  const source = diag.source ? ` [${diag.source}]` : '';
  const code = diag.code !== undefined ? ` (${diag.code})` : '';
  const start = diag.range.start;
  return `${rel}:${start.line + 1}:${start.character + 1} ${severity}${source}${code}: ${diag.message}`;
}

// --- Tool factory ---

export function createLspTools(workspaceRoot: string) {
  const guard = new WorkspaceGuard(workspaceRoot);
  const tsserver = new LspClient(guard.root, 'typescript-language-server', [
    '--stdio',
  ]);

  function uriFor(filePath: string): string {
    return pathToFileURL(guard.constrain(filePath)).href;
  }

  function ensureStarted(): Promise<void> {
    return tsserver.start();
  }

  const hoverTool = defineTool({
    description:
      'Query types and hover information at a specific file coordinate via LSP.',
    execute: async (args) => {
      try {
        await ensureStarted();
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
    parameters: lspPositionSchema,
  });

  const definitionTool = defineTool({
    description: 'Find definitions of a symbol at a specific coordinate.',
    execute: async (args) => {
      try {
        await ensureStarted();
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
    parameters: lspPositionSchema,
  });

  const referencesTool = defineTool({
    description:
      'Find all references to a symbol at a specific file coordinate. Returns a list of locations (file:line:character) where the symbol is used.',
    execute: async (args) => {
      try {
        await ensureStarted();
        const res = await tsserver.request('textDocument/references', {
          context: { includeDeclaration: true },
          position: { character: args.character, line: args.line - 1 },
          textDocument: { uri: uriFor(args.filePath) },
        });
        if (res.error !== null && res.error !== undefined) {
          return `LSP Error: ${(res.error as { message?: string }).message}`;
        }
        const result = res.result;
        if (
          result === null ||
          result === undefined ||
          (Array.isArray(result) && result.length === 0)
        ) {
          return 'No references found.';
        }
        const locations = Array.isArray(result)
          ? (result as LspLocation[])
          : [result as LspLocation];
        const lines = locations.map((loc) =>
          formatLocation(loc, workspaceRoot),
        );
        return `Found ${locations.length} reference(s):\n${lines.join('\n')}`;
      } catch (error: unknown) {
        return `LSP references failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    name: 'lsp_references',
    parameters: lspPositionSchema,
  });

  const renameTool = defineTool({
    description:
      'Rename a symbol at a specific file coordinate. Returns a list of all file edits that would be applied. The edits are NOT automatically applied — use the `edit` or `write` tool to apply them. Use this to plan a safe rename before executing.',
    execute: async (args) => {
      try {
        await ensureStarted();
        const res = await tsserver.request('textDocument/rename', {
          newName: args.newName,
          position: { character: args.character, line: args.line - 1 },
          textDocument: { uri: uriFor(args.filePath) },
        });
        if (res.error !== null && res.error !== undefined) {
          return `LSP Error: ${(res.error as { message?: string }).message}`;
        }
        const result = res.result as
          | { changes?: Record<string, unknown[]> }
          | null;
        if (
          result === null ||
          result === undefined ||
          !result.changes ||
          Object.keys(result.changes).length === 0
        ) {
          return `No rename edits produced. The symbol may not be renamable, or the position may not point to a valid symbol.`;
        }
        const parts: string[] = [];
        let totalEdits = 0;
        for (const [uri, edits] of Object.entries(result.changes)) {
          const filePath = uri.startsWith('file://')
            ? decodeURIComponent(uri.slice(7))
            : uri;
          const rel = filePath.startsWith(workspaceRoot)
            ? filePath.slice(workspaceRoot.length + 1)
            : filePath;
          const editList = edits as {
            range: {
              start: { line: number; character: number };
              end: { line: number; character: number };
            };
            newText: string;
          }[];
          totalEdits += editList.length;
          parts.push(`\n${rel} (${editList.length} edit(s)):`);
          for (const edit of editList) {
            const start = edit.range.start;
            const end = edit.range.end;
            parts.push(
              `  L${start.line + 1}:${start.character + 1} → L${end.line + 1}:${end.character + 1}: "${edit.newText.trim()}"`,
            );
          }
        }
        return `Rename to "${args.newName}" — ${totalEdits} edit(s) across ${Object.keys(result.changes).length} file(s):${parts.join('\n')}\n\nUse the edit/write tools to apply these changes.`;
      } catch (error: unknown) {
        return `LSP rename failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    name: 'lsp_rename',
    parameters: lspRenameSchema,
  });

  const diagnosticsTool = defineTool({
    description:
      'Get diagnostics (errors, warnings) for a specific file or the entire workspace. Uses the TypeScript language server. If filePath is omitted, returns all cached diagnostics across the workspace.',
    execute: async (args) => {
      try {
        await ensureStarted();
        if (args.filePath !== undefined && args.filePath.length > 0) {
          const uri = uriFor(args.filePath);
          // Trigger a fresh diagnostic pull by opening/saving the document
          await tsserver.notify('textDocument/didSave', {
            textDocument: { uri },
          });
          // Give the server a moment to process
          await new Promise((r) => setTimeout(r, 500));
          const diags = tsserver.getDiagnostics(uri) as LspDiagnostic[];
          if (diags.length === 0) {
            return `No diagnostics for ${args.filePath}.`;
          }
          const lines = diags.map((d) =>
            formatDiagnostic(d, workspaceRoot, uri),
          );
          const errors = diags.filter((d) => (d.severity ?? 1) === 1).length;
          const warnings = diags.filter((d) => d.severity === 2).length;
          return `${diags.length} diagnostic(s) (${errors} error(s), ${warnings} warning(s)):\n${lines.join('\n')}`;
        }
        // All workspace diagnostics
        const allDiags: string[] = [];
        let totalErrors = 0;
        let totalWarnings = 0;
        for (const [uri, diags] of tsserver.diagnosticsMap()) {
          const cast = diags as LspDiagnostic[];
          for (const d of cast) {
            allDiags.push(formatDiagnostic(d, workspaceRoot, uri));
            if ((d.severity ?? 1) === 1) totalErrors++;
            if (d.severity === 2) totalWarnings++;
          }
        }
        if (allDiags.length === 0) {
          return 'No diagnostics in workspace.';
        }
        allDiags.sort();
        return `${allDiags.length} diagnostic(s) (${totalErrors} error(s), ${totalWarnings} warning(s)):\n${allDiags.join('\n')}`;
      } catch (error: unknown) {
        return `LSP diagnostics failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    name: 'lsp_diagnostics',
    parameters: lspDiagnosticsSchema,
  });

  const oxcDiagnosticsTool = defineTool({
    description:
      'Run oxlint on a specific file or the workspace for fast JS/TS lint diagnostics. Oxlint is faster than the TypeScript language server and catches common issues (unused vars, type mismatches, style). Use after edits to get immediate lint feedback.',
    execute: async (args) => {
      try {
        const target =
          args.filePath !== undefined && args.filePath.length > 0
            ? guard.constrain(args.filePath)
            : workspaceRoot;
        const { execFileSync } = await import('node:child_process');
        const result = execFileSync('bunx', ['oxlint', '--format=json', target], {
          cwd: workspaceRoot,
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 30_000,
        });
        // oxlint json output is a JSON array of result objects
        try {
          const parsed = JSON.parse(result) as Array<{
            file: string;
            diagnostics: Array<{
              severity: string;
              message: string;
              line: number;
              column: number;
              endLine?: number;
              endColumn?: number;
              rule?: string;
            }>;
          }>;
          const lines: string[] = [];
          let totalErrors = 0;
          let totalWarnings = 0;
          for (const file of parsed) {
            const filePath = file.file;
            const rel = filePath.startsWith(workspaceRoot)
              ? filePath.slice(workspaceRoot.length + 1)
              : filePath;
            for (const diag of file.diagnostics) {
              const isErr = diag.severity === 'error' || diag.severity === 'Error';
              if (isErr) totalErrors++;
              else totalWarnings++;
              const rule = diag.rule ? ` [${diag.rule}]` : '';
              lines.push(
                `${rel}:${diag.line}:${diag.column} ${isErr ? 'Error' : 'Warning'}${rule}: ${diag.message}`,
              );
            }
          }
          if (lines.length === 0) {
            return `oxlint: no issues found in ${target === workspaceRoot ? 'workspace' : target}.`;
          }
          lines.sort();
          return `oxlint: ${lines.length} issue(s) (${totalErrors} error(s), ${totalWarnings} warning(s)):\n${lines.join('\n')}`;
        } catch {
          // If JSON parse fails, return raw output (may be empty or non-JSON format)
          return result.trim().length > 0
            ? result.trim()
            : 'oxlint: no issues found.';
        }
      } catch (error: unknown) {
        // oxlint returns non-zero exit on findings, but execFileSync throws on non-zero
        if (error instanceof Error && 'stdout' in error) {
          const stdout = (error as { stdout: string }).stdout;
          try {
            const parsed = JSON.parse(stdout) as Array<{
              file: string;
              diagnostics: Array<{
                severity: string;
                message: string;
                line: number;
                column: number;
                rule?: string;
              }>;
            }>;
            const lines: string[] = [];
            let totalErrors = 0;
            let totalWarnings = 0;
            for (const file of parsed) {
              const filePath = file.file;
              const rel = filePath.startsWith(workspaceRoot)
                ? filePath.slice(workspaceRoot.length + 1)
                : filePath;
              for (const diag of file.diagnostics) {
                const isErr = diag.severity === 'error' || diag.severity === 'Error';
                if (isErr) totalErrors++;
                else totalWarnings++;
                const rule = diag.rule ? ` [${diag.rule}]` : '';
                lines.push(
                  `${rel}:${diag.line}:${diag.column} ${isErr ? 'Error' : 'Warning'}${rule}: ${diag.message}`,
                );
              }
            }
            if (lines.length === 0) {
              return `oxlint: no issues found.`;
            }
            lines.sort();
            return `oxlint: ${lines.length} issue(s) (${totalErrors} error(s), ${totalWarnings} warning(s)):\n${lines.join('\n')}`;
          } catch {
            return stdout.trim().length > 0
              ? `oxlint output:\n${stdout.trim()}`
              : `oxlint failed: ${error.message}`;
          }
        }
        return `oxlint failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
    name: 'lsp_oxc_diagnostics',
    parameters: lspDiagnosticsSchema,
  });

  return [
    hoverTool,
    definitionTool,
    referencesTool,
    renameTool,
    diagnosticsTool,
    oxcDiagnosticsTool,
  ];
}
