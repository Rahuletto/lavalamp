import { describe, expect, test } from 'bun:test';
import { INPUT_STACK_ORDER, orderedInputStack } from '../src/tui/input-stack.ts';

describe('TUI input stack layout', () => {
  test('completion is mounted directly above the input separator and row', () => {
    expect(INPUT_STACK_ORDER).toEqual([
      'confirmBox',
      'permissionBox',
      'completionBox',
      'inputSeparatorTop',
      'inputRow',
    ]);
  });

  test('ordered input stack returns completion adjacent to the input row', () => {
    const stack = orderedInputStack({
      completionBox: 'completion',
      confirmBox: 'confirm',
      inputRow: 'input',
      inputSeparatorTop: 'separator',
      permissionBox: 'permission',
    });

    expect(stack).toEqual([
      'confirm',
      'permission',
      'completion',
      'separator',
      'input',
    ]);
  });
});
