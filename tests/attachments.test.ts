import { describe, expect, test } from 'bun:test';
import { attachmentsForPrompt } from '../src/tui/attachments';

describe('prompt attachments', () => {
  test('ignores stale attachments whose tag is absent from the prompt', () => {
    const attachments = [
      { path: '/tmp/old.png', tag: '[Image 1]' },
    ];

    expect(attachmentsForPrompt('yo', attachments)).toEqual([]);
  });

  test('keeps only attachments explicitly referenced by the prompt', () => {
    const attachments = [
      { path: '/tmp/first.png', tag: '[Image 1]' },
      { path: '/tmp/second.png', tag: '[Image 2]' },
    ];

    expect(attachmentsForPrompt('check [Image 2]', attachments)).toEqual([
      { path: '/tmp/second.png', tag: '[Image 2]' },
    ]);
  });
});
