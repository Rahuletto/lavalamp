import type { FlueEvent } from '../tui/ipc';

export interface SimpleEventStream {
  handle(event: FlueEvent): void;
  finish(): void;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function serialize(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

function escapeContent(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function attribute(name: string, value: unknown): string {
  return value === undefined
    ? ''
    : ` ${name}="${escapeAttribute(String(value))}"`;
}

export function createSimpleEventStream(
  write: (chunk: string) => void,
): SimpleEventStream {
  let reasoningOpen = false;

  const closeReasoning = () => {
    if (!reasoningOpen) {
      return;
    }
    write('\n</reasoning>\n');
    reasoningOpen = false;
  };

  return {
    handle(event) {
      if (event.type === 'thinking_delta') {
        if (!reasoningOpen) {
          write('<reasoning>\n');
          reasoningOpen = true;
        }
        write(escapeContent(event.delta ?? event.content ?? ''));
        return;
      }

      closeReasoning();

      if (event.type === 'text_delta') {
        write(event.text ?? event.delta ?? '');
        return;
      }

      if (event.type === 'tool_start') {
        const attrs =
          attribute('name', event.toolName ?? 'unknown') +
          attribute('id', event.toolCallId);
        write(
          `<toolcall${attrs}>${escapeContent(serialize(event.args ?? {}))}</toolcall>\n`,
        );
        return;
      }

      if (event.type === 'tool') {
        const attrs =
          attribute('name', event.toolName ?? 'unknown') +
          attribute('id', event.toolCallId) +
          attribute('error', event.isError ?? false) +
          attribute('duration_ms', event.durationMs);
        write(
          `<toolresult${attrs}>${escapeContent(serialize(event.result))}</toolresult>\n`,
        );
      }
    },
    finish: closeReasoning,
  };
}
