import { describe, expect, test } from 'bun:test';
import { createTuiLifetime, formatExitSummary } from '../src/tui/lifecycle.ts';
import { LAVA_LAMP_FRAMES } from '../src/tui/lava-art.ts';

describe('TUI lifecycle', () => {
  test('keeps interactive startup alive until renderer destroy', async () => {
    const lifetime = createTuiLifetime();
    let resolved = false;
    lifetime.finished.then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    lifetime.markDestroyed();
    await lifetime.finished;
    expect(resolved).toBe(true);
  });

  test('formats exit summary with lava art and continue command', () => {
    const summary = formatExitSummary('session_123');
    const firstArtLine = LAVA_LAMP_FRAMES[0]?.[0] ?? '';

    expect(summary).toContain(firstArtLine);
    expect(summary).toContain('session:');
    expect(summary).toContain('session_123');
    expect(summary).toContain('continue:');
    expect(summary).toContain('lavalamp --continue session_123');
  });
});
