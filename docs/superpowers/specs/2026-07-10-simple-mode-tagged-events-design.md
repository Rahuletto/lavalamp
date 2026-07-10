# Simple Mode Tagged Events Design

`--simple` exposes reasoning and tool lifecycle events as ordered XML-like tagged blocks while leaving assistant text unchanged.

- Consecutive `thinking_delta` events share one `<reasoning>` block. It closes before assistant text, a tool call, a tool result, an error, or turn completion.
- `tool_start` emits `<toolcall name="..." id="...">` containing JSON arguments.
- `tool` emits `<toolresult name="..." id="..." error="..." duration_ms="...">` containing the JSON result. Optional attributes are omitted when unavailable.
- Attribute values use XML escaping. Payloads use JSON serialization, with a string fallback for values JSON cannot represent.
- Bash live chunks stay suppressed in simple mode. The completed result is emitted once through `<toolresult>`.
- JSON output, normal headless REPL, print mode, permissions, and TUI behavior stay unchanged.

Tests cover tag formatting, escaping, streaming reasoning boundaries, tool metadata, and completion cleanup.
