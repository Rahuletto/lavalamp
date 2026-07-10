# Terminal Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show terminal-native bouncing progress whenever Lavalamp agent work remains active.

**Architecture:** A process-wide OSC 9;4 controller tracks active requests. `FlueProcess.prompt` begins progress and wraps every terminal callback path to release it exactly once.

**Tech Stack:** TypeScript, Bun test runner, OSC 9;4 terminal protocol

## Global Constraints

- Use indeterminate state `3`; no percentages.
- Clear with state `0` after final active request.
- Keep stdout and JSON output clean.

---

### Task 1: OSC progress controller

**Files:**
- Create: `src/run/terminal-progress.ts`
- Test: `tests/terminal-progress.test.ts`

**Interfaces:**
- Produces: `createTerminalProgress(options).begin(): () => void`

- [ ] Write tests for start/clear bytes, nesting, idempotence, TTY gates, and environment overrides.
- [ ] Run `bun test tests/terminal-progress.test.ts`; confirm missing-module failure.
- [ ] Implement controller with process-wide-compatible reference counting.
- [ ] Run focused test; confirm pass.

### Task 2: Headless request lifecycle integration

**Files:**
- Modify: `src/run/headless-print.ts`
- Modify: `src/run/headless-repl.ts`

**Interfaces:**
- Consumes: `beginTerminalProgress(): () => void`
- Covers: `--simple`, `--repl`, and print prompt calls.

- [ ] Begin before IPC prompt send and stop once on result, error, cancellation, shutdown, or send exception.
- [ ] Keep OSC progress out of the full-screen TUI and TUI subagents.
- [ ] Run focused tests and full available verification.
