import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GraphIndexer } from '../src/storage/graph-indexer';
import { rerankChunks, VectorDb } from '../src/storage/vector-db';

describe('offline codebase graph', () => {
  const roots: string[] = [];
  const graphs: GraphIndexer[] = [];
  const databases: VectorDb[] = [];
  const originalLavalampHome = process.env.LAVALAMP_HOME;
  const originalFetch = globalThis.fetch;
  const makeGraph = (root: string) => {
    const graph = new GraphIndexer(root);
    graphs.push(graph);
    return graph;
  };
  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const graph of graphs.splice(0)) graph.close();
    for (const database of databases.splice(0)) database.close();
    for (const root of roots.splice(0))
      fs.rmSync(root, { recursive: true, force: true });
    if (originalLavalampHome === undefined) {
      delete process.env.LAVALAMP_HOME;
    } else {
      process.env.LAVALAMP_HOME = originalLavalampHome;
    }
  });

  test('indexes definitions, imports, reverse edges and references and removes stale files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lavalamp-graph-'));
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'lavalamp-state-'));
    roots.push(root, state);
    process.env.LAVALAMP_HOME = state;
    fs.writeFileSync(
      path.join(root, 'math.ts'),
      'export function double(value: number) {\n  return value * 2;\n}\n',
    );
    fs.writeFileSync(
      path.join(root, 'main.ts'),
      "import { double } from './math';\nexport function run() {\n  return double(21);\n}\n",
    );
    const graph = makeGraph(root);
    const symbol = graph.query('double');
    expect(symbol).toContain('math.ts:1');
    expect(symbol).toContain('main.ts:3 -> double');
    const file = graph.query('math.ts');
    expect(file).toContain('Reverse dependencies:');
    expect(file).toContain('main.ts:1 -> math.ts');
    expect(graph.query('./math.ts')).toContain('File: math.ts');
    fs.rmSync(path.join(root, 'main.ts'));
    const updated = graph.query('math.ts');
    expect(updated).not.toContain('main.ts');
  });

  test('does not create references for ambiguous symbol names', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lavalamp-graph-'));
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'lavalamp-state-'));
    roots.push(root, state);
    process.env.LAVALAMP_HOME = state;
    fs.writeFileSync(path.join(root, 'a.ts'), 'export function shared() {}\n');
    fs.writeFileSync(path.join(root, 'b.ts'), 'export function shared() {}\n');
    fs.writeFileSync(path.join(root, 'consumer.ts'), 'shared();\n');

    const result = makeGraph(root).query('shared');
    expect(result).not.toContain('References:');
  });

  test('only records unshadowed imported bindings as references', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lavalamp-graph-'));
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'lavalamp-state-'));
    roots.push(root, state);
    process.env.LAVALAMP_HOME = state;
    fs.writeFileSync(
      path.join(root, 'target.ts'),
      'export function action() {}\n',
    );
    fs.writeFileSync(
      path.join(root, 'noise.ts'),
      "import { action } from './target';\n// action();\nconst text = 'action()';\nobj.action();\nfunction action() {}\n",
    );

    const result = makeGraph(root).query('action');
    expect(result).not.toContain('References:');
  });

  test('skips bare package dependencies even when a matching local file exists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lavalamp-graph-'));
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'lavalamp-state-'));
    roots.push(root, state);
    process.env.LAVALAMP_HOME = state;
    fs.writeFileSync(
      path.join(root, 'package.ts'),
      'export function external() {}\n',
    );
    fs.writeFileSync(
      path.join(root, 'consumer.ts'),
      "import { external } from 'package';\nexternal();\n",
    );

    const result = makeGraph(root).query('consumer.ts');
    expect(result).not.toContain('Dependencies:');
    expect(makeGraph(root).query('external')).not.toContain('References:');
  });

  test('invalidates the in-process manifest after a modification', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lavalamp-graph-'));
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'lavalamp-state-'));
    roots.push(root, state);
    process.env.LAVALAMP_HOME = state;
    const source = path.join(root, 'value.ts');
    fs.writeFileSync(source, 'export function before() {}\n');
    const graph = makeGraph(root);
    expect(graph.query('before')).toContain('value.ts:1');

    fs.writeFileSync(source, 'export function after() { return 1; }\n');
    const nextMtime = new Date(Date.now() + 1000);
    fs.utimesSync(source, nextMtime, nextMtime);
    expect(graph.query('after')).toContain('value.ts:1');
    expect(graph.query('before')).toContain('No graph entry found');
  });

  test('reuses persisted parses and reparses only changed files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lavalamp-graph-'));
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'lavalamp-state-'));
    roots.push(root, state);
    process.env.LAVALAMP_HOME = state;
    fs.writeFileSync(path.join(root, 'a.ts'), 'export function oldName() {}\n');
    fs.writeFileSync(path.join(root, 'b.ts'), 'export function stable() {}\n');

    const first = makeGraph(root);
    first.query('oldName');
    expect(first.lastIndexStats).toEqual({ parsedFiles: 2, reusedFiles: 0 });

    const second = makeGraph(root);
    second.query('stable');
    expect(second.lastIndexStats).toEqual({ parsedFiles: 0, reusedFiles: 2 });

    fs.writeFileSync(
      path.join(root, 'a.ts'),
      'export function replacementWithLongerName() {}\n',
    );
    second.query('replacementWithLongerName');
    expect(second.lastIndexStats).toEqual({ parsedFiles: 1, reusedFiles: 1 });
    expect(second.query('oldName')).toContain('No graph entry found');
  });

  test('rebuilds cached importer edges when a target appears and removes deleted caches', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lavalamp-graph-'));
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'lavalamp-state-'));
    roots.push(root, state);
    process.env.LAVALAMP_HOME = state;
    fs.writeFileSync(
      path.join(root, 'consumer.ts'),
      "import { later } from './target';\nlater();\n",
    );
    makeGraph(root).query('consumer.ts');

    fs.writeFileSync(
      path.join(root, 'target.ts'),
      'export function later() {}\n',
    );
    const added = makeGraph(root);
    expect(added.query('later')).toContain('consumer.ts:2 -> later');
    expect(added.query('consumer.ts')).toContain('consumer.ts:1 -> target.ts');
    expect(added.lastIndexStats).toEqual({ parsedFiles: 1, reusedFiles: 1 });

    fs.rmSync(path.join(root, 'target.ts'));
    const deleted = makeGraph(root);
    expect(deleted.query('target.ts')).toContain('No graph entry found');
    expect(deleted.lastIndexStats).toEqual({ parsedFiles: 0, reusedFiles: 1 });
    const db = new VectorDb(root);
    databases.push(db);
    expect(db.getGraphFileCache().map((entry) => entry.path)).toEqual([
      'consumer.ts',
    ]);
  });

  test('does not resolve dependencies across language families', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lavalamp-graph-'));
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'lavalamp-state-'));
    roots.push(root, state);
    process.env.LAVALAMP_HOME = state;
    fs.writeFileSync(path.join(root, 'target.py'), 'def value():\n    pass\n');
    fs.writeFileSync(
      path.join(root, 'consumer.ts'),
      "import { value } from './target';\nvalue();\n",
    );
    fs.writeFileSync(path.join(root, 'header.ts'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(root, 'native.c'), '#include "header"\n');
    fs.writeFileSync(path.join(root, 'lib.rs'), 'use crate::target;\n');

    const graph = makeGraph(root);
    expect(graph.query('consumer.ts')).not.toContain('Dependencies:');
    expect(graph.query('native.c')).not.toContain('Dependencies:');
    expect(graph.query('lib.rs')).not.toContain('Dependencies:');
  });

  test('masks multiline comments and templates and drops parameter-shadowed references', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lavalamp-graph-'));
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'lavalamp-state-'));
    roots.push(root, state);
    process.env.LAVALAMP_HOME = state;
    fs.writeFileSync(
      path.join(root, 'target.ts'),
      'export function action() {}\n',
    );
    fs.writeFileSync(
      path.join(root, 'consumer.ts'),
      "import { action } from './target';\n/*\naction();\n*/\nconst text = `\naction();\n`;\nfunction wrapped(action: unknown) { return action; }\naction();\n",
    );

    expect(makeGraph(root).query('action')).not.toContain('References:');
  });

  test('drops arrow, destructuring, and property-key false references', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lavalamp-graph-'));
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'lavalamp-state-'));
    roots.push(root, state);
    process.env.LAVALAMP_HOME = state;
    fs.writeFileSync(
      path.join(root, 'target.ts'),
      'export function action() {}\nexport function label() {}\n',
    );
    fs.writeFileSync(
      path.join(root, 'consumer.ts'),
      "import { action, label } from './target';\nconst fn = action => action;\nconst { action } = source;\nconst value = { label: 1 };\n",
    );

    const graph = makeGraph(root);
    expect(graph.query('action')).not.toContain('References:');
    expect(graph.query('label')).not.toContain('References:');
  });

  test('atomically replaces embedding chunks and rejects a stale writer', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lavalamp-graph-'));
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'lavalamp-state-'));
    roots.push(root, state);
    process.env.LAVALAMP_HOME = state;
    const db = new VectorDb(root);
    const staleWriter = new VectorDb(root);
    databases.push(db, staleWriter);
    db.upsertFile('source.ts', 'old-hash');
    db.insertChunk('source.ts', 0, 'old content', [1, 0]);

    expect(
      db.replaceFileChunks('source.ts', 'old-hash', 'new-hash', [
        { content: 'new content', embedding: [0, 1] },
      ]),
    ).toBe(true);
    expect(
      staleWriter.replaceFileChunks('source.ts', 'old-hash', 'stale-hash', [
        { content: 'stale content', embedding: [1, 0] },
      ]),
    ).toBe(false);

    expect(db.getFileHash('source.ts')).toBe('new-hash');
    expect(db.getFileChunkCount('source.ts')).toBe(1);
    expect(db.search([0, 1])[0]?.content).toBe('new content');
  });

  test('reranks vector candidates with Workers AI scores', async () => {
    let requestBody: unknown;
    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        success: true,
        result: {
          response: [
            { id: 1, score: 0.9 },
            { id: 0, score: 0.4 },
          ],
        },
      });
    }) as typeof fetch;

    const result = await rerankChunks(
      'permission checks',
      [
        { filePath: 'first.ts', content: 'first', similarity: 0.9 },
        { filePath: 'second.ts', content: 'second', similarity: 0.7 },
      ],
      'account',
      'token',
      2,
    );

    expect(result.map((item) => item.filePath)).toEqual([
      'second.ts',
      'first.ts',
    ]);
    expect(requestBody).toEqual({
      query: 'permission checks',
      top_k: 2,
      contexts: [{ text: 'first.ts\nfirst' }, { text: 'second.ts\nsecond' }],
    });
  });
});
