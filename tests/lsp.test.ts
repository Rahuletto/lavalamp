import { describe, test, expect } from 'bun:test';
import { getSharedLspClients, getDiagnosticsForFile, createLspTools } from '../src/tools/lsp-client';
import * as path from 'node:path';

describe('LSP Tools & Diagnostics integration', () => {
  const workspaceRoot = path.resolve('.');

  test('getSharedLspClients returns initialized instances', () => {
    const { guard, tsserver } = getSharedLspClients(workspaceRoot);
    expect(guard).toBeDefined();
    expect(tsserver).toBeDefined();
  });

  test('createLspTools returns 6 tools', () => {
    const tools = createLspTools(workspaceRoot);
    expect(tools.length).toBe(6);
    const names = tools.map((t) => t.name);
    expect(names).toContain('lsp_hover');
    expect(names).toContain('lsp_definition');
    expect(names).toContain('lsp_references');
    expect(names).toContain('lsp_rename');
    expect(names).toContain('lsp_diagnostics');
    expect(names).toContain('lsp_oxc_diagnostics');
  });

  test('getDiagnosticsForFile ignores non-code files', async () => {
    const reports = await getDiagnosticsForFile(workspaceRoot, 'README.md');
    expect(reports).toEqual([]);
  });

  test('getDiagnosticsForFile handles JS/TS files gracefully', async () => {
    // Should run without crashing even if server isn't installed
    const reports = await getDiagnosticsForFile(workspaceRoot, 'src/run.ts');
    expect(Array.isArray(reports)).toBe(true);
  });
});
