import { describe, expect, test } from 'bun:test';
import { createDriver } from '@nigel-dev/opentui-test';
import React, { act, useState, type ReactNode } from 'react';
import { SLASH_COMMANDS } from '../src/tui/slash-data.ts';
import { orderedInputStack } from '../src/tui/input-stack.ts';

function frameRows(frame: string): string[] {
  return frame.split('\n');
}

function rowIndex(rows: string[], predicate: (row: string) => boolean): number {
  const index = rows.findIndex(predicate);
  if (index < 0) {
    throw new Error(
      rows.map((row, rowIndex) => `${rowIndex}: ${row}`).join('\n'),
    );
  }
  return index;
}

function SlashCompletionLayoutBench() {
  const [input, setInput] = useState('');
  const completion =
    input.startsWith('/') ? (
      <box
        key="completion"
        border
        borderStyle="single"
        flexDirection="column"
        maxHeight={10}
        width="100%"
      >
        {SLASH_COMMANDS.slice(0, 8).map(([name, description]) => (
          <box key={name} flexDirection="row" height={1} width="100%">
            <text width={24}>{name}</text>
            <text>{description.toLowerCase()}</text>
          </box>
        ))}
      </box>
    ) : null;
  const stack = orderedInputStack<ReactNode>({
    completionBox: completion,
    confirmBox: null,
    inputRow: (
      <box key="input" flexDirection="row" height={1} width="100%">
        <text width={2}>┃</text>
        <input
          focused
          placeholder="Type your message..."
          value={input}
          onChange={setInput}
          onInput={setInput}
        />
      </box>
    ),
    inputSeparatorTop: (
      <text key="top-separator">{'─'.repeat(120)}</text>
    ),
    permissionBox: null,
  });

  return (
    <box flexDirection="column" height="100%" width="100%">
      <box flexGrow={1} width="100%">
        <text>message area</text>
      </box>
      <box flexDirection="column" height={3} width="100%">
        <text>
          {['/subagents', 'no subagents'].join('\n')}
        </text>
      </box>
      {stack}
      <text>{'─'.repeat(120)}</text>
      <box height={1} width="100%">
        <text>~/Documents/Coding/lavalamp</text>
      </box>
    </box>
  );
}

describe('completion layout frame', () => {
  test('slash completion renders adjacent to the input in a tall viewport', async () => {
    const driver = await createDriver({
      app: <SlashCompletionLayoutBench />,
      height: 42,
      width: 120,
    });
    await driver.launch();
    await act(async () => {
      await driver.typeText('/');
    });

    const rows = frameRows(await driver.capture());
    const helpRow = rowIndex(rows, (row) => row.includes('/help'));
    const inputRow = rowIndex(rows, (row) => row.includes('┃'));

    expect(helpRow).toBeGreaterThan(20);
    expect(inputRow - helpRow).toBeGreaterThan(0);
    expect(inputRow - helpRow).toBeLessThanOrEqual(12);

    await driver.close();
  });
});
