import * as v from 'valibot';
import { defineTool } from '@flue/runtime';
import { spawn } from 'child_process';
import * as path from 'path';
import { randomUUID } from 'crypto';

const queryExpertSchema = v.object({
  expert: v.union([
    v.literal('ui'),
    v.literal('refactor'),
    v.literal('logic'),
    v.literal('database'),
    v.literal('oracle'),
    v.literal('research'),
    v.literal('critique'),
    v.literal('spectacle'),
  ]),
  prompt: v.string(),
});

export function createQueryExpertTool(workspaceRoot: string) {
  // Locate dist/server.mjs
  const serverPath = path.join(workspaceRoot, 'dist', 'server.mjs');

  return defineTool({
    name: 'query_expert',
    description:
      'Delegate a specialized task to a domain expert agent (ui, refactor, logic, database, oracle, research, critique, spectacle). Spectacle is the vision expert that can describe screenshots/images. Returns the expert\'s response.',
    parameters: queryExpertSchema,
    execute: async ({ expert, prompt }) => {
      return new Promise<string>((resolve, reject) => {
        const instanceId = `expert_${randomUUID().slice(0, 8)}`;
        const child = spawn(process.execPath, [serverPath], {
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          cwd: workspaceRoot,
          env: {
            ...process.env,
            FLUE_MODE: 'local',
            FLUE_INTERNAL_CLI_IPC: '1',
            FLUE_CLI_TARGET: 'agent',
            FLUE_CLI_NAME: expert,
            FLUE_CLI_ID: instanceId,
          },
        });

        let outputText = '';
        const requestId = `req_${randomUUID()}`;

        const onMessage = (raw: any) => {
          if (raw.type === 'ready' && raw.instanceId === instanceId) {
            // Send the prompt once child is ready
            child.send({
              type: 'prompt',
              requestId,
              message: prompt,
            });
            return;
          }

          if (raw.requestId !== requestId) return;

          if (raw.type === 'event' && raw.event?.type === 'text_delta') {
            outputText += raw.event.text ?? raw.event.delta ?? '';
          }

          if (raw.type === 'result') {
            cleanup();
            resolve(outputText.trim());
          }

          if (raw.type === 'error') {
            cleanup();
            reject(new Error(raw.error?.message ?? 'Expert session failed'));
          }
        };

        const onExit = (code: number | null) => {
          cleanup();
          resolve(outputText.trim() || `Expert exited with code ${code}`);
        };

        const cleanup = () => {
          child.off('message', onMessage);
          child.off('exit', onExit);
          child.kill('SIGTERM');
        };

        child.on('message', onMessage);
        child.on('exit', onExit);
      });
    },
  });
}
