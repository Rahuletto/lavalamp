import { describe, expect, test } from 'bun:test';
import { createSimpleEventStream } from '../src/run/simple-event-stream';

describe('simple event stream', () => {
  test('coalesces reasoning deltas and closes before assistant text', () => {
    let output = '';
    const stream = createSimpleEventStream((chunk) => {
      output += chunk;
    });

    stream.handle({ type: 'thinking_delta', delta: 'inspect ' });
    stream.handle({ type: 'thinking_delta', content: 'files' });
    stream.handle({ type: 'text_delta', text: 'Done.' });

    expect(output).toBe('<reasoning>\ninspect files\n</reasoning>\nDone.');
  });

  test('emits JSON tool calls with escaped attributes', () => {
    let output = '';
    const stream = createSimpleEventStream((chunk) => {
      output += chunk;
    });

    stream.handle({
      type: 'tool_start',
      toolName: 'mcp<&"',
      toolCallId: "call'1",
      args: { path: '/tmp/a', recursive: true },
    });

    expect(output).toBe(
      '<toolcall name="mcp&lt;&amp;&quot;" id="call&apos;1">{"path":"/tmp/a","recursive":true}</toolcall>\n',
    );
  });

  test('emits tool results with lifecycle metadata', () => {
    let output = '';
    const stream = createSimpleEventStream((chunk) => {
      output += chunk;
    });

    stream.handle({
      type: 'tool',
      toolName: 'bash',
      toolCallId: 'call_123',
      result: { output: 'ok' },
      isError: false,
      durationMs: 24,
    });

    expect(output).toBe(
      '<toolresult name="bash" id="call_123" error="false" duration_ms="24">{"output":"ok"}</toolresult>\n',
    );
  });

  test('escapes tag delimiters inside JSON payloads', () => {
    let output = '';
    const stream = createSimpleEventStream((chunk) => {
      output += chunk;
    });

    stream.handle({
      type: 'tool_start',
      toolName: 'write',
      args: { content: '</toolcall>&' },
    });

    expect(output).toBe(
      '<toolcall name="write">{"content":"&lt;/toolcall&gt;&amp;"}</toolcall>\n',
    );
  });

  test('escapes reasoning that resembles a closing tag', () => {
    let output = '';
    const stream = createSimpleEventStream((chunk) => {
      output += chunk;
    });

    stream.handle({ type: 'thinking_delta', delta: '</reasoning>&' });
    stream.finish();

    expect(output).toBe(
      '<reasoning>\n&lt;/reasoning&gt;&amp;\n</reasoning>\n',
    );
  });

  test('closes reasoning on tool transitions and finish', () => {
    let output = '';
    const stream = createSimpleEventStream((chunk) => {
      output += chunk;
    });

    stream.handle({ type: 'thinking_delta', delta: 'first' });
    stream.handle({ type: 'tool_start', toolName: 'read', args: {} });
    stream.handle({ type: 'thinking_delta', delta: 'second' });
    stream.finish();

    expect(output).toBe(
      '<reasoning>\nfirst\n</reasoning>\n<toolcall name="read">{}</toolcall>\n<reasoning>\nsecond\n</reasoning>\n',
    );
  });
});
