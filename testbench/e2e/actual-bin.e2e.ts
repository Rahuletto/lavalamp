import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'bun:test';
import { createLavalampE2EHarness } from './e2e-harness.ts';

describe('real bin/lavalamp e2e', () => {
  test('boots once through auth and handles persistent TUI slash flows', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'lavalamp-e2e-workspace-'));
    const app = createLavalampE2EHarness({ workspace });

    try {
      await app.start();
      await app.waitForText('[lavalamp] Authenticating...', 10000);
      await app.waitForText(
        '[lavalamp] Authentication complete. Opening TUI...',
        150000,
      );
      await app.waitForBoot();

      await app.submitSlash('/help');
      await app.waitForText('Commands:');
      await app.waitForText('/model');

      await app.submitSlash('/workspace');
      await app.waitForText(`workspace: ${workspace}`);

      await app.submitSlash('/model');
      await app.waitForText('available models:');
      await app.pressArrow('down');
      await app.pressEscape();

      await app.submitSlash('/plan');
      await app.waitForText('lavalamp [PLAN]');

      await app.submitSlash('/subagents');
      await app.waitForText('no subagents');

      expect(app.cleanOutput()).toContain('lavalamp');
    } finally {
      await app.stop();
      await rm(workspace, { force: true, recursive: true });
    }
  }, 180000);
});
