import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { act } from 'react';
import {
  createDriverForWorkspace,
  makeWorkspace,
  submitText,
} from './test-utils.tsx';
import { BUILD_MODEL, listModels } from '../src/config/models.ts';

describe('OpenTUI bench flows', () => {
  test('help renders command list', async () => {
    const workspace = makeWorkspace();
    const driver = await createDriverForWorkspace(workspace, {
      width: 100,
      height: 80,
    });
    await submitText(driver, '/help');
    await driver.waitForText('/gateway', { timeout: 1000 });
    await driver.close();
  });

  test('prompt creates a file', async () => {
    const workspace = makeWorkspace();
    const driver = await createDriverForWorkspace(workspace, {
      width: 100,
      height: 80,
    });
    await submitText(driver, 'create note.txt with hello bench');
    await driver.waitForText('created note.txt', { timeout: 1000 });
    expect(readFileSync(join(workspace, 'note.txt'), 'utf8')).toBe(
      'hello bench\n',
    );
    await driver.close();
  });

  test('prompt edits a file', async () => {
    const workspace = makeWorkspace();
    await writeFile(join(workspace, 'note.txt'), 'hello bench\n');
    const driver = await createDriverForWorkspace(workspace, {
      width: 100,
      height: 80,
    });
    await submitText(driver, 'edit note.txt to hello edited');
    await driver.waitForText('edited note.txt', { timeout: 1000 });
    expect(readFileSync(join(workspace, 'note.txt'), 'utf8')).toBe(
      'hello edited\n',
    );
    await driver.close();
  });

  test('prompt deletes a file', async () => {
    const workspace = makeWorkspace();
    await writeFile(join(workspace, 'note.txt'), 'hello edited\n');
    const driver = await createDriverForWorkspace(workspace, {
      width: 100,
      height: 80,
    });
    await submitText(driver, 'delete note.txt');
    await driver.waitForText('deleted note.txt', { timeout: 1000 });
    expect(await Bun.file(join(workspace, 'note.txt')).exists()).toBe(false);
    await driver.close();
  });

  test('model switches to a valid model', async () => {
    const workspace = makeWorkspace();
    const driver = await createDriverForWorkspace(workspace, {
      width: 120,
      height: 34,
    });
    await submitText(driver, '/model anthropic/claude-sonnet-4-20250514');
    await driver.waitForText(
      'model set: anthropic/claude-sonnet-4-20250514',
      {
        timeout: 1000,
      },
    );
    await driver.close();
  });

  test('model picker switches with arrow keys and enter', async () => {
    const models = listModels();
    const currentIndex = models.findIndex((model) => model.id === BUILD_MODEL);
    const next = models[currentIndex + 1];
    expect(next).toBeDefined();

    const workspace = makeWorkspace();
    const driver = await createDriverForWorkspace(workspace, {
      width: 140,
      height: 38,
    });
    await submitText(driver, '/model');
    await act(async () => {
      await driver.pressArrow('down');
    });
    await act(async () => {
      await driver.pressEnter();
    });
    await driver.waitForText(`model set: ${next?.id}`, {
      timeout: 1000,
    });
    await driver.close();
  });

  test('invalid model shows an error', async () => {
    const workspace = makeWorkspace();
    const driver = await createDriverForWorkspace(workspace, {
      width: 120,
      height: 34,
    });
    await submitText(driver, '/model nope');
    await driver.waitForText('unknown model: nope', { timeout: 1000 });
    await driver.close();
  });

  test('gateway enables with id', async () => {
    const workspace = makeWorkspace();
    const driver = await createDriverForWorkspace(workspace, {
      width: 120,
      height: 34,
    });
    await submitText(driver, '/gateway team-gateway');
    await driver.waitForText('AI Gateway enabled: team-gateway', {
      timeout: 1000,
    });
    await driver.close();
  });

  test('gateway off disables gateway', async () => {
    const workspace = makeWorkspace();
    const driver = await createDriverForWorkspace(workspace, {
      width: 120,
      height: 34,
    });
    await submitText(driver, '/gateway off');
    await driver.waitForText('AI Gateway disabled', { timeout: 1000 });
    await driver.close();
  });

  test('plan toggles on', async () => {
    const workspace = makeWorkspace();
    const driver = await createDriverForWorkspace(workspace, {
      width: 120,
      height: 34,
    });
    await submitText(driver, '/plan');
    await driver.waitForText('plan mode: on', { timeout: 1000 });
    await driver.close();
  });

  test('plan toggles off', async () => {
    const workspace = makeWorkspace();
    const driver = await createDriverForWorkspace(workspace, {
      width: 120,
      height: 34,
    });
    await submitText(driver, '/plan');
    await submitText(driver, '/plan');
    await driver.waitForText('plan mode: off', { timeout: 1000 });
    await driver.close();
  });

  test('slash command output replaces the current panel', async () => {
    const workspace = makeWorkspace();
    const driver = await createDriverForWorkspace(workspace);
    await submitText(driver, '/workspace');
    await driver.waitForText(`workspace: ${workspace}`, { timeout: 1000 });

    await submitText(driver, '/usage');
    await driver.waitForText('neuron meter', { timeout: 1000 });

    const frame = await driver.capture();
    expect(frame).toContain('neuron meter');
    expect(frame).not.toContain('> /workspace');
    expect(frame).not.toContain(`workspace: ${workspace}`);
    await driver.close();
  });
});
