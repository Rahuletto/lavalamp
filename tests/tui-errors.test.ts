import { describe, expect, test } from 'bun:test';
import { formatTuiError } from '../src/tui/errors';

describe('TUI errors', () => {
  test('explains provider rate limits without leaking request internals', () => {
    const error = new Error(
      'direct(e1e7cf5b-3175-4781-927e-5126e05e3de9) failed: 429 status code (no body)',
    );

    expect(formatTuiError(error)).toBe(
      'model provider rate limit reached (429); wait for cooldown and retry',
    );
  });

  test('keeps the first line of ordinary errors', () => {
    expect(formatTuiError(new Error('broken\nstack details'))).toBe('broken');
  });
});
