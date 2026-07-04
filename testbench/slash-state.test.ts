import { describe, expect, test } from 'bun:test';
import { createSeededHarness } from './test-utils.tsx';

describe('slash command state changes', () => {
  test('model switches to a valid model', async () => {
    const { harness } = createSeededHarness();
    await harness.run('/model anthropic/claude-sonnet-4-20250514');
    expect(harness.state().model).toBe('anthropic/claude-sonnet-4-20250514');
  });

  test('invalid model leaves current model unchanged', async () => {
    const { harness } = createSeededHarness();
    await harness.run('/model anthropic/claude-sonnet-4-20250514');
    expect((await harness.run('/model nope')).lines.join('\n')).toContain(
      'unknown model: nope',
    );
    expect(harness.state().model).toBe('anthropic/claude-sonnet-4-20250514');
  });

  test('gateway enables with id', async () => {
    const { harness } = createSeededHarness();
    await harness.run('/gateway team-gateway');
    expect(harness.state()).toMatchObject({
      gatewayEnabled: true,
      gatewayId: 'team-gateway',
    });
  });

  test('gateway off disables without erasing id', async () => {
    const { harness } = createSeededHarness();
    await harness.run('/gateway team-gateway');
    await harness.run('/gateway off');
    expect(harness.state()).toMatchObject({
      gatewayEnabled: false,
      gatewayId: 'team-gateway',
    });
  });

  test('plan toggles on', async () => {
    const { harness } = createSeededHarness();
    await harness.run('/plan');
    expect(harness.state().planMode).toBe(true);
  });

  test('plan toggles off', async () => {
    const { harness } = createSeededHarness();
    await harness.run('/plan');
    await harness.run('/plan');
    expect(harness.state().planMode).toBe(false);
  });

  test('compact keeps the back half of messages', async () => {
    const { harness } = createSeededHarness();
    await harness.run('/compact');
    expect(harness.state().messages.map((message) => message.content)).toEqual([
      'three',
      'four',
    ]);
  });

  test('undo removes the last prompt/response pair', async () => {
    const { harness } = createSeededHarness();
    await harness.run('/undo');
    expect(harness.state().messages.map((message) => message.content)).toEqual([
      'one',
      'two',
    ]);
  });

  test('sudo enables allow-all', async () => {
    const { harness } = createSeededHarness();
    await harness.run('/sudo');
    expect(harness.state().allowAll).toBe(true);
  });

  test('sudo toggles allow-all off', async () => {
    const { harness } = createSeededHarness();
    await harness.run('/sudo');
    await harness.run('/sudo');
    expect(harness.state().allowAll).toBe(false);
  });

  test('clear empties messages and saves a session', async () => {
    const { harness } = createSeededHarness();
    harness.seedMessages([{ role: 'user', content: 'fresh' }]);
    await harness.run('/clear');
    expect(harness.state().messages).toEqual([]);
    expect(harness.state().savedSessions).toHaveLength(1);
  });

  test('quit marks exit requested', async () => {
    const { harness } = createSeededHarness();
    await harness.run('/quit');
    expect(harness.state().exitRequested).toBe(true);
  });
});
