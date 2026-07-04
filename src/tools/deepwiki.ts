import * as v from 'valibot';
import { defineTool } from '@flue/runtime';

const MCP_URL = 'https://mcp.deepwiki.com/mcp';

interface McpRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface McpResponse {
  error?: { message?: string } | null;
  result?: unknown;
}

let requestId = 0;

async function mcpCall(
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const body: McpRequest = {
    id: ++requestId,
    jsonrpc: '2.0',
    method,
    params,
  };

  const resp = await fetch(MCP_URL, {
    body: JSON.stringify(body),
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    method: 'POST',
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`MCP error (${resp.status}): ${text.slice(0, 200)}`);
  }

  const contentType = resp.headers.get('content-type') ?? '';

  if (contentType.includes('text/event-stream')) {
    const text = await resp.text();
    return parseSseResponse(text);
  }

  const data = (await resp.json()) as McpResponse;
  if (data.error !== null && data.error !== undefined) {
    throw new Error(
      `MCP error: ${data.error.message ?? JSON.stringify(data.error)}`,
    );
  }
  return data.result;
}

function parseSseResponse(text: string): unknown {
  const dataLines: string[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }

  for (let i = dataLines.length - 1; i >= 0; i--) {
    const line = dataLines[i];
    if (line === undefined) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as McpResponse;
      if (parsed.result !== undefined) {
        return parsed.result;
      }
      if (parsed.error !== null && parsed.error !== undefined) {
        const errObj = parsed.error as Record<string, unknown>;
        throw new Error(
          typeof errObj.message === 'string'
            ? errObj.message
            : JSON.stringify(errObj),
        );
      }
    } catch {}
  }

  throw new Error('No valid response in SSE stream');
}

let initialized = false;

async function ensureInit(): Promise<void> {
  if (initialized) {
    return;
  }
  await mcpCall('initialize', {
    capabilities: {},
    clientInfo: { name: 'lavalamp', version: '0.1.0' },
    protocolVersion: '2025-03-26',
  });
  await mcpCall('notifications/initialized');
  initialized = true;
}

const deepwikiSchema = v.object({
  question: v.optional(v.string()),
  repo: v.string(),
  topic: v.optional(v.string()),
});

export function createDeepWikiTool() {
  return defineTool({
    description:
      'Query repository documentation from DeepWiki via MCP. Use read_wiki_structure to list topics, read_wiki_contents to read a specific topic, or ask_question to ask anything about a repo. Only works for repos indexed on deepwiki.com.',
    execute: async (args) => {
      await ensureInit();

      const repo = args.repo.trim().replace(/^https?:\/\/github\.com\//, '');

      if (args.question !== null && args.question !== undefined) {
        const result = await mcpCall('tools/call', {
          arguments: { question: args.question, repo },
          name: 'ask_question',
        });
        return extractText(result);
      }

      if (args.topic !== null && args.topic !== undefined) {
        const result = await mcpCall('tools/call', {
          arguments: { repo, topic: args.topic },
          name: 'read_wiki_contents',
        });
        return extractText(result);
      }

      const result = await mcpCall('tools/call', {
        arguments: { repo },
        name: 'read_wiki_structure',
      });
      return extractText(result);
    },
    name: 'deepwiki',
    parameters: deepwikiSchema,
  });
}

function extractText(result: unknown): string {
  if (result === null || result === undefined) {
    return '';
  }
  if (typeof result !== 'object') {
    if (typeof result === 'string') {
      return result;
    }
    if (typeof result === 'number' || typeof result === 'boolean') {
      return String(result);
    }
    return '';
  }
  const r = result as Record<string, unknown>;

  if (Array.isArray(r.content)) {
    return r.content
      .filter((c: Record<string, unknown>) => c.type === 'text')
      .map((c: Record<string, unknown>) => c.text)
      .join('\n');
  }

  if (typeof r.text === 'string') {
    return r.text;
  }
  if (typeof r === 'string') {
    return r;
  }
  return JSON.stringify(r, null, 2);
}
