import * as v from 'valibot';
import { defineTool } from '@flue/runtime';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

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
    description:
      "Delegate a specialized task to a domain expert agent (ui, refactor, logic, database, oracle, research, critique, spectacle). Spectacle is the vision expert that can describe screenshots/images. Returns the expert's response.",
    execute: async ({ expert, prompt }) => 
      new Promise<string>((resolve, reject) => {
        const instanceId = `expert_${randomUUID().slice(0, 8)}`;
        const child = spawn(process.execPath, [serverPath], {
          cwd: workspaceRoot,
          env: {
            FLUE_CLI_ID: instanceId,
            FLUE_CLI_NAME: expert,
            FLUE_CLI_TARGET: 'agent',
            FLUE_INTERNAL_CLI_IPC: '1',
            FLUE_MODE: 'local',
            HOME: process.env.HOME,
            NODE_ENV: process.env.NODE_ENV,
            PATH: process.env.PATH,
          },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });

        let outputText = '';
        const requestId = `req_${randomUUID()}`;

        const onMessage = (raw: Record<string, unknown>) => {
          if (raw.type === 'ready' && raw.instanceId === instanceId) {
            // Send the prompt once child is ready
            child.send({
              message: prompt,
              requestId,
              type: 'prompt',
            });
            return;
          }

          if (raw.requestId !== requestId) {return;}

          if (raw.type === 'event' && raw.event !== null && raw.event !== undefined && typeof raw.event === 'object' && (raw.event as Record<string, unknown>).type === 'text_delta') {
            const evt = raw.event as Record<string, unknown>;
            const text = typeof evt.text === 'string' ? evt.text : (typeof evt.delta === 'string' ? evt.delta : '');
            outputText += text ?? '';
          }

          if (raw.type === 'result') {
            cleanup();
            resolve(outputText.trim());
          }

          if (raw.type === 'error') {
            cleanup();
            const errObj = raw.error !== null && raw.error !== undefined && typeof raw.error === 'object' ? raw.error as Record<string, unknown> : null;
            const msg = errObj !== null && typeof errObj.message === 'string' ? errObj.message : 'Expert session failed';
            reject(new Error(msg));
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
      })
    ,
    name: 'query_expert',
    parameters: queryExpertSchema,
  });
}
