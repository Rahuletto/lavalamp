import type { ToolDefinition } from '@flue/runtime';

export const DEFAULT_TOOL_RESULT_CHARS = 32_000;

export function truncateToolResult(
  text: string,
  maxChars = DEFAULT_TOOL_RESULT_CHARS,
): string {
  if (text.length <= maxChars) {
    return text;
  }

  const marker = `\n\n[Tool result truncated: ${text.length - maxChars} characters omitted. Refine the query or request a smaller range.]\n\n`;
  const available = Math.max(0, maxChars - marker.length);
  const headLength = Math.ceil(available * 0.75);
  const tailLength = available - headLength;
  return `${text.slice(0, headLength)}${marker}${tailLength > 0 ? text.slice(-tailLength) : ''}`;
}

export function withResultBudget(
  tool: ToolDefinition,
  maxChars = DEFAULT_TOOL_RESULT_CHARS,
): ToolDefinition {
  const execute = tool.execute;
  if (typeof execute !== 'function') {
    return tool;
  }

  return {
    ...tool,
    execute: (async (args: Record<string, unknown>) => {
      const result = await (execute as (
        values: Record<string, unknown>,
      ) => Promise<unknown>)(args);
      return typeof result === 'string'
        ? truncateToolResult(result, maxChars)
        : result;
    }) as ToolDefinition['execute'],
  };
}
