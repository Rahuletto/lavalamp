import { describe, expect, test } from 'bun:test';
import { SLASH_COMMANDS } from '../src/tui/slash-data.ts';
import { createPreparedHarness } from './test-utils.tsx';

const slashOutputCases: [string, string[]][] = [
  ['/help', ['Commands:', '/paste-image', 'Shift+Tab / Ctrl+P']],
  ['/clear', ['new session started']],
  ['/sessions', ['no saved sessions']],
  ['/compact', ['compacted:', 'kept last']],
  ['/memory', ['AGENTS.md:', '# Bench Memory']],
  ['/model', ['model:', 'available models:']],
  ['/models', ['model:', 'available models:']],
  ['/gateway', ['gateway:', 'use /gateway <id>']],
  ['/usage', ['neuron meter', 'total:', 'input:', 'cache read:']],
  ['/workspace', ['WORKSPACE']],
  ['/skills', ['skills:', '#example']],
  ['/mcp', ['no MCP config found']],
  ['/tools', ['registered tools:', 'write', 'edit']],
  ['/subagents', ['no subagents']],
  ['/sudo', ['Sudo Mode', 'allow every tool']],
  ['/permissions', ['rules from .agents/rules.json', 'allow', 'ask']],
  ['/plan', ['plan mode: on']],
  ['/copy', ['session copied to clipboard']],
  ['/undo', ['removed last 2 messages']],
  ['/paste-image', ['No image found in clipboard']],
  ['/quit', ['exit requested']],
];

describe('slash command output contracts', () => {
  test('cases cover every registered slash command', () => {
    expect(slashOutputCases.map(([command]) => command).toSorted()).toEqual(
      SLASH_COMMANDS.map(([command]) => command).toSorted(),
    );
  });

  for (const [command, expectedLines] of slashOutputCases) {
    test(command, async () => {
      const { harness, workspace } = await createPreparedHarness();
      const result = await harness.run(command);
      expect(result.title).toBe(command);
      const output = result.lines.join('\n');
      for (const expected of expectedLines) {
        expect(output).toContain(
          expected === 'WORKSPACE' ? `workspace: ${workspace}` : expected,
        );
      }
    });
  }
});
