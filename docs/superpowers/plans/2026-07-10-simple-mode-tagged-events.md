# Simple Mode Tagged Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose reasoning, tool calls, and tool results as tagged blocks in `--simple` output.

**Architecture:** Add a pure event formatter owning tag state and serialization. Feed simple-mode REPL events through it while preserving existing text and non-simple behavior.

**Tech Stack:** TypeScript, Bun test runner, Node streams

## Global Constraints

- Only `--simple` text output changes.
- JSON output and other UI modes remain unchanged.
- Bash stream output remains suppressed in simple mode.

---

### Task 1: Tagged event formatter

**Files:**
- Create: `src/run/simple-event-stream.ts`
- Test: `tests/simple-event-stream.test.ts`

**Interfaces:**
- Consumes: `FlueEvent`
- Produces: `createSimpleEventStream(write): { handle(event): void; finish(): void }`

- [ ] Write tests asserting reasoning coalescing/closure, XML attribute escaping, JSON tool payloads, result metadata, and `finish()` cleanup.
- [ ] Run `bun test tests/simple-event-stream.test.ts` and confirm failure from missing module.
- [ ] Implement minimal stateful formatter and safe serializers.
- [ ] Run `bun test tests/simple-event-stream.test.ts` and confirm pass.

### Task 2: Headless REPL integration

**Files:**
- Modify: `src/run/headless-repl.ts`

**Interfaces:**
- Consumes: formatter from Task 1
- Produces: tagged stdout only when `simpleMode === true` and `outputFormat === 'text'`

- [ ] Route simple-mode events through formatter; preserve existing event handling for other modes.
- [ ] Close open reasoning blocks on results and errors.
- [ ] Run focused tests, `bun run typecheck`, then `bun test`.
